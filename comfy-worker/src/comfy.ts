import { ComfyGenerateType } from "./comfy-schema";

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as fsfs from 'fs';

const clientId = uuidv4();
// const serverAddress = '89.187.159.48:40171';
const serverAddress = '0.0.0.0:8188';

console.log(`Client ID: ${clientId}`);
console.log(`Server Address: ${serverAddress}`);


async function queuePrompt(prompt: any): Promise<{ prompt_id: string }> {
    console.log('STARTING: queuePrompt function');
    console.log('QUEUEING PROMPT');
    const p = { prompt, client_id: clientId };
    console.log(`GOT THE PROMPT ${JSON.stringify(prompt)}`);
    console.log(`Sending POST request to http://${serverAddress}/prompt`);
    const { data } = await axios.post(`http://${serverAddress}/prompt`, p);
    console.log(`SENT A REQUEST TO COMFY: ${JSON.stringify(data)}`);
    console.log('ENDING: queuePrompt function');
    return data;
}

async function getImage(filename: string, subfolder: string, folderType: string): Promise<Buffer> {
  console.log(`GETTING IMAGE --filename: ${filename} --subfolder: ${subfolder} --folder_type: ${folderType}`);
  const params = new URLSearchParams({ filename, subfolder, type: folderType });
  const { data } = await axios.get(`http://${serverAddress}/view?${params}`, { responseType: 'arraybuffer' });
  console.log(`Received image data of length: ${data.length} bytes`);
  return data;
}

async function getHistory(promptId: string): Promise<any> {
    console.log('STARTING: getHistory function');
    console.log(`Sending GET request to http://${serverAddress}/history/${promptId}`);
    const { data } = await axios.get(`http://${serverAddress}/history/${promptId}`);
    console.log(`GOT HISTORY FOR PROMPT ID ${promptId}: ${JSON.stringify(data)}`);
    console.log('ENDING: getHistory function');
    return data;
}

