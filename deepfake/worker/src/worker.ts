// Import necessary functions and modules for file system operations, path handling, and process management.
import { ensureDirSync, existsSync, rm, unlinkSync } from "fs-extra";
import { Queue, Worker } from "bullmq"; // Import BullMQ for job queues.
import { join, resolve } from "path"; // Import path functions to handle file and directory paths.
// import { processRoop } from "./roop"; // Import the processRoop function for deepfake processing.
import { processFacefusion } from "./facefusion";
import FFmpegCommand from "fluent-ffmpeg"; // Import FFmpeg for media proce;ssing.
import { extension } from "mime-types"; // Import mime-types to handle MIME types.
import * as Minio from "minio"; // Import Minio for object storage operations.
import { Redis } from "ioredis"; // Import ioredis for Redis operations.
import { z } from "zod"; // Import Zod for schema validation.

console.log("Starting deepfake worker script");

// Define the temporary directory path for storing intermediate files.
const TEMP_DIR = resolve("./temp/");
console.log(`Temporary directory set to: ${TEMP_DIR}`);

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
console.log("Creating Minio client");
const minio = new Minio.Client({
  endPoint: process.env.MINIO_HOST!,
  port: parseInt(process.env.MINIO_PORT!),
  useSSL: process.env.MINIO_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});
console.log("Minio client created");

// Define constants for the deepfake job queue and storage bucket names.
const DEEPFAKE_QUEUE = "deepfake_worker";
const DEEPFAKE_BUCKET = "deepfake";
console.log(`Queue name: ${DEEPFAKE_QUEUE}, Bucket name: ${DEEPFAKE_BUCKET}`);

