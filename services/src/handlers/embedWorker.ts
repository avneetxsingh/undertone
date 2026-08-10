import type { SQSEvent } from "aws-lambda";
import { embedText } from "../lib/embeddings";
import { putChunkVector } from "../lib/vectors";

interface EmbedJob {
  acctId: string;
  sessId: string;
  seq: number;
  transcript: string;
  createdAt: string;
}

export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    const job = JSON.parse(record.body) as EmbedJob;
    const embedding = await embedText(job.transcript);
    await putChunkVector(embedding, {
      acctId: job.acctId,
      sessId: job.sessId,
      seq: job.seq,
      text: job.transcript,
      createdAt: job.createdAt,
    });
  }
};
