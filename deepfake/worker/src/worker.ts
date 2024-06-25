// Import necessary functions and modules for file system operations, path handling, and process management.
import { ensureDirSync, existsSync, rm, unlinkSync } from "fs-extra";
import { Queue, Worker } from "bullmq"; // Import BullMQ for job queues.
import { join, resolve } from "path"; // Import path functions to handle file and directory paths.
import { processRoop } from "./roop"; // Import the processRoop function for deepfake processing.
import FFmpegCommand from "fluent-ffmpeg"; // Import FFmpeg for media processing.
import { extension } from "mime-types"; // Import mime-types to handle MIME types.
import * as Minio from "minio"; // Import Minio for object storage operations.
import { Redis } from "ioredis"; // Import ioredis for Redis operations.
import { z } from "zod"; // Import Zod for schema validation.

// Define the temporary directory path for storing intermediate files.
const TEMP_DIR = resolve("./temp/");

// Define the input type for deepfake job data.
export type DeepfakeJobInput = {
  userId: string;
  millisLimit: number;
  lastPolledAt: number;
  maxIdleMillis: number;
  source: string; // Source file path (image).
  target: string; // Target file path (image/video).
  output: string; // Output file path (image/video).
};

// Define the output type for deepfake job results.
export type DeepfakeJobOutput =
  | { success: false; error: string }
  | { success: true };

// Create a Minio client to interact with the object storage service.
const minio = new Minio.Client({
  endPoint: process.env.MINIO_HOST!,
  port: parseInt(process.env.MINIO_PORT!),
  useSSL: process.env.MINIO_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});

// Define constants for the deepfake job queue and storage bucket names.
const DEEPFAKE_QUEUE = "deepfake_worker";
const DEEPFAKE_BUCKET = "deepfake";

// Function to start the deepfake processing worker.
export async function startWorker() {
  // Check if the temporary directory exists, and remove it if it does, then recreate it.
  if (existsSync(TEMP_DIR)) {
    rm(TEMP_DIR, { recursive: true, force: true }, () => {
      ensureDirSync(TEMP_DIR);
    });
  } else {
    ensureDirSync(TEMP_DIR);
  }

  // Create a new job queue for deepfake processing jobs.
  const queue = new Queue(DEEPFAKE_QUEUE, {
    connection: new Redis(process.env.REDIS_URL!, {
      db: parseInt(process.env.WORKER_DB!),
      maxRetriesPerRequest: null,
      retryStrategy: () => 3000,
    }),
  });

  // Clear the queue to remove any existing jobs.
  await queue.drain(true);

  // Create a new worker to process jobs from the deepfake queue.
  const worker = new Worker<DeepfakeJobInput, DeepfakeJobOutput>(
    DEEPFAKE_QUEUE,
    async (job) => {
      console.log("job received:", { id: job.id });

      // Check if the job has been idle for too long.
      const idleDiff = Date.now() - job.data.lastPolledAt;
      if (idleDiff > job.data.maxIdleMillis) {
        console.log("skipping for not being polled in", idleDiff, "ms");
        return { success: false, error: "Job skipped for lack of polling" };
      }

      console.log("downloading inputs..");
      const downloadStart = Date.now();

      try {
        // Download the target file from the Minio storage.
        const targetStat = await minio.statObject(DEEPFAKE_BUCKET, job.data.target); // prettier-ignore
        const targetMime = targetStat.metaData["content-type"] as string;
        const targetFile = `${job.data.target}.${extension(targetMime)}`; // prettier-ignore
        const targetPath = join(TEMP_DIR, targetFile);
        await minio.fGetObject(DEEPFAKE_BUCKET, job.data.target, targetPath);

        // If the target file is a video, check its duration.
        if (targetMime.startsWith("video/")) {
          const probe = await new Promise<z.infer<typeof ffprobeSchema>>(
            (resolve, reject) => {
              FFmpegCommand()
                .addInput(targetPath)
                .ffprobe((err, data) => {
                  if (err) {
                    console.error(err);
                    return reject("ffprobe error (1/2)");
                  }

                  try {
                    resolve(ffprobeSchema.parse(data));
                  } catch (err) {
                    console.error(err);
                    reject("ffprobe error (2/2)");
                  }
                });
            }
          );

          // Check if the video duration exceeds the allowed limit.
          if (probe.format.duration * 1000 > job.data.millisLimit) {
            return {
              success: false,
              error: `Target video too long (${Math.round(
                job.data.millisLimit / 1000
              )}s max)`,
            };
          }
        }

        // Download the source file from the Minio storage.
        const sourceStat = await minio.statObject(DEEPFAKE_BUCKET, job.data.source); // prettier-ignore
        const sourceFile = `${job.data.source}.${extension(sourceStat.metaData["content-type"])}`; // prettier-ignore
        const sourcePath = join(TEMP_DIR, sourceFile);
        await minio.fGetObject(DEEPFAKE_BUCKET, job.data.source, sourcePath);

        console.log("inputs downloading finished, elapsed:", {
          seconds: (Date.now() - downloadStart) / 1000,
        });

        console.log("processing deepfake..");
        const deepfakeStart = Date.now();

        let result: DeepfakeJobOutput = {
          success: false,
          error: "Uninitialized response",
        };

        try {
          let lastProgressUpdate = 0;

          // Process the deepfake using the processRoop function.
          const outputPath = await processRoop(
            sourcePath,
            targetPath,
            async (processedFrames, totalFrames) => {
              if (Date.now() - lastProgressUpdate < 1_000) return;
              lastProgressUpdate = Date.now();

              await job.updateProgress(Math.round(processedFrames / totalFrames * 100)); // prettier-ignore
            }
          );

          // Upload the processed output to the Minio storage.
          await minio.fPutObject(DEEPFAKE_BUCKET, job.data.output, outputPath);
          unlinkSync(outputPath);
          result = { success: true };
        } catch (err) {
          console.error(err);

          if (String(err).includes("Deepfake processing timed out")) {
            result = {
              success: false,
              error: "Deepfake processing timed out",
            };
          } else {
            result = {
              success: false,
              error: "Processing failed, face might not be detected in one of your inputs",
            };
          }
        }

        // Clean up the temporary files.
        unlinkSync(sourcePath);
        unlinkSync(targetPath);

        // Remove the source and target files from the Minio storage.
        await Promise.allSettled([
          minio.removeObject(DEEPFAKE_BUCKET, job.data.source),
          minio.removeObject(DEEPFAKE_BUCKET, job.data.target),
        ]);

        console.log(
          "deepfake processed in",
          (Date.now() - deepfakeStart) / 1000,
          "seconds"
        );

        return result;
      } catch (err) {
        console.error("worker error:", err);
        return { success: false, error: "Unexpected worker error" };
      }
    },
    {
      concurrency: 1, // Set the worker to process one job at a time.
      connection: new Redis(process.env.REDIS_URL!, {
        db: parseInt(process.env.WORKER_DB!),
        maxRetriesPerRequest: null,
        retryStrategy: () => 3000,
      }),
    }
  );

  console.log("running deepfake worker:", { id: worker.id });
}

// Define a Zod schema for FFmpeg probe output validation.
const ffprobeSchema = z.object({ format: z.object({ duration: z.number() }) });