// Function to start the deepfake processing worker.
export async function startWorker() {
  console.log("Starting worker function");
  // Check if the temporary directory exists, and remove it if it does, then recreate it.
  if (existsSync(TEMP_DIR)) {
    console.log(`Temporary directory ${TEMP_DIR} exists, removing it`);
    rm(TEMP_DIR, { recursive: true, force: true }, () => {
      console.log(`Recreating temporary directory ${TEMP_DIR}`);
      ensureDirSync(TEMP_DIR);
    });
  } else {
    console.log(`Creating temporary directory ${TEMP_DIR}`);
    ensureDirSync(TEMP_DIR);
  }

  // Create a new job queue for deepfake processing jobs.
  console.log("Creating job queue");
  const queue = new Queue(DEEPFAKE_QUEUE, {
    connection: new Redis(process.env.REDIS_URL!, {
      db: parseInt(process.env.WORKER_DB!),
      maxRetriesPerRequest: null,
      retryStrategy: () => 3000,
    }),
  });

  // Clear the queue to remove any existing jobs.
  console.log("Draining existing jobs from the queue");
  await queue.drain(true);
  console.log("Queue drained");

  // Create a new worker to process jobs from the deepfake queue.
  console.log("Creating worker");
  const worker = new Worker<DeepfakeJobInput, DeepfakeJobOutput>(
    DEEPFAKE_QUEUE,
    async (job) => {
      console.log(`Processing job ${job.id}`);
      console.log(`Job data:`, job.data);

      // Check if the job has been idle for too long.
      const idleDiff = Date.now() - job.data.lastPolledAt;
      console.log(`Job idle time: ${idleDiff}ms`);
      if (idleDiff > job.data.maxIdleMillis) {
        console.log(`Job ${job.id} skipped due to exceeding max idle time`);
        return { success: false, error: "Job skipped for lack of polling" };
      }

      console.log("Downloading input files");
      const downloadStart = Date.now();

      try {
        // Download the target file from the Minio storage.
        console.log(`Downloading target file: ${job.data.target}`);
        const targetStat = await minio.statObject(DEEPFAKE_BUCKET, job.data.target);
        console.log(`Target file stats:`, targetStat);
        const targetMime = targetStat.metaData["content-type"] as string;
        console.log(`Target MIME type: ${targetMime}`);
        const targetFile = `${job.data.target}.${extension(targetMime)}`;
        const targetPath = join(TEMP_DIR, targetFile);
        console.log(`Target file path: ${targetPath}`);
        await minio.fGetObject(DEEPFAKE_BUCKET, job.data.target, targetPath);
        console.log(`Target file downloaded`);
        
        let photo = true;

        // If the target file is a video, check its duration.
        if (targetMime.startsWith("video/")) {
          console.log("Target is a video, checking duration");
          photo = false;

          const probe = await new Promise<z.infer<typeof ffprobeSchema>>(
            (resolve, reject) => {
              FFmpegCommand()
                .addInput(targetPath)
                .ffprobe((err, data) => {
                  if (err) {
                    console.error("FFprobe error:", err);
                    return reject("ffprobe error (1/2)");
                  }

                  try {
                    resolve(ffprobeSchema.parse(data));
                  } catch (err) {
                    console.error("FFprobe parsing error:", err);
                    reject("ffprobe error (2/2)");
                  }
                });
            }
          );

          console.log(`Video duration: ${probe.format.duration} seconds`);

          // Check if the video duration exceeds the allowed limit.
          if (probe.format.duration * 1000 > job.data.millisLimit) {
            console.log(`Video duration exceeds limit of ${job.data.millisLimit}ms`);
            return {
              success: false,
              error: `Target video too long (${Math.round(
                job.data.millisLimit / 1000
              )}s max)`,
            };
          }
        }

        // Download the source file from the Minio storage.
        console.log(`Downloading source file: ${job.data.source}`);
        const sourceStat = await minio.statObject(DEEPFAKE_BUCKET, job.data.source);
        console.log(`Source file stats:`, sourceStat);
        const sourceFile = `${job.data.source}.${extension(sourceStat.metaData["content-type"])}`;
        const sourcePath = join(TEMP_DIR, sourceFile);
        console.log(`Source file path: ${sourcePath}`);
        await minio.fGetObject(DEEPFAKE_BUCKET, job.data.source, sourcePath);
        console.log(`Source file downloaded`);

        console.log(`Download time: ${(Date.now() - downloadStart) / 1000} seconds`);

        console.log("Starting deepfake processing");
        const deepfakeStart = Date.now();

        let result: DeepfakeJobOutput = {
          success: false,
          error: "Uninitialized response",
        };

        try {
          let lastProgressUpdate = 0;

          // Process the deepfake using the processRoop function.
          console.log(`Processing deepfake: source=${sourcePath}, target=${targetPath}, photo=${photo}`);
          const outputPath = await processFacefusion(
            sourcePath,
            targetPath,
            photo,
            // async (processedFrames, totalFrames) => {
            //   if (Date.now() - lastProgressUpdate < 1_000) return;
            //   lastProgressUpdate = Date.now();

            //   await job.updateProgress(Math.round(processedFrames / totalFrames * 100)); // prettier-ignore
            // }
          );
          console.log(`Deepfake processing completed, output path: ${outputPath}`);

          // Upload the processed output to the Minio storage.
          console.log(`Uploading output to Minio: ${job.data.output}`);
          await minio.fPutObject(DEEPFAKE_BUCKET, job.data.output, outputPath);
          console.log(`Output uploaded`);
          unlinkSync(outputPath);
          console.log(`Local output file deleted`);
          result = { success: true };
        } catch (err) {
          console.error("Deepfake processing error:", err);

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
        console.log(`Cleaning up temporary files: ${sourcePath}, ${targetPath}`);
        unlinkSync(sourcePath);
        unlinkSync(targetPath);

        // Remove the source and target files from the Minio storage.
        console.log(`Removing source and target files from Minio`);
        await Promise.allSettled([
          minio.removeObject(DEEPFAKE_BUCKET, job.data.source),
          minio.removeObject(DEEPFAKE_BUCKET, job.data.target),
        ]);
        console.log(`Minio cleanup completed`);

        console.log(`Deepfake processing time: ${(Date.now() - deepfakeStart) / 1000} seconds`);

        return result;
      } catch (err) {
        console.error("Worker error:", err);
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

  console.log(`Worker started with ID: ${worker.id}`);
}

// Define a Zod schema for FFmpeg probe output validation.
const ffprobeSchema = z.object({ format: z.object({ duration: z.number() }) });
console.log("FFprobe schema defined");