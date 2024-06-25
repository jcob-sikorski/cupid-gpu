// Import necessary functions from the 'path' module to handle file and directory paths.
import { join, resolve, basename } from "path";
// Import the 'existsSync' function from the 'fs-extra' module to check for file existence.
import { existsSync } from "fs-extra";
// Import the 'spawn' function from the 'child_process' module to run external commands.
import { spawn } from "child_process";

// Define the directory where temporary files will be stored, resolving the path to the current directory.
const TEMP_DIR = resolve("./temp/");
// Define the current working directory for the process, resolving the path to the parent directory.
const cwd = resolve("../roop");

// Define the virtual environment command line arguments.
const venv = ["--venv", "/workspace/deepfake/roop"];

// Define the arguments to be passed to the deepfake processing command.
const args = [
  "--execution-provider",
  "cuda", // Specify the execution provider, in this case, CUDA for GPU acceleration.

  "--frame-processor",
  "face_swapper", // Use the face swapper processor.
  "face_enhancer", // Use the face enhancer processor.

  "--video-quality",
  "8", // Set the video quality to 8 (options for higher quality are commented out).

  "--execution-threads",
  "4", // Set the number of execution threads to 4 (options for more threads are commented out).

  // "--keep-fps", // Option to keep the original frames per second (FPS) is commented out.
];

/**
 * Function to process the deepfake using Roop.
 * @param source - The source file path.
 * @param target - The target file path.
 * @param progressHandler - Optional callback to handle progress updates.
 * @returns A promise that resolves with the path to the processed output.
 */
export async function processRoop(
  source: string,
  target: string,
  progressHandler?: (
    processedFrames: number,
    totalFrames: number
  ) => Promise<void> | void
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    let success = false; // Flag to indicate successful processing.

    // Spawn a child process to run the deepfake command.
    const child = spawn(
      "venv-run",
      [...venv, "run.py", "-s", source, "-t", target, "-o", TEMP_DIR, ...args],
      { cwd }
    );

    let timeoutTriggered = false; // Flag to indicate if the timeout was triggered.

    // Set a timeout to kill the process if it takes longer than 20 minutes.
    const id = setTimeout(() => {
      timeoutTriggered = true;
      child.kill("SIGTERM");
    }, 20 * 60 * 1000); // 20 minutes

    /**
     * Extract progress information from the output string.
     * @param str - The output string from the process.
     */
    function extractProgress(str: string) {
      if (!progressHandler) return;

      try {
        const regex = /Processing:.* ([0-9]+)\/([0-9]+) /gm;
        let m: RegExpExecArray | null = null;
        while ((m = regex.exec(str)) !== null) {
          // Necessary to avoid infinite loops with zero-width matches.
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

    // Handle data from the child process stdout.
    child.stdout.on("data", (raw) => {
      const data = String(raw || "");
      console.log(`child stdout:\n${data}`);

      // Check if the process finished successfully.
      if (data.includes("[ROOP.CORE] Finished")) {
        success = true;
      }

      extractProgress(data); // Extract progress information.
    });

    // Handle data from the child process stderr.
    child.stderr.on("data", (raw) => {
      const data = String(raw || "");
      console.error(`"${data}"`);

      extractProgress(data); // Extract progress information.
    });

    // Handle the child process exit event.
    child.on("exit", function (code, signal) {
      clearTimeout(id);
      if (code === 0 && success) return resolve();
      if (timeoutTriggered) return reject("Deepfake processing timed out");
      reject(`exited - code: ${code}, signal: ${signal}`);
    });
  });

  const extension = target.endsWith(".mp4") ? "mp4" : "png"; // Determine the file extension for the output.

  // Check for the existence of output files with specific suffixes.
  const checks = ["_fake", "_fake_final"]
    .map((x) => {
      const path = generateOutputPath(target, x, extension);
      return { path, exists: existsSync(path) };
    })
    .filter((x) => x.exists);

  const outputPath = checks.pop(); // Get the last existing output path.
  if (!outputPath) throw "internal deepfake error"; // Throw an error if no output path exists.

  const { path } = outputPath;
  console.log({ output: path });

  return path; // Return the path to the processed output.
}

/**
 * Generate the output path for the processed file.
 * @param target - The target file path.
 * @param suffix - The suffix to append to the filename.
 * @param ext - The file extension.
 * @returns The generated output path.
 */
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