async function getImages(ws: WebSocket, prompt: any): Promise<Buffer[]> {
  console.log('STARTING: getImages function');
  console.log('QUEUEING PROMPT');
  const { prompt_id } = await queuePrompt(prompt);
  console.log(`Prompt ID: ${prompt_id}`);
  const rawImagesOutput: Buffer[] = [];

  return new Promise((resolve, reject) => {
    console.log('Setting up WebSocket message listener');
    ws.on('message', async (data: WebSocket.RawData) => {
      console.log('Message received.');
      
      let messageString: string;
      if (data instanceof Buffer) {
        messageString = data.toString('utf-8');
        console.log('Converted buffer to string.');
      } else if (typeof data === 'string') {
        messageString = data;
      } else {
        console.log('Received unknown data type from WebSocket');
        return;
      }

      try {
        const message = JSON.parse(messageString);
        console.log('Parsed message.');

        if (message.type === 'executing' && message.data.node === null && message.data.prompt_id === prompt_id) {
          console.log('EXECUTION IS DONE');
          try {
            const history = await getHistory(prompt_id);
            console.log(`Execution history: ${JSON.stringify(history)}`);
            for (const node_id in history[prompt_id].outputs) {
              const node_output = history[prompt_id].outputs[node_id];
              if (node_output.images) {
                for (const image of node_output.images) {
                  const imageData = await getImage(image.filename, image.subfolder, image.type);
                  rawImagesOutput.push(imageData);
                }
              }
            }
            resolve(rawImagesOutput);
          } catch (e) {
            console.error(`WHILE READING EXECUTION HISTORY EXCEPTION OCCURRED: ${e}`);
            reject(e);
          }
        } else if (message.type === 'executed') {
          if (message.data && message.data.output && Array.isArray(message.data.output.images)) {
            console.log('SUCCESS');
            message.data.output.images.forEach((image: { filename: string }) => {
              console.log(image.filename);
            });
          }
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });
  });
}

async function saveImages(images: Buffer[]): Promise<string[]> {
  console.log('STARTING: saveImages function');
  const savedImagePaths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const filename = `output_image_${i}.png`;
    console.log(`Saving image to file: ${filename}`);
    await fs.writeFile(filename, images[i]);
    console.log(`Saved ${filename}, size: ${images[i].length} bytes`);
    savedImagePaths.push(filename);
  }
  console.log('ENDING: saveImages function');
  return savedImagePaths;
}

function logJsonDepth(obj: any, indent = 0, skipPath = '') {
  if (obj === null) {
    console.log(`${' '.repeat(indent * 2)}null`);
    return;
  }

  if (typeof obj !== 'object') {
    console.log(`${' '.repeat(indent * 2)}${obj}`);
    return;
  }

  if (Array.isArray(obj)) {
    console.log(`${' '.repeat(indent * 2)}[`);
    obj.forEach((item, index) => {
      console.log(`${' '.repeat((indent + 1) * 2)}${index}:`);
      logJsonDepth(item, indent + 2, `${skipPath}[${index}]`);
    });
    console.log(`${' '.repeat(indent * 2)}]`);
    return;
  }

  Object.keys(obj).forEach(key => {
    const value = obj[key];
    const indentation = ' '.repeat(indent * 2);
    const currentPath = skipPath ? `${skipPath}.${key}` : key;
    
    if (currentPath === '207.inputs') {
      console.log(`${indentation}${key}: [inputs omitted]`);
      return;
    }

    console.log(`${indentation}${key}:`);
    logJsonDepth(value, indent + 1, currentPath);
  });
}

function modifyWorkflow(
  workflowJson: any, 
  workflow: ComfyGenerateType, 
  downloadedFiles: {
    ipas: string[];
    controlnet: string | null;
    upscaler: string | null;
  }
): any {
  // Clone the workflow to avoid modifying the original
  const modifiedWorkflow = JSON.parse(JSON.stringify(workflowJson));

  // Update the DPRandomGenerator node (key "222")
  if (modifiedWorkflow["222"]) {
    // Update the text input with the positive prompt
    modifiedWorkflow["222"].inputs.text = workflow.posPrompt;

    // If you want to keep the seed random or use a specific seed, you can modify it here
    // modifiedWorkflow["222"].inputs.seed = workflow.seed; // Uncomment if you want to use the workflow seed
  } else {
    console.warn("Node with key '222' (DPRandomGenerator) not found in the workflow.");
  }

  // Update the Efficient Loader node (key "206")
  if (modifiedWorkflow["206"]) {
    // Update the batch size
    modifiedWorkflow["206"].inputs.batch_size = workflow.batchSize || 4; // Default to 4 if not provided

    // Update the negative prompt if workflow.negPrompt has content
    if (workflow.negPrompt && workflow.negPrompt.length > 0) {
      modifiedWorkflow["206"].inputs.negative = workflow.negPrompt;
    }

    // Update the ckpt_name if workflow.model is available
    if (workflow.model && workflow.model.length > 0) {
      modifiedWorkflow["206"].inputs.ckpt_name = workflow.model;
    }

    // Update the ckpt_name if workflow.model is available
    if (workflow.clipSkip) {
      modifiedWorkflow["206"].inputs.clip_skip = workflow.clipSkip;
    }
  } else {
    console.warn("Node with key '206' (Efficient Loader) not found in the workflow.");
  }

  // Update the width (key "390")
  if (modifiedWorkflow["390"] && workflow.width) {
    modifiedWorkflow["390"].inputs.Number = workflow.width.toString();
  } else {
    console.warn("Node with key '390' (Width) not found in the workflow or workflow.width is not provided.");
  }

  // Update the height (key "391")
  if (modifiedWorkflow["391"] && workflow.height) {
    modifiedWorkflow["391"].inputs.Number = workflow.height.toString();
  } else {
    console.warn("Node with key '391' (Height) not found in the workflow or workflow.height is not provided.");
  }

  if (modifiedWorkflow["229"]) {
    if (workflow.steps) {
      modifiedWorkflow["229"].inputs.steps = workflow.steps;
    }

    if (workflow.CFGScale) {
      modifiedWorkflow["229"].inputs.cfg = workflow.CFGScale;
    }

    if (workflow.sampler) {
      modifiedWorkflow["229"].inputs.sampler_name = workflow.sampler;
    }

    if (workflow.scheduler) {
      modifiedWorkflow["229"].inputs.scheduler = workflow.scheduler;
    }

    if (workflow.denoise) {
      modifiedWorkflow["229"].inputs.denoise = workflow.denoise;
    }

    if (workflow.customSeedEnabled && workflow.customSeed) {
      modifiedWorkflow["229"].inputs.seed = workflow.customSeed;
    }
  }

  if (modifiedWorkflow["207"]) {
    const loraInputs = modifiedWorkflow["207"].inputs;
    let enabledLoraCount = 0;
  
    // Iterate through workflow loras
    workflow.loras.forEach((lora, index) => {
      if (index < 5) {  // Ensure we only process up to 5 LoRAs
        const i = index + 1;
        if (lora.enabled) {
          // If lora is enabled, set its model and parameters in modifiedWorkflow
          loraInputs[`lora_name_${i}`] = lora.model;
          loraInputs[`lora_wt_${i}`] = lora.weightType;
          loraInputs[`model_str_${i}`] = 1;  // Default value, adjust if needed
          loraInputs[`clip_str_${i}`] = 1;   // Default value, adjust if needed
          enabledLoraCount++;
        } else {
          // If lora is disabled, set the modifiedWorkflow model to "None"
          loraInputs[`lora_name_${i}`] = "None";
          loraInputs[`lora_wt_${i}`] = 0;
          loraInputs[`model_str_${i}`] = 1;
          loraInputs[`clip_str_${i}`] = 1;
        }
      }
    });
  
    // Handle LoRA stack
    if (enabledLoraCount === 0) {
      // Remove lora_stack if no LoRAs are enabled
      if (modifiedWorkflow["206"] && modifiedWorkflow["206"].inputs.lora_stack) {
        delete modifiedWorkflow["206"].inputs.lora_stack;
      }
    } else {
      // Check if lora_stack exists in 206 and add 207 to it
      if (modifiedWorkflow["206"]) {
        if (!modifiedWorkflow["206"].inputs.lora_stack) {
          modifiedWorkflow["206"].inputs.lora_stack = ["207", 0];
        } else if (!modifiedWorkflow["206"].inputs.lora_stack.includes("207")) {
          modifiedWorkflow["206"].inputs.lora_stack.unshift("207");
        }
      }
    }
  
    // Update LoRA in 206
    if (modifiedWorkflow["206"]) {
      const firstEnabledLora = workflow.loras.find(lora => lora.enabled);
      modifiedWorkflow["206"].inputs.lora_name = firstEnabledLora ? firstEnabledLora.model : "None";
    }
  }

  if (modifiedWorkflow["436"]) {
    if (workflow.controlnet.enabled) {
      // Check if cnet_stack exists in 206 and add cnet (288) to it
      if (modifiedWorkflow["206"]) {
        if (!modifiedWorkflow["206"].inputs.cnet_stack) {
          modifiedWorkflow["206"].inputs.cnet_stack = ["436", 0];
        } else if (!modifiedWorkflow["206"].inputs.cnet_stack.includes("436")) {
          modifiedWorkflow["206"].inputs.cnet_stack.unshift("436");
        }

        // TODO: bring new controlnet dimensions
        if (workflow.useControlnetDims) {
          // If controlnet dimensions are enabled use controlnet image dims
          modifiedWorkflow["206"].inputs.empty_latent_width = ["442", 0];
          modifiedWorkflow["206"].inputs.empty_latent_height = ["442", 1];
        } else {
          // If controlnet dimensions are not enabled use user's dims
          modifiedWorkflow["206"].inputs.empty_latent_width = ["390", 0];
          modifiedWorkflow["206"].inputs.empty_latent_height = ["391", 0];
        }
      }

      // Check if image in 288 exists and addopenpose (294), dwpose (295), canny (290) or midas (289) to it
      if (modifiedWorkflow["436"]) {
        console.log("MODIFIED WORKFLOW 288:", modifiedWorkflow["436"].inputs)
        if (!modifiedWorkflow["436"].inputs.image) {
          modifiedWorkflow["436"].inputs.image = ["", 0];
        } else if (!modifiedWorkflow["436"].inputs.image.includes("")) {
          modifiedWorkflow["436"].inputs.image.unshift("");
        }

        // Add the respective number to the input.image in the place where "" are
        switch (workflow.controlnet.model) {
          case "midas":
            modifiedWorkflow["436"].inputs.control_net = ["440", 0]
            modifiedWorkflow["436"].inputs.image = ["289", 0];
            break;
          case "canny":
            modifiedWorkflow["436"].inputs.control_net = ["284", 0]
            modifiedWorkflow["436"].inputs.image = ["290", 0];
            break;
          case "openpose":
            modifiedWorkflow["436"].inputs.control_net = ["439", 0]
            modifiedWorkflow["436"].inputs.image = ["294", 0];
            break;
          case "dwpose":
            modifiedWorkflow["436"].inputs.control_net = ["439", 0]
            modifiedWorkflow["436"].inputs.image = ["295", 0];
            break;
        }
        console.log("MODIFIED WORKFLOW 288:", modifiedWorkflow["436"].inputs)
      }

      // attempt pass the path of the uploaded image to the load image (375)
      if (modifiedWorkflow["375"]) {
        modifiedWorkflow["375"].inputs.image = downloadedFiles.controlnet
      }
    } else if (modifiedWorkflow["206"]) {
      // If controlnet is disabled use user's dims
      modifiedWorkflow["206"].inputs.empty_latent_width = ["390", 0];
      modifiedWorkflow["206"].inputs.empty_latent_height = ["391", 0];

      // Attempt to remove cnet stack from 206
      if (modifiedWorkflow["206"] && modifiedWorkflow["206"].inputs.cnet_stack) {
        delete modifiedWorkflow["206"].inputs.cnet_stack;
      }
    }
  }

  if (workflow.refinement && workflow.refinement.enabled) {
    modifiedWorkflow["443"] = {
      inputs: {
        seed: workflow.refinement.customSeedEnabled ? workflow.refinement.customSeed : Math.floor(Math.random() * 4294967295),
        steps: workflow.refinement.steps || 20,
        cfg: workflow.refinement.CFGScale || 7,
        sampler_name: workflow.refinement.sampler || "euler",
        scheduler: workflow.refinement.scheduler || "normal",
        denoise: workflow.refinement.denoise || 0.5,
        preview_method: "auto",
        vae_decode: "true",
        model: ["229", 0],
        positive: ["229", 1],
        negative: ["229", 2],
        latent_image: ["229", 3],
        optional_vae: ["229", 4]
      },
      class_type: "KSampler (Efficient)",
      _meta: {
        title: "KSampler (Efficient) Refinement"
      }
    }
  } else {
    // Remove 443 component if it exists and refinement is disabled
    if (modifiedWorkflow["443"]) {
      delete modifiedWorkflow["443"];
    }
  }

  if (workflow.upscaler && workflow.upscaler.enabled) {
    // Add 314 component if it doesn't exist
    modifiedWorkflow["314"] = {
      inputs: {
        upscale_by: workflow.upscaler.upscaleBy || 2,
        seed: workflow.upscaler.customSeedEnabled ? workflow.upscaler.customSeed : Math.floor(Math.random() * 4294967295),
        steps: workflow.upscaler.steps || 30,
        cfg: workflow.upscaler.CFGScale || 8,
        sampler_name: workflow.upscaler.sampler || "euler",
        scheduler: workflow.upscaler.scheduler || "normal",
        denoise: workflow.upscaler.denoise || 0.15,
        control_after_generate: workflow.upscaler.CAG || "randomize",
        mode_type: "Linear",
        tile_width: 512,
        tile_height: 512,
        mask_blur: 8,
        tile_padding: 32,
        seam_fix_mode: "None",
        seam_fix_denoise: 1,
        seam_fix_width: 64,
        seam_fix_mask_blur: 8,
        seam_fix_padding: 16,
        force_uniform_tiles: true,
        tiled_decode: false,
        image: [
          (workflow.refinement && workflow.refinement.enabled) ? "443" : "229",
          5
        ],
        model: [
          (workflow.refinement && workflow.refinement.enabled) ? "443" : "229",
          0
        ],
        positive: [
          (workflow.refinement && workflow.refinement.enabled) ? "443" : "229",
          1
        ],
        negative: [
          (workflow.refinement && workflow.refinement.enabled) ? "443" : "229",
          2
        ],
        vae: [
          (workflow.refinement && workflow.refinement.enabled) ? "443" : "229",
          4
        ],
        upscale_model: [
          "318",
          0
        ]
      },
      class_type: "UltimateSDUpscale",
      _meta: {
        "title": "Ultimate SD Upscale"
      }
    };
  } else {
    // Remove 314 component if it exists and upscaler is disabled
    if (modifiedWorkflow["314"]) {
      delete modifiedWorkflow["314"];
    }
  }

  // if upscaler is enabled
  if (workflow.upscaler && workflow.upscaler.enabled && modifiedWorkflow["313"]) {
    modifiedWorkflow["313"].inputs.images = ["314", 0];
  } // Set 313 image component images to ["443", 5]
  else if (workflow.refinement && workflow.refinement.enabled && modifiedWorkflow["313"]) {
    modifiedWorkflow["313"].inputs.images = ["443", 5];
  } // If refinement and upscaler are disabled, set 313 image component images to ["229", 0]
  else {
    modifiedWorkflow["313"].inputs.images = ["229", 5];
  }

  fsfs.writeFileSync('modified_workflow.json', JSON.stringify(modifiedWorkflow, null, 2), 'utf8');
  return modifiedWorkflow;
}

export async function processComfy(
  downloadedFiles: {
    ipas: string[];
    controlnet: string | null;
    upscaler: string | null;
  },
  workflow: ComfyGenerateType
): Promise<string[]> {
  console.log('STARTING: processComfy function');

  // TODO: paste available paths into the workflow and
  //       based on the worflow sent from the backend 
  //       modify the workflow json sent to the comfy
  // Read the workflow.json file
  const workflowPath = path.join(process.cwd(), 'src/workflow.json');
  console.log(`Reading workflow from: ${workflowPath}`);

  let workflowJson = JSON.parse(await fs.readFile(workflowPath, 'utf-8'));
  console.log('Workflow JSON loaded');

  workflowJson = modifyWorkflow(workflowJson, workflow, downloadedFiles);
  
  try {
    console.log(`Connecting to WebSocket: ws://${serverAddress}/ws?clientId=${clientId}`);
    const ws = new WebSocket(`ws://${serverAddress}/ws?clientId=${clientId}`);

    return new Promise((resolve, reject) => {
      ws.on('open', async () => {
        console.log('WebSocket connection opened');
        try {
          console.log('Starting image generation');
          const images = await getImages(ws, workflowJson);
          console.log(`Image generation completed, received ${images.length} images`);
          const savedImagePaths = await saveImages(images);
          console.log('Image saving completed');
          resolve(savedImagePaths);
        } catch (error) {
          console.error('Error in image generation:', error);
          reject(error);
        } finally {
          console.log('Closing WebSocket connection');
          ws.close();
        }
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      });

      ws.on('close', () => {
        console.log('WebSocket connection closed');
      });
    });
  } catch (e) {
    console.error(`ERROR IN processComfy: ${e}`);
    throw e;
  } finally {
    console.log('ENDING: processComfy function');
  }
}