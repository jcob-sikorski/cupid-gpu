import { ComfyGenerateType } from "./comfy-schema";

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';

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
      console.log(`Message received: ${data.toString('hex')}`);
      
      let messageString: string;
      if (data instanceof Buffer) {
        messageString = data.toString('utf-8');
        console.log(`Converted buffer to string: ${messageString}`);
      } else if (typeof data === 'string') {
        messageString = data;
      } else {
        console.log('Received unknown data type from WebSocket');
        return;
      }

      try {
        const message = JSON.parse(messageString);
        console.log(`Parsed message: ${JSON.stringify(message)}`);

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
  const workflowJson = await fs.readFile(workflowPath, 'utf-8');
  let workflowData = JSON.parse(workflowJson);
  console.log('Workflow JSON loaded:', JSON.stringify(workflowData, null, 2));
  
  try {
    console.log(`Connecting to WebSocket: ws://${serverAddress}/ws?clientId=${clientId}`);
    const ws = new WebSocket(`ws://${serverAddress}/ws?clientId=${clientId}`);

    return new Promise((resolve, reject) => {
      ws.on('open', async () => {
        console.log('WebSocket connection opened');
        try {
          console.log('Starting image generation');
          const images = await getImages(ws, workflowData);
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