import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import log from 'electron-log';
import { getAiConfig, getModelCachePath, type AiModelConfig } from './aiConfig';

export class AiEmbeddingService {
  private config: AiModelConfig;
  private dataPath: string;
  private bundledModelPath?: string;
  private tokenizer: any = null;
  private textModel: any = null;
  private processor: any = null;
  private visionModel: any = null;
  private ready = false;
  private actualExecutionProvider = 'cpu';

  constructor(dataPath: string, bundledModelPath?: string, config?: Partial<AiModelConfig>) {
    this.dataPath = dataPath;
    this.bundledModelPath = bundledModelPath;
    this.config = { ...getAiConfig(), ...(config || {}) };
  }

  getActualExecutionProvider(): string {
    return this.actualExecutionProvider;
  }

  async init(): Promise<void> {
    if (this.ready) return;

    // 使用运行时 import() 绕过 TypeScript CommonJS 编译，避免 require() ESM 模块失败
    const transformers = await new Function('return import("@xenova/transformers")')() as typeof import('@xenova/transformers');

    // 根据配置尝试使用 GPU
    if (this.config.useGpu) {
      this.setupGpuExecutionProvider(transformers);
    }

    if (this.bundledModelPath) {
      // 使用内置模型，避免运行时从 Hugging Face 下载
      const modelDir = join(this.bundledModelPath, this.config.model);
      if (!existsSync(modelDir)) {
        throw new Error(
          `内置 AI 模型不存在: ${modelDir}\n` +
          `请先运行 npm run download:ai-model 下载模型，再重新打包应用。`
        );
      }
      transformers.env.localModelPath = this.bundledModelPath;
      transformers.env.allowRemoteModels = false;
      log.info('[AI] 使用内置模型:', this.config.model);
    } else {
      // 回退到在线下载（保留旧行为，便于测试）
      const cachePath = getModelCachePath(this.dataPath);
      if (!existsSync(cachePath)) {
        mkdirSync(cachePath, { recursive: true });
      }
      transformers.env.cacheDir = cachePath;
      log.info('[AI] 使用在线模型:', this.config.model);
    }

    log.info('[AI] 开始加载模型:', this.config.model, '目标执行器:', this.actualExecutionProvider);

    try {
      // 同时加载文本和图像模型组件
      [this.tokenizer, this.textModel, this.processor, this.visionModel] = await Promise.all([
        transformers.AutoTokenizer.from_pretrained(this.config.model),
        transformers.CLIPTextModelWithProjection.from_pretrained(this.config.model, { quantized: true }),
        transformers.AutoProcessor.from_pretrained(this.config.model),
        transformers.CLIPVisionModelWithProjection.from_pretrained(this.config.model, { quantized: true }),
      ]);
    } catch (error) {
      if (this.config.useGpu) {
        log.warn('[AI] GPU 加载模型失败，尝试回退到 CPU:', error);
        this.setupCpuExecutionProvider(transformers);
        [this.tokenizer, this.textModel, this.processor, this.visionModel] = await Promise.all([
          transformers.AutoTokenizer.from_pretrained(this.config.model),
          transformers.CLIPTextModelWithProjection.from_pretrained(this.config.model, { quantized: true }),
          transformers.AutoProcessor.from_pretrained(this.config.model),
          transformers.CLIPVisionModelWithProjection.from_pretrained(this.config.model, { quantized: true }),
        ]);
      } else {
        throw error;
      }
    }

    this.ready = true;
    log.info('[AI] 模型加载完成，实际执行器:', this.actualExecutionProvider);
  }

  isReady(): boolean {
    return this.ready;
  }

  /** 卸载已加载的模型，下次 init() 会按最新配置重新加载 */
  reset(): void {
    this.tokenizer = null;
    this.textModel = null;
    this.processor = null;
    this.visionModel = null;
    this.ready = false;
    this.actualExecutionProvider = 'cpu';
    log.info('[AI] 模型状态已重置，下次加载将使用新配置');
  }

  async encodeText(text: string): Promise<Float32Array> {
    if (!this.tokenizer || !this.textModel) {
      throw new Error('AI 模型尚未加载，请先调用 init()');
    }
    const inputs = this.tokenizer(text, { padding: true, truncation: true });
    const { text_embeds } = await this.textModel(inputs);
    return normalizeVector(new Float32Array(text_embeds.data));
  }

  async encodeImage(imagePath: string): Promise<Float32Array> {
    if (!this.processor || !this.visionModel) {
      throw new Error('AI 模型尚未加载，请先调用 init()');
    }
    const transformers = await new Function('return import("@xenova/transformers")')() as typeof import('@xenova/transformers');
    const image = await transformers.RawImage.read(imagePath);
    const inputs = await this.processor(image);
    const { image_embeds } = await this.visionModel(inputs);
    return normalizeVector(new Float32Array(image_embeds.data));
  }

  /** 批量编码图片，降低模型加载开销 */
  async encodeImages(imagePaths: string[]): Promise<Float32Array[]> {
    if (!this.processor || !this.visionModel) {
      throw new Error('AI 模型尚未加载，请先调用 init()');
    }
    const transformers = await new Function('return import("@xenova/transformers")')() as typeof import('@xenova/transformers');
    const images = await Promise.all(imagePaths.map((p) => transformers.RawImage.read(p)));
    const inputs = await this.processor(images);
    const { image_embeds } = await this.visionModel(inputs);
    return splitBatchEmbeddings(image_embeds.data, imagePaths.length, this.config.embeddingDim);
  }

  private setupGpuExecutionProvider(transformers: typeof import('@xenova/transformers')): void {
    const onnxBackend = transformers.env.backends.onnx as unknown as {
      executionProviders: string[];
    } | undefined;
    if (!onnxBackend) {
      log.warn('[AI] 无法获取 ONNX backend，继续使用 CPU');
      this.actualExecutionProvider = 'cpu';
      return;
    }

    // Windows 上使用 DirectML（已包含在 onnxruntime-node 包中），失败会自动回退 CPU
    const gpuProvider = 'dml';

    // 将 DirectML 放到最高优先级，保留 CPU fallback
    const providers = (onnxBackend.executionProviders ?? []).filter((p) => p !== gpuProvider);
    providers.unshift(gpuProvider);
    onnxBackend.executionProviders = providers;
    this.actualExecutionProvider = gpuProvider;

    log.info('[AI] 已设置 GPU 执行器:', gpuProvider, '可用执行器:', onnxBackend.executionProviders);
  }

  private setupCpuExecutionProvider(transformers: typeof import('@xenova/transformers')): void {
    const onnxBackend = transformers.env.backends.onnx as unknown as {
      executionProviders: string[];
    } | undefined;
    if (onnxBackend) {
      onnxBackend.executionProviders = ['cpu', 'wasm'];
    }
    this.actualExecutionProvider = 'cpu';
    this.config.useGpu = false;
  }
}

function normalizeVector(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const result = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    result[i] = vec[i] / norm;
  }
  return result;
}

function splitBatchEmbeddings(data: Float32Array, batchSize: number, dim: number): Float32Array[] {
  const results: Float32Array[] = [];
  for (let i = 0; i < batchSize; i++) {
    const slice = data.subarray(i * dim, (i + 1) * dim);
    results.push(normalizeVector(new Float32Array(slice)));
  }
  return results;
}


