// Import the startWorker function from the worker module.
import { startComfyWorker } from "./comfyWorker";

// Import the Zod library for schema validation.
import { z } from "zod";

// Define the schema for environment variables using Zod.
const envVariables = z.object({
  REDIS_URL: z.string(),
  WORKER_DB: z.string(),
  MINIO_HOST: z.string(),
  MINIO_PORT: z.string(),
  MINIO_SSL: z.enum(["true", "false"]),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
});

// Extend the NodeJS.ProcessEnv interface to include the validated environment variables.
declare global {
  namespace NodeJS {
    // The ProcessEnv interface now includes the types inferred from the envVariables schema.
    interface ProcessEnv extends z.infer<typeof envVariables> {}
  }
}

// Parse and validate the process environment variables against the defined schema.
const env = envVariables.parse(process.env);

// Log the validated environment variables to the console.
console.log(env);

// Start the worker using the imported startWorker function.
startComfyWorker();