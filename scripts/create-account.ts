import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { generateApiKey, hashApiKey } from "../services/src/lib/auth";

const name = process.argv[2] ?? "default";
const tableName = process.env.TABLE_NAME;
if (!tableName) throw new Error("Set TABLE_NAME to the deployed table name (CDK output)");
const pepper = process.env.UNDERTONE_PEPPER ?? process.env.KEY_PEPPER ?? "dev-pepper-change-me";

const apiKey = generateApiKey();
const acctId = ulid();
await DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" })).send(
  new PutCommand({
    TableName: tableName,
    Item: {
      PK: `ACCT#${acctId}`,
      SK: "META",
      acctId,
      name,
      GSI1PK: `KEYHASH#${hashApiKey(apiKey, pepper)}`,
      createdAt: new Date().toISOString(),
    },
  }),
);
console.log(`Account ${acctId} (${name}) created.`);
console.log(`API key (shown once, save it now): ${apiKey}`);
