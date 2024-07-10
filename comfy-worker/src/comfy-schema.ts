import { z } from "zod";

const imageBase64Separator = ";base64,";

const ModelEnum = z.enum([
  "amIReal_V44.safetensors",
  "analogMadness_v60.safetensors",
  "chilloutmix_NiPrunedFp32Fix.safetensors",
  "consistentFactor_euclidV61.safetensors",
  "devlishphotorealism_v40.safetensors",
  "dreamshaper_8.safetensors",
  "edgeOfRealism_eorV20Fp16BakedVAE.safetensors",
  "epicphotogasm_amateurreallife.safetensors",
  "epicphotogasm_lastUnicorn.safetensors",
  "epicphotogasm_ultimateFidelity.safetensors",
  "epicrealism_naturalSinRC1.safetensors",
  "epicrealism_newCentury.safetensors",
  "juggernautXL_v8Rundiffusion.safetensors",
  "juggernaut_reborn.safetensors",
  "lazymixRealAmateur_v30b.safetensors",
  "metagodRealRealism_v10.safetensors",
  "realismEngineSDXL_v10.safetensors",
  "realisticVisionV51_v51VAE.safetensors",
  "stablegramUSEuropean_v21.safetensors",
  "uberRealisticPornMerge_urpmv13.safetensors"
]);

export type ModelEnumType = z.infer<typeof ModelEnum>;

const SamplerEnum = z.enum([
  "euler",
  "euler_cfg_pp",
  "euler_ancestral",
  "euler_ancestral_cfg_pp",
  "heun",
  "heunpp2",
  "dpm_2",
  "dpm_2_ancestral",
  "lms",
  "dpm_fast",
  "dpm_adaptive",
  "dpmpp_2s_ancestral",
  "dpmpp_sde",
  "dpmpp_sde_gpu",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_2m_sde_gpu",
  "dpmpp_3m_sde",
  "dpmpp_3m_sde_gpu",
  "ddpm",
  "lcm",
  "ipndm",
  "ipndm_v",
  "deis",
  "ddim",
  "uni_pc",
  "uni_pc_bh2"
]);

export type SamplerEnumType = z.infer<typeof SamplerEnum>;

const WeightTypeEnum = z.enum([
  "linear",
  "ease in",
  "ease out",
  "ease in-out",
  "reverse in-out",
  "weak input",
  "weak output",
  "weak middle",
  "strong middle",
  "style transfer",
  "composition",
  "strong style transfer",
  "style and composition",
  "style transfer precise"
]);

export type WeightEnumType = z.infer<typeof WeightTypeEnum>;

const SchedulerEnum = z.enum([
  "normal",
  "karras",
  "exponential",
  "sgm_uniform",
  "simple",
  "ddim_uniform",
  "AYS SD1",
  "AYS SDXL",
  "AYS SVD"
]);

export type SchedulerEnumType = z.infer<typeof SchedulerEnum>;

const CAGEnum = z.enum([
  "fixed",
  "increment",
  "decrement",
  "randomize"
]);

export type CAGEnumType = z.infer<typeof CAGEnum>;

const LoraModelEnum = z.enum([
  "DarkLighting.safetensors",
  "Transparent_Clothes_V2.safetensors",
  "add_detail.safetensors",
  "age_slider_v20.safetensors",
  "amateurMadness-05.safetensors",
  "analogFilmPhotography_10.safetensors",
  "backlight_slider_v10.safetensors",
  "beard_slider_v10.safetensors",
  "breasts_slider_v10.safetensors",
  "contrast_slider_v10.safetensors",
  "curly_hair_slider_v1.safetensors",
  "depth_of_field_slider_v1.safetensors",
  "detail_slider_v4.safetensors",
  "emotion_happy_slider_v1.safetensors",
  "epiCRealLife.safetensors",
  "epiCRealismHelper.safetensors",
  "amateurMadness-05.safetensors",
  "epiNoiseoffset_v2.pt",
  "epiNoiseoffset_v2Pynoise.safetensors",
  "exposure_control_v10.safetensors",
  "eyebrows_slider_v2.safetensors",
  "filmgrain_slider_v1.safetensors",
  "fisheye_slider_v10.safetensors",
  "gender_slider_v1.safetensors",
  "hair_length_slider_v1.safetensors",
  "ip-adapter-faceid-plus_sd15_lora.safetensors",
  "ip-adapter-faceid-plusv2_sd15_lora.safetensors",
  "ip-adapter-faceid_sd15_lora.safetensors",
  "light_control_ud_civitai_v10.safetensors",
  "light_slider_LR_v10.safetensors",
  "locon_perfecteyes_v1_from_v1_64_32.safetensors",
  "lora_perfecteyes_v1_from_v1_160.safetensors",
  "lyco_humans_v10.safetensors",
  "muscle_slider_v1.safetensors",
  "people_count_slider_v1.safetensors",
  "saturation_slider_v1.safetensors",
  "sjtune.safetensors",
  "skin_tone_slider_v1.safetensors",
  "summer.safetensors",
  "time_slider_v1.safetensors",
  "weight_slider_v2.safetensors",
  "yaslo.safetensors"
]);

