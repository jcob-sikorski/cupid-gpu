import { join, resolve, basename, extname } from "path";
import { spawn } from "child_process";
import * as fs from 'fs';
import sharp from 'sharp';

const TEMP_DIR = resolve("./temp/");
const cwd = resolve("../facefusion");
const venv = ["--venv", "/workspace/facefusion"];

const photo_args = [
  "--headless",
  "--execution-providers", "cuda",
  "--execution-thread-count", "16",
  "--execution-queue-count", "4",
  "--video-memory-strategy", "tolerant",
  "--frame-processors", "face_swapper", "face_enhancer",
  "--face-enhancer-model", "gpen_bfr_512",
  "--face-enhancer-blend", "85",
  "--reference-face-distance", "0.75",
  "--output-image-quality", "95",
  "--output-image-resolution", "1920x1080",
  "--face-detector-model", "yunet",
  "--face-detector-size", "1024",
  "--face-landmarker-score", "0.90",
  "--face-mask-blur", "0.35",
];

const video_args = [
  "--headless",
  "--execution-providers", "cuda",
  "--execution-thread-count", "16",
  "--execution-queue-count", "4",
  "--video-memory-strategy", "tolerant",
  "--frame-processors", "face_swapper", "face_enhancer",
  "--reference-face-distance", "1.0",
  "--output-video-preset", "veryfast",
];

export async function processFacefusion(
  pairs: { source: string; target: string; photo: boolean }[]
): Promise<string[]> {
  const outputs: string[] = [];

  for (const pair of pairs) {
    const { source, target, photo } = pair;

    await new Promise<void>((resolve, reject) => {
      const args = photo ? photo_args : video_args;

      const child = spawn(
        "venv-run",
        [...venv, "run.py", "--source", source, "--target", target, "-o", TEMP_DIR, ...args],
        { cwd }
      );

      let timeoutTriggered = false;

      const id = setTimeout(() => {
        timeoutTriggered = true;
        child.kill("SIGTERM");
      }, 20 * 60 * 1000);

      let outputBuffer = '';

      child.stdout.on("data", (raw) => {
        const data = String(raw || "");
        console.log(`child stdout:\n${data}`);
        outputBuffer += data;
      });

      let success = false;

      child.stderr.on("data", (raw) => {
        const data = String(raw || "");
        console.error(`child stderr:\n${data}`);
        outputBuffer += data;

        if (data.toLowerCase().includes("[facefusion.core] processing to image succeed") || 
            data.toLowerCase().includes("[facefusion.core] processing to video succeed")) {
          success = true;
        }
      });

      child.on('close', () => {
        if (outputBuffer.toLowerCase().includes("[facefusion.core] processing to image succeed") || 
            outputBuffer.toLowerCase().includes("[facefusion.core] processing to video succeed")) {
          success = true;
        }
        console.log("Final output buffer:", outputBuffer);
      });

      child.on("exit", function (code, signal) {
        clearTimeout(id);
        console.log(`Process exited. Exit code: ${code}, Success flag: ${success}`);
        if (code === 0 || success) {
          return resolve();
        }
        if (timeoutTriggered) return reject("Deepfake processing timed out");
        reject(`Process exited with error - code: ${code}, signal: ${signal}`);
      });
    });

    console.log(`Looking for output files in: ${TEMP_DIR}`);
    console.log(`Target file: ${target}`);

    const filesInTempDir = fs.readdirSync(TEMP_DIR);
    console.log(`Files in ${TEMP_DIR}:`, filesInTempDir);

    const targetBaseName = basename(target, extname(target));

    const outputFile = filesInTempDir.find(file => 
      file.startsWith(targetBaseName) && file !== basename(target)
    );

    if (!outputFile) {
      console.error("No output file found.");
      throw "internal deepfake error: No output file found";
    }

    const outputPath = join(TEMP_DIR, outputFile);
    console.log({ output: outputPath });

    if (photo) {
      const enhancedImageBuffer = await sharp(outputPath)
        .sharpen({
          sigma: 1.5,
          m1: 0.5,
          m2: 0.5,
        })
        .toBuffer();

      const enhancedOutputPath = outputPath.replace(extname(outputPath), '_enhanced' + extname(outputPath));
      await fs.promises.writeFile(enhancedOutputPath, enhancedImageBuffer);

      console.log({ enhancedOutput: enhancedOutputPath });
      outputs.push(enhancedOutputPath);
    } else {    
      outputs.push(outputPath);
    }
  }

  return outputs;
}