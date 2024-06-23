import { startWorker } from "./worker";
import { z } from "zod";

const envVariables = z.object({
  REDIS_URL: z.string(),
  WORKER_DB: z.string(),
  MINIO_HOST: z.string(),
  MINIO_PORT: z.string(),
  MINIO_SSL: z.enum(["true", "false"]),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
});

declare global {
  namespace NodeJS {
    interface ProcessEnv extends z.infer<typeof envVariables> {}
  }
}

const env = envVariables.parse(process.env);
console.log(env);

startWorker();
