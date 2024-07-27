import { ensureDirSync, existsSync, rm, unlinkSync } from "fs-extra";
import { Queue, Worker } from "bullmq";
import { join, resolve } from "path";
import FFmpegCommand from "fluent-ffmpeg";
import { extension } from "mime-types";
import * as Minio from "minio";
import { Redis } from "ioredis";
import { z } from "zod";
import { processFacefusion } from "./facefusion";

console.log("Starting deepfake worker script");

const TEMP_DIR = resolve("./temp/");
console.log(`Temporary directory set to: ${TEMP_DIR}`);

export type DeepfakeJobInput = {
  userId: string;
  millisLimit: number;
  lastPolledAt: number;
  maxIdleMillis: number;
  source: string;
  target: string;
  output: string;
};

export type DeepfakeJobOutput =
  | { success: false; error: string }
  | { success: true; outputs: string[] };

type ProcessingPair = {
  source: string;
  target: string;
  photo: boolean;
};

console.log("Creating Minio client");
const minio = new Minio.Client({
  endPoint: process.env.MINIO_HOST!,
  port: parseInt(process.env.MINIO_PORT!),
  useSSL: process.env.MINIO_SSL === "true",
  accessKey: process.env.MINIO_ACCESS_KEY!,
  secretKey: process.env.MINIO_SECRET_KEY!,
});
console.log("Minio client created");

const DEEPFAKE_QUEUE = "deepfake_worker";
const DEEPFAKE_BUCKET = "deepfake";
console.log(`Queue name: ${DEEPFAKE_QUEUE}, Bucket name: ${DEEPFAKE_BUCKET}`);

export async function startWorker() {
  console.log("Starting worker function");
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

  console.log("Creating job queue");
  const queue = new Queue(DEEPFAKE_QUEUE, {
    connection: new Redis(process.env.REDIS_URL!, {
      db: parseInt(process.env.WORKER_DB!),
      maxRetriesPerRequest: null,
      retryStrategy: () => 3000,
    }),
  });

  console.log("Draining existing jobs from the queue");
  await queue.drain(true);
  console.log("Queue drained");

  console.log("Creating worker");
  const worker = new Worker<DeepfakeJobInput, DeepfakeJobOutput>(
    DEEPFAKE_QUEUE,
    async (job) => {
      console.log(`Processing job ${job.id}`);
      console.log(`Job data:`, job.data);

      const idleDiff = Date.now() - job.data.lastPolledAt;
      console.log(`Job idle time: ${idleDiff}ms`);
      if (idleDiff > job.data.maxIdleMillis) {
        console.log(`Job ${job.id} skipped due to exceeding max idle time`);
        return { success: false, error: "Job skipped for lack of polling" };
      }

      console.log("Downloading input files");
      const downloadStart = Date.now();

      try {
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

        console.log(`Downloading source file: ${job.data.source}`);
        const sourceStat = await minio.statObject(DEEPFAKE_BUCKET, job.data.source);
        console.log(`Source file stats:`, sourceStat);
        const sourceFile = `${job.data.source}.${extension(sourceStat.metaData["content-type"])}`;
        const sourcePath = join(TEMP_DIR, sourceFile);
        console.log(`Source file path: ${sourcePath}`);
        await minio.fGetObject(DEEPFAKE_BUCKET, job.data.source, sourcePath);
        console.log(`Source file downloaded`);

        const processingPair: ProcessingPair = { source: sourcePath, target: targetPath, photo };

        console.log(`Download time: ${(Date.now() - downloadStart) / 1000} seconds`);

        console.log("Starting deepfake processing");
        const deepfakeStart = Date.now();

        try {
          const outputs = await processFacefusion([processingPair]);
          console.log(`Deepfake processing completed, output paths:`, outputs);

          console.log(`Uploading output to Minio: ${job.data.output}`);
          await minio.fPutObject(DEEPFAKE_BUCKET, job.data.output, outputs[0]);
          console.log(`Output uploaded`);
          unlinkSync(outputs[0]);
          console.log(`Local output file deleted`);

          console.log(`Cleaning up temporary files: ${sourcePath}, ${targetPath}`);
          unlinkSync(sourcePath);
          unlinkSync(targetPath);

          console.log(`Removing source and target files from Minio`);
          await Promise.allSettled([
            minio.removeObject(DEEPFAKE_BUCKET, job.data.source),
            minio.removeObject(DEEPFAKE_BUCKET, job.data.target),
          ]);
          console.log(`Minio cleanup completed`);

          console.log(`Deepfake processing time: ${(Date.now() - deepfakeStart) / 1000} seconds`);

          return { success: true, outputs: [job.data.output] };
        } catch (err) {
          console.error("Deepfake processing error:", err);

          if (String(err).includes("Deepfake processing timed out")) {
            return {
              success: false,
              error: "Deepfake processing timed out",
            };
          } else {
            return {
              success: false,
              error: "Processing failed, face might not be detected in one of your inputs",
            };
          }
        }
      } catch (err) {
        console.error("Worker error:", err);
        return { success: false, error: "Unexpected worker error" };
      }
    },
    {
      concurrency: 1,
      connection: new Redis(process.env.REDIS_URL!, {
        db: parseInt(process.env.WORKER_DB!),
        maxRetriesPerRequest: null,
        retryStrategy: () => 3000,
      }),
    }
  );

  console.log(`Worker started with ID: ${worker.id}`);
}

const ffprobeSchema = z.object({ format: z.object({ duration: z.number() }) });
console.log("FFprobe schema defined");