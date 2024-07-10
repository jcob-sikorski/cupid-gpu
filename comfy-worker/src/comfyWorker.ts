import { ensureDirSync, existsSync, rm, unlinkSync } from "fs-extra";
import { Queue, Worker } from "bullmq";
import { join, resolve } from "path";
import { processComfy } from "./comfy";
import FFmpegCommand from "fluent-ffmpeg";
import { extension } from "mime-types";
import * as Minio from "minio";
import { Redis } from "ioredis";
import { z } from "zod";
import { ComfyGenerateType } from "./comfy-schema";
import * as fs from 'fs/promises';
import * as net from 'net';

console.log("Starting ComfyUI worker script");

const TEMP_DIR = resolve("./temp/");
console.log(`Temporary directory set to: ${TEMP_DIR}`);

export type ComfyJobInput = {
  userId: string;
  lastPolledAt: number;
  workflow: ComfyGenerateType;
  output: string[];
};

export type ComfyJobOutput =
  | { success: false; error: string }
  | { success: true };

  console.log("Minio Configuration:", {
    endPoint: process.env.MINIO_HOST,
    port: process.env.MINIO_PORT,
    useSSL: process.env.MINIO_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY ? "Set" : "Not Set",
    secretKey: process.env.MINIO_SECRET_KEY ? "Set" : "Not Set",
  });
  
  console.log("Creating Minio client");
  const minio = new Minio.Client({
    endPoint: process.env.MINIO_HOST!,
    port: parseInt(process.env.MINIO_PORT!),
    useSSL: process.env.MINIO_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY!,
    secretKey: process.env.MINIO_SECRET_KEY!,
  });
  
  const COMFY_QUEUE = "comfy_worker";
  const COMFY_BUCKET = "comfy";
  console.log(`Queue name: ${COMFY_QUEUE}, Bucket name: ${COMFY_BUCKET}`);
  
  function checkConnection(host: string, port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      socket.setTimeout(5000);  // 5 second timeout
  
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
  
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('Connection timed out'));
      });
  
      socket.on('error', (error) => {
        reject(error);
      });
  
      socket.connect(port, host);
    });
  }

