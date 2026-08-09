import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface UndertoneStackProps extends StackProps {
  stage?: string;
}

export class UndertoneStack extends Stack {
  constructor(scope: Construct, id: string, props?: UndertoneStackProps) {
    super(scope, id, props);
    const stage = props?.stage ?? "dev";

    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // dev stack; prod stage flips to RETAIN
      // Sweeps the two item types that are meant to expire — replayable events
      // and per-minute rate counters. Sessions and chunks never set expiresAt,
      // so they are untouched.
      timeToLiveAttribute: "expiresAt",
    });
    // Sparse GSI: only account items carry GSI1PK, so this index stays tiny.
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
    });

    const audio = new s3.Bucket(this, "Audio", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const groqKms = new kms.Key(this, "GroqKeyKms", { description: "Encrypts stored Groq API keys" });

    const vectorBucketName = `undertone-${stage}-vectors`;
    // Named "chunks-768" (was "chunks" at 1024-dim Bedrock Titan). S3 Vectors index
    // dimension is immutable and the name is fixed, so switching to Gemini's 768-dim
    // output requires a new index name — CloudFormation then deletes the old one.
    const vectorIndexName = "chunks-768";
    const vb = new s3vectors.CfnVectorBucket(this, "VectorBucket", { vectorBucketName });
    const vidx = new s3vectors.CfnIndex(this, "VectorIndex", {
      vectorBucketName,
      indexName: vectorIndexName,
      dataType: "float32",
      dimension: 768,
      distanceMetric: "cosine",
      metadataConfiguration: { nonFilterableMetadataKeys: ["text"] },
    });
    vidx.addDependency(vb);

    const dlq = new sqs.Queue(this, "EmbedDlq", { retentionPeriod: Duration.days(14) });
    const embedQueue = new sqs.Queue(this, "EmbedQueue", {
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    const webhookDlq = new sqs.Queue(this, "WebhookDlq", { retentionPeriod: Duration.days(14) });
    const webhookQueue = new sqs.Queue(this, "WebhookQueue", {
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: webhookDlq, maxReceiveCount: 3 },
    });

    const makeFn = (name: string, entry: string, timeoutSeconds = 10) =>
      new NodejsFunction(this, name, {
        entry: path.join(here, `../../services/src/handlers/${entry}.ts`),
        runtime: Runtime.NODEJS_22_X,
        timeout: Duration.seconds(timeoutSeconds),
        memorySize: 512,
        environment: {
          TABLE_NAME: table.tableName,
          BUCKET_NAME: audio.bucketName,
          KMS_KEY_ID: groqKms.keyId,
          KEY_PEPPER: process.env.UNDERTONE_PEPPER ?? "dev-pepper-change-me",
          VECTOR_BUCKET: vectorBucketName,
          VECTOR_INDEX: vectorIndexName,
          GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "",
          // Per-account ceiling enforced inside requireAccount. Unset in unit
          // tests and local runs, which is how they stay unlimited.
          RATE_LIMIT_PER_MINUTE: process.env.RATE_LIMIT_PER_MINUTE ?? "300",
          ...(process.env.GROQ_BASE_URL ? { GROQ_BASE_URL: process.env.GROQ_BASE_URL } : {}),
        },
      });

    const createSession = makeFn("CreateSessionFn", "createSession");
    const getSession = makeFn("GetSessionFn", "getSession");
    const listSessions = makeFn("ListSessionsFn", "listSessions");
    const endSession = makeFn("EndSessionFn", "endSession", 30);
    const putGroqKey = makeFn("PutGroqKeyFn", "putGroqKey");
    const postChunk = makeFn("PostChunkFn", "postChunk", 60);
    const embedWorker = makeFn("EmbedWorkerFn", "embedWorker", 60);
    const search = makeFn("SearchFn", "search", 15);
    const chat = makeFn("ChatFn", "chat", 60);
    const postWebhook = makeFn("PostWebhookFn", "postWebhook");
    const listWebhooksFn = makeFn("ListWebhooksFn", "listWebhooks");
    const getWebhookFn = makeFn("GetWebhookFn", "getWebhook");
    const patchWebhook = makeFn("PatchWebhookFn", "patchWebhook");
    const deleteWebhookFn = makeFn("DeleteWebhookFn", "deleteWebhook");
    const webhookSender = makeFn("WebhookSenderFn", "webhookSender", 30);
    const listEventsFn = makeFn("ListEventsFn", "listEvents");
    const replayEventFn = makeFn("ReplayEventFn", "replayEvent");

    postChunk.addEnvironment("EMBED_QUEUE_URL", embedQueue.queueUrl);
    embedWorker.addEventSource(new SqsEventSource(embedQueue, { batchSize: 10 }));
    embedQueue.grantSendMessages(postChunk);

    // batchSize is deliberately small: retries are per message, so one poisoned
    // subscriber URL dead-letters on its own instead of dragging a large batch
    // through three delivery attempts with it.
    webhookSender.addEventSource(
      new SqsEventSource(webhookQueue, { batchSize: 5, reportBatchItemFailures: true }),
    );
    for (const f of [createSession, postChunk, endSession]) {
      f.addEnvironment("WEBHOOK_QUEUE_URL", webhookQueue.queueUrl);
      webhookQueue.grantSendMessages(f);
    }

    // Least privilege: everyone reads (auth GSI lookup); only mutating handlers write.
    for (const f of [createSession, getSession, listSessions, endSession, putGroqKey, postChunk]) {
      table.grantReadData(f);
    }
    for (const f of [createSession, endSession, putGroqKey, postChunk]) table.grantWriteData(f);
    audio.grantPut(postChunk);
    groqKms.grantEncrypt(putGroqKey);
    groqKms.grantDecrypt(postChunk);
    groqKms.grantDecrypt(endSession);

    // chat reads session/chunk history (auth GSI + session/chunk items) and decrypts the stored Groq key.
    table.grantReadData(chat);
    groqKms.grantDecrypt(chat);

    // search only needs the auth GSI lookup, but requireAccount runs in EVERY
    // handler — a function without table read cannot authenticate at all.
    table.grantReadData(search);

    // Webhook handlers: all read (auth + subscription lookup); only the mutating
    // ones plus the sender (which records delivery status) write.
    for (const f of [postWebhook, listWebhooksFn, getWebhookFn, patchWebhook, deleteWebhookFn, webhookSender])
      table.grantReadData(f);
    for (const f of [postWebhook, patchWebhook, deleteWebhookFn, webhookSender]) table.grantWriteData(f);
    groqKms.grantEncrypt(postWebhook);
    groqKms.grantEncrypt(patchWebhook);
    groqKms.grantDecrypt(webhookSender);

    // Event log: listing reads, replay reads and re-enqueues.
    table.grantReadData(listEventsFn);
    table.grantReadData(replayEventFn);
    replayEventFn.addEnvironment("WEBHOOK_QUEUE_URL", webhookQueue.queueUrl);
    webhookQueue.grantSendMessages(replayEventFn);

    // Every authenticated handler writes a rate counter through requireAccount,
    // so all of them need table write — including the otherwise read-only ones.
    for (const f of [getSession, listSessions, search, chat, listWebhooksFn, getWebhookFn, listEventsFn])
      table.grantWriteData(f);

    new cloudwatch.Alarm(this, "WebhookDlqAlarm", {
      metric: webhookDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "Webhook deliveries are landing in the DLQ",
    });

    // Embeddings run through Gemini's HTTPS API (see services/src/lib/embeddings.ts),
    // not a managed AWS model, so no Bedrock IAM grant is needed — the API key is
    // passed as a Lambda env var. The functions only need S3 Vectors access.
    const vectorIndexArn = `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorBucketName}/index/${vectorIndexName}`;
    embedWorker.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3vectors:PutVectors"], resources: [vectorIndexArn] }),
    );
    for (const f of [postChunk, search])
      f.addToRolePolicy(
        new iam.PolicyStatement({
          // GetVectors looks unused but is required by AWS alongside QueryVectors
          // when returnMetadata/returnDistance are set (per the SDK docs) — do not trim.
          actions: ["s3vectors:QueryVectors", "s3vectors:GetVectors"],
          resources: [vectorIndexArn],
        }),
      );

    const api = new apigwv2.HttpApi(this, "Api", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ["authorization", "content-type"],
      },
    });
    const route = (routePath: string, method: apigwv2.HttpMethod, f: NodejsFunction) =>
      api.addRoutes({
        path: routePath,
        methods: [method],
        integration: new HttpLambdaIntegration(`${f.node.id}Int`, f),
      });
    route("/v1/sessions", apigwv2.HttpMethod.POST, createSession);
    route("/v1/sessions", apigwv2.HttpMethod.GET, listSessions);
    route("/v1/sessions/{id}", apigwv2.HttpMethod.GET, getSession);
    route("/v1/sessions/{id}/end", apigwv2.HttpMethod.POST, endSession);
    route("/v1/sessions/{id}/chunks", apigwv2.HttpMethod.POST, postChunk);
    route("/v1/account/groq-key", apigwv2.HttpMethod.PUT, putGroqKey);
    route("/v1/search", apigwv2.HttpMethod.GET, search);
    route("/v1/chat", apigwv2.HttpMethod.POST, chat);
    route("/v1/webhooks", apigwv2.HttpMethod.POST, postWebhook);
    route("/v1/webhooks", apigwv2.HttpMethod.GET, listWebhooksFn);
    route("/v1/webhooks/{id}", apigwv2.HttpMethod.GET, getWebhookFn);
    route("/v1/webhooks/{id}", apigwv2.HttpMethod.PATCH, patchWebhook);
    route("/v1/webhooks/{id}", apigwv2.HttpMethod.DELETE, deleteWebhookFn);
    route("/v1/events", apigwv2.HttpMethod.GET, listEventsFn);
    route("/v1/events/{id}/replay", apigwv2.HttpMethod.POST, replayEventFn);

    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "BucketName", { value: audio.bucketName });
    new CfnOutput(this, "VectorBucketName", { value: vectorBucketName });
    new CfnOutput(this, "EmbedQueueUrl", { value: embedQueue.queueUrl });
    new CfnOutput(this, "WebhookQueueUrl", { value: webhookQueue.queueUrl });
  }
}
