import { join, resolve, basename } from "path";
import { existsSync } from "fs-extra";
import { spawn } from "child_process";

const TEMP_DIR = resolve("./temp/");
const cwd = resolve("../roop");

const venv = ["--venv", "/workspace/deepfake/roop"];

const args = [
  "--execution-provider",
  "cuda",

  "--frame-processor",
  "face_swapper",
  "face_enhancer",

  "--video-quality",
  "8",
  // "10",
  // "12",
  //"14",

  "--execution-threads",
  "4",
  // "6",
  // "8",

  // "--keep-fps",
];

export async function processRoop(
  source: string,
  target: string,
  progressHandler?: (
    processedFrames: number,
    totalFrames: number
  ) => Promise<void> | void
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    let success = false;

    const child = spawn(
      "venv-run",
      [...venv, "run.py", "-s", source, "-t", target, "-o", TEMP_DIR, ...args],
      { cwd }
    );

    let timeoutTriggered = false;

    const id = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, 20 * 60 * 1000); // 20 min

    function extractProgress(str: string) {
      if (!progressHandler) return;

      try {
        const regex = /Processing:.* ([0-9]+)\/([0-9]+) /gm;

        let m: RegExpExecArray | null = null;
        while ((m = regex.exec(str)) !== null) {
          // necessary to avoid infinite loops with zero-width matches
          if (m.index === regex.lastIndex) regex.lastIndex++;

          if (m.length === 3) {
            const processedFrames = parseInt(m[1], 10);
            const totalFrames = parseInt(m[2], 10);

            if (isNaN(processedFrames) || isNaN(totalFrames)) return;
            return void progressHandler(processedFrames, totalFrames);
          }
        }
      } catch (err) {}
    }

    child.stdout.on("data", (raw) => {
      const data = String(raw || "");
      // console.log(`child stdout:\n${data}`);
      console.log(`child stdout:\n${data}`);

      if (data.includes("[ROOP.CORE] Finished")) {
        success = true;
      }

      extractProgress(data);
    });

    child.stderr.on("data", (raw) => {
      const data = String(raw || "");
      // console.error(`child stderr:\n${data}`);
      console.error(`"${data}"`);

      extractProgress(data);
    });

    child.on("exit", function (code, signal) {
      clearTimeout(id);
      if (code === 0 && success) return resolve();
      if (timeoutTriggered) return reject("Deepfake processing timed out");
      reject(`exited - code: ${code}, signal: ${signal}`);
    });
  });

  const extension = target.endsWith(".mp4") ? "mp4" : "png";

  const checks = ["_fake", "_fake_final"]
    .map((x) => {
      const path = generateOutputPath(target, x, extension);
      return { path, exists: existsSync(path) };
    })
    .filter((x) => x.exists);

  const outputPath = checks.pop();
  if (!outputPath) throw "internal deepfake error";

  const { path } = outputPath;
  console.log({ output: path });

  return path;
}

function generateOutputPath(
  target: string,
  suffix: string,
  ext: string
): string {
  const parts = basename(target).split(".");
  parts.splice(0, 0, `${parts.shift() || "unknown"}${suffix}`);
  parts.pop();
  parts.push(ext);
  return join(TEMP_DIR, parts.join("."));
}