export async function startComfyWorker() {
  console.log("Starting ComfyUI worker function");
  
  // Test Minio connection
  try {
    console.log("Testing Minio connection...");
    const buckets = await minio.listBuckets();
    console.log("Successfully connected to Minio. Available buckets:", buckets);
  } catch (error) {
    console.error("Failed to connect to Minio:", error);
  }

  // Check bucket existence
  try {
    console.log(`Checking if bucket ${COMFY_BUCKET} exists...`);
    const exists = await minio.bucketExists(COMFY_BUCKET);
    if (exists) {
      console.log(`Bucket ${COMFY_BUCKET} exists`);
    } else {
      console.log(`Bucket ${COMFY_BUCKET} does not exist, creating it`);
      await minio.makeBucket(COMFY_BUCKET);
    }
  } catch (error) {
    console.error("Error checking/creating bucket:", error);
  }

  // Check network connectivity
  try {
    await checkConnection(process.env.MINIO_HOST!, parseInt(process.env.MINIO_PORT!));
    console.log("Network connection to Minio server successful");
  } catch (error) {
    console.error("Failed to connect to Minio server:", error);
  }

  console.log("Starting ComfyUI worker function");
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
  const queue = new Queue(COMFY_QUEUE, {
    connection: new Redis(process.env.REDIS_URL!, {
      db: parseInt(process.env.WORKER_DB!),
      maxRetriesPerRequest: null,
      retryStrategy: () => 3000,
    }),
  });
  console.log("Job queue created with Redis config:", {
    url: process.env.REDIS_URL,
    db: process.env.WORKER_DB,
  });

  console.log("Draining existing jobs from the queue");
  await queue.drain(true);
  console.log("Queue drained");

  console.log("Creating worker");
  const worker = new Worker<ComfyJobInput, ComfyJobOutput>(
    COMFY_QUEUE,
    async (job) => {
      console.log(`Processing job ${job.id}`);
      console.log(`Job data:`, JSON.stringify(job.data, null, 2));

      console.log("Downloading input files");
      const downloadStart = Date.now();

      const downloadFile = async (fileKey: string, prefix: string): Promise<string | null> => {
        if (!fileKey) {
          console.log(`No file key provided for ${prefix}, skipping download`);
          return null;
        }
      
        console.log(`Downloading file: ${fileKey}`);
        try {
          const stat = await minio.statObject(COMFY_BUCKET, fileKey);
          console.log(`File stats for ${fileKey}:`, JSON.stringify(stat, null, 2));
          const mime = stat.metaData["content-type"] as string;
          console.log(`MIME type for ${fileKey}: ${mime}`);
          const file = `${prefix}_${fileKey}.${extension(mime)}`;
          const path = join(TEMP_DIR, file);
          console.log(`File path for ${fileKey}: ${path}`);
          await minio.fGetObject(COMFY_BUCKET, fileKey, path);
          console.log(`File downloaded: ${path}`);
          return path;
        } catch (error) {
          console.error(`Error downloading file ${fileKey}:`, error);
          return null;
        }
      };

      try {
        const downloadedFiles: {
          ipas: string[];
          controlnet: string | null;
          upscaler: string | null;
        } = {
          ipas: [],
          controlnet: null,
          upscaler: null
        };
        
        console.log('Controlnet in workflow:', job.data.workflow.controlnet);
        // Download ControlNet file
        if (job.data.workflow.controlnet && job.data.workflow.controlnet.fileKey) {
          downloadedFiles.controlnet = await downloadFile(job.data.workflow.controlnet.fileKey, 'controlnet');
          console.log(`ControlNet file downloaded: ${downloadedFiles.controlnet}`);
        }

        console.log(`Download time: ${(Date.now() - downloadStart) / 1000} seconds`);
        console.log("Downloaded files:", JSON.stringify(downloadedFiles, null, 2));

        console.log("Starting ComfyUI processing");
        const comfyStart = Date.now();

        let result: ComfyJobOutput = {
          success: false,
          error: "Uninitialized response",
        };
        
        try {
          await processComfy(
            downloadedFiles,
            job.data.workflow
          );
          const outputPaths = await processComfy(
            downloadedFiles,
            job.data.workflow
          );
          // const outputPaths = [
          //   "/workspace/comfy-worker-copy/src/img1.jpg",
          //   "/workspace/comfy-worker-copy/src/img2.png",
          // ]
          const outputKeys = ['12345', '6789']
          console.log(`ComfyUI processing completed, output paths:`, outputPaths);

          // Get the last 'batchSize' number of elements from outputPaths
          const batchSize = job.data.workflow.batchSize || job.data.output.length;
          // const batchSize = 2;
          const lastOutputPaths = outputPaths.slice(-batchSize);
          
          if (!Array.isArray(job.data.output) || job.data.output.length !== lastOutputPaths.length) {
            console.warn('Mismatch between number of output paths and output keys');
          }
          
          for (let i = 0; i < lastOutputPaths.length; i++) {
            const outputPath = lastOutputPaths[i];
            const outputKey = job.data.output[i];
            // const outputKey = outputKeys[i];
          
            const maxRetries = 3;
            let retries = 0;
            while (retries < maxRetries) {
              try {
                console.log(`Uploading file ${outputPath} to bucket ${COMFY_BUCKET} with key ${outputKey}`);
                await minio.fPutObject(COMFY_BUCKET, outputKey, outputPath);
                console.log(`Successfully uploaded ${outputKey}`);
                break;
              } catch (error) {
                console.error(`Upload attempt ${retries + 1} failed:`, error);
                if (error instanceof Error) {
                  console.error("Error name:", error.name);
                  console.error("Error message:", error.message);
                  console.error("Error stack:", error.stack);
                }
                if (typeof error === 'object' && error !== null) {
                  console.error("Error details:", JSON.stringify(error, null, 2));
                }
                retries++;
                if (retries === maxRetries) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retrying
              }
            }
          
            unlinkSync(outputPath);
            console.log(`Local output file deleted: ${outputPath}`);
          }
          
          result = { success: true };
        } catch (err) {
          console.error("ComfyUI processing error:", err);
          result = {
            success: false,
            error: "Processing failed, please check your input and workflow",
          };
        }

        console.log('Cleaning up temporary files');

        const filesToDelete = [
          ...downloadedFiles.ipas,
          downloadedFiles.controlnet,
          downloadedFiles.upscaler
        ].filter(Boolean) as string[];

        for (const filePath of filesToDelete) {
          try {
            unlinkSync(filePath);
            console.log(`Deleted temporary file: ${filePath}`);
          } catch (error) {
            console.error(`Error deleting file ${filePath}:`, error);
          }
        }

        console.log('Removing input files from Minio');

        const minioDeletePromises: Promise<void>[] = [];

        if (job.data.workflow.ipas) {
          for (const ipa of job.data.workflow.ipas) {
            if (ipa && ipa.fileKey) {
              console.log(`Queuing deletion of IPA file: ${ipa.fileKey}`);
              minioDeletePromises.push(minio.removeObject(COMFY_BUCKET, ipa.fileKey));
            }
          }
        }

        if (job.data.workflow.controlnet && job.data.workflow.controlnet.fileKey) {
          console.log(`Queuing deletion of ControlNet file: ${job.data.workflow.controlnet.fileKey}`);
          minioDeletePromises.push(minio.removeObject(COMFY_BUCKET, job.data.workflow.controlnet.fileKey));
        }

        if (job.data.workflow.upscaler && job.data.workflow.upscaler.fileKey) {
          console.log(`Queuing deletion of Upscaler file: ${job.data.workflow.upscaler.fileKey}`);
          minioDeletePromises.push(minio.removeObject(COMFY_BUCKET, job.data.workflow.upscaler.fileKey));
        }

        const deleteResults = await Promise.allSettled(minioDeletePromises);
        console.log(`Minio cleanup completed. Results:`, JSON.stringify(deleteResults, null, 2));

        console.log(`ComfyUI processing time: ${(Date.now() - comfyStart) / 1000} seconds`);

        return result;
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

  console.log(`ComfyUI Worker started with ID: ${worker.id}`);
}