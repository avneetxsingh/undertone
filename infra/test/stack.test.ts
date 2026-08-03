import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { UndertoneStack } from "../lib/undertone-stack";

describe("UndertoneStack", () => {
  const template = Template.fromStack(new UndertoneStack(new App(), "Test"));

  test("one on-demand table with GSI1", () => {
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      GlobalSecondaryIndexes: [{ IndexName: "GSI1" }],
    });
  });
  test("private audio bucket", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true },
    });
  });
  test("thirteen API routes", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Route", 13);
  });
  test("a KMS key exists for groq keys", () => {
    expect(Object.keys(template.findResources("AWS::KMS::Key")).length).toBe(1);
  });

  test("exact set of thirteen route keys (no duplicates, no missing paths)", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes).map(
      (r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey,
    );
    expect([...routeKeys].sort()).toEqual(
      [
        "POST /v1/sessions",
        "GET /v1/sessions",
        "GET /v1/sessions/{id}",
        "POST /v1/sessions/{id}/end",
        "POST /v1/sessions/{id}/chunks",
        "PUT /v1/account/groq-key",
        "GET /v1/search",
        "POST /v1/chat",
        "POST /v1/webhooks",
        "GET /v1/webhooks",
        "GET /v1/webhooks/{id}",
        "PATCH /v1/webhooks/{id}",
        "DELETE /v1/webhooks/{id}",
      ].sort(),
    );
  });

  test("table key schema is PK (HASH) + SK (RANGE), both string; GSI1 hashes on GSI1PK", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ]),
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [{ AttributeName: "GSI1PK", KeyType: "HASH" }],
        }),
      ],
    });
  });

  test("GSI1 projects ALL attributes (auth reads groqKeyEnc off the projected item)", () => {
    const tables = template.findResources("AWS::DynamoDB::Table");
    const gsis = Object.values(tables)[0].Properties.GlobalSecondaryIndexes as Array<{
      Projection: { ProjectionType: string };
    }>;
    expect(gsis[0].Projection.ProjectionType).toBe("ALL");
  });

  test("audio bucket blocks all four public access vectors", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("IAM least privilege: S3 put, KMS encrypt/decrypt grants are scoped to the right handlers only", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const statementsByPolicy = Object.values(policies).map(
      (p) =>
        (p as { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }).Properties
          .PolicyDocument.Statement,
    );

    const actionsFor = (statements: Array<{ Action: string | string[] }>) =>
      statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

    const policiesContaining = (action: string) =>
      statementsByPolicy.filter((statements) => actionsFor(statements).includes(action));

    // postChunk is the only handler that writes audio chunks to S3.
    expect(policiesContaining("s3:PutObject")).toHaveLength(1);
    // putGroqKey encrypts the stored Groq key; postWebhook and patchWebhook
    // encrypt webhook signing secrets.
    expect(policiesContaining("kms:Encrypt")).toHaveLength(3);
    // postChunk (to read a decrypted key when calling Groq), endSession (to decrypt
    // for the final Groq call), chat (to decrypt for its own Groq call), and
    // webhookSender (to decrypt a signing secret per delivery).
    expect(policiesContaining("kms:Decrypt")).toHaveLength(4);
  });

  test("embed and webhook queues each have a dlq redrive", () => {
    template.resourceCountIs("AWS::SQS::Queue", 4);
    const queues = template.findResources("AWS::SQS::Queue");
    const redrives = Object.values(queues).filter(
      (q) => (q as { Properties?: { RedrivePolicy?: unknown } }).Properties?.RedrivePolicy,
    );
    expect(redrives.length).toBe(2);
    for (const r of redrives)
      expect(
        (r as { Properties: { RedrivePolicy: { maxReceiveCount: number } } }).Properties.RedrivePolicy
          .maxReceiveCount,
      ).toBe(3);
  });

  test("webhook dlq has a cloudwatch alarm on message count", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "AWS/SQS",
      MetricName: "ApproximateNumberOfMessagesVisible",
    });
  });

  test("producers can send to the webhook queue", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const withSend = Object.values(policies).filter((p) => JSON.stringify(p).includes("sqs:SendMessage"));
    // embed send (postChunk) + webhook send (createSession, postChunk, endSession)
    expect(withSend.length).toBeGreaterThanOrEqual(3);
  });

  test("thirteen API routes including search, chat and webhooks", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const keys = Object.values(routes)
      .map((r) => (r as { Properties: { RouteKey: string } }).Properties.RouteKey)
      .sort();
    expect(keys).toContain("GET /v1/search");
    expect(keys).toContain("POST /v1/chat");
    expect(keys).toContain("POST /v1/webhooks");
    expect(keys).toContain("PATCH /v1/webhooks/{id}");
    expect(keys.length).toBe(13);
  });

  test("cors is configured on the http api", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: { AllowHeaders: ["authorization", "content-type"], AllowOrigins: ["*"] },
    });
  });

  test("no Bedrock IAM grants remain (embeddings run through Gemini's HTTPS API)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const withBedrock = Object.values(policies).filter((p) => JSON.stringify(p).includes("bedrock:"));
    expect(withBedrock.length).toBe(0);
  });

  test("vector index dimension matches the Gemini embedding output (768)", () => {
    template.hasResourceProperties("AWS::S3Vectors::Index", { Dimension: 768 });
  });
});