export type LoraEnumType = z.infer<typeof LoraModelEnum>;

const ControlnetEnum = z.enum([
  "midas",
  "ip2p",
  "canny",
  "openpose"
]);

export type ControlnetEnumType = z.infer<typeof ControlnetEnum>;

export const loraSchema = z.object({
  enabled: z.boolean(),
  model: LoraModelEnum,
  weightType: z.number().min(-10).max(10).step(0.01),
});

const ipaSchema = z.object({
  enabled: z.boolean(),
  file: z.instanceof(File).optional(),
  fileKey: z.string().optional(),
  image: z.string().optional(),
  weight: z.number().min(-1).max(5).step(0.01),
  weightType: WeightTypeEnum,
  startingStep: z.number().min(0).max(1).step(0.001),
  endingStep: z.number().min(0).max(1).step(0.001),
  airCodeEnabled: z.boolean().optional(),
  airCode: z.string().optional(),
  useForAll: z.boolean().optional(),
});

export const controlnetSchema = z
  .object({
    enabled: z.boolean(),
    file: z.instanceof(File).optional(),
    fileKey: z.string().optional(),
    image: z.string().optional(),
    model: z.string().optional(),
    strength: z.number().min(0).max(10).step(0.01),
    startPercent: z.number().min(0).max(1).step(0.01),
    endPercent: z.number().min(0).max(1).step(0.01),
  })

export const refinementSchema = z
  .object({
    enabled: z.boolean(),
    steps: z.number().min(1).max(50).step(1),
    CFGScale: z.number().min(1).max(8).step(1),
    sampler: SamplerEnum,
    scheduler: SchedulerEnum,
    denoise: z.number().min(0).max(1).step(0.01),
    customSeedEnabled: z.boolean(),
    customSeed: z.number().optional(),
    airCodeEnabled: z.boolean(),
    airCode: z.string().optional(),
  })

  export const upscalerSchema = z
  .object({
    enabled: z.boolean(),
    file: z.instanceof(File).optional(),
    fileKey: z.string().optional(),
    image: z.string().optional(),
    steps: z.number().min(1).max(50).step(1),
    CFGScale: z.number().min(1).max(8).step(1),
    sampler: SamplerEnum,
    scheduler: SchedulerEnum,
    denoise: z.number().min(0).max(1).step(0.01),
    customSeedEnabled: z.boolean(),
    customSeed: z.number().optional(),
    CAG: CAGEnum,
    upscaleBy: z.number().min(0).max(2).step(0.01),
    airCodeEnabled: z.boolean(),
    airCode: z.string().optional(),
  })

export const generateImageSchema = z.object({
  posPrompt: z.string().min(1, { message: "Prompt must contain at least 1 character" }),
  negPrompt: z.string().optional(),
  model: ModelEnum,
  useIPADims: z.boolean(),
  ipaDimensionSource: z.enum(["IPA1", "IPA2", "IPA3"]).optional(),
  height: z.number().int().min(512).max(1024),
  width: z.number().int().min(512).max(1024),
  batchSize: z.number().min(1).max(16).step(1),
  steps: z.number().min(1).max(50).step(1),
  CFGScale: z.number().min(1).max(8).step(1),
  sampler: SamplerEnum,
  scheduler: SchedulerEnum,
  denoise: z.number().min(0).max(1).step(0.01),
  clipSkip: z.number().min(-2).max(-1).step(1),
  CAG: CAGEnum,
  customSeedEnabled: z.boolean(),
  customSeed: z.number().optional(),
  airCodeEnabled: z.boolean(),
  airCode: z.string().optional(),
  ipas: z.array(ipaSchema),
  controlnet: controlnetSchema,
  refinement: refinementSchema,
  upscaler: upscalerSchema,
  loras: z.array(loraSchema),
});

// Define the type based on the schema
export type ComfyGenerateType = z.infer<typeof generateImageSchema>;