import { PutVectorsCommand, QueryVectorsCommand, S3VectorsClient } from "@aws-sdk/client-s3vectors";

const client = new S3VectorsClient({});
const bucket = () => process.env.VECTOR_BUCKET!;
const index = () => process.env.VECTOR_INDEX!;

export interface ChunkVectorMeta {
  acctId: string;
  sessId: string;
  seq: number;
  text: string;
  createdAt: string;
}

export interface VectorHit {
  sessId: string;
  seq: number;
  text: string;
  createdAt: string;
  distance?: number;
}

export async function putChunkVector(embedding: number[], meta: ChunkVectorMeta): Promise<void> {
  await client.send(
    new PutVectorsCommand({
      vectorBucketName: bucket(),
      indexName: index(),
      vectors: [
        {
          key: `${meta.acctId}/${meta.sessId}/${String(meta.seq).padStart(6, "0")}`,
          data: { float32: embedding },
          metadata: {
            acctId: meta.acctId,
            sessId: meta.sessId,
            seq: meta.seq,
            createdAt: meta.createdAt,
            text: meta.text.slice(0, 1000),
          },
        },
      ],
    }),
  );
}

export async function searchVectors(
  embedding: number[],
  acctId: string,
  topK = 8,
  excludeSessId?: string,
): Promise<VectorHit[]> {
  const res = await client.send(
    new QueryVectorsCommand({
      vectorBucketName: bucket(),
      indexName: index(),
      queryVector: { float32: embedding },
      topK,
      filter: { acctId: { $eq: acctId } },
      returnMetadata: true,
      returnDistance: true,
    }),
  );
  const hits = (res.vectors ?? []).map((v) => {
    const md = (v.metadata ?? {}) as Record<string, unknown>;
    return {
      sessId: String(md.sessId ?? ""),
      seq: Number(md.seq ?? 0),
      text: String(md.text ?? ""),
      createdAt: String(md.createdAt ?? ""),
      distance: v.distance,
    };
  });
  return excludeSessId ? hits.filter((h) => h.sessId !== excludeSessId) : hits;
}
