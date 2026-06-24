import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import log from 'electron-log';
import sharp from 'sharp';
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
  // 推理互斥锁：索引和搜索共享同一模型实例，串行化推理避免 ONNX session 并发崩溃
  private inferenceChain: Promise<unknown> = Promise.resolve();
  // init in-flight promise，防止并发 init 重复加载模型
  private initPromise?: Promise<void>;

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
    // 复用 in-flight promise，防止并发 init 重复加载模型
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().finally(() => { this.initPromise = undefined; });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {

    // 加载前刷新全局配置，确保 GPU 开关等设置变更后立即生效
    this.config = getAiConfig();

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
    // M-15: 尝试释放 ONNX 模型的原生内存
    this.tokenizer?.dispose?.();
    this.textModel?.dispose?.();
    this.processor?.dispose?.();
    this.visionModel?.dispose?.();
    this.tokenizer = null;
    this.textModel = null;
    this.processor = null;
    this.visionModel = null;
    this.ready = false;
    this.actualExecutionProvider = 'cpu';
    // 清除 in-flight promise，允许重新 init
    this.initPromise = undefined;
    log.info('[AI] 模型状态已重置，下次加载将使用新配置');
  }

  async encodeText(text: string): Promise<Float32Array> {
    if (!this.tokenizer || !this.textModel) {
      throw new Error('AI 模型尚未加载，请先调用 init()');
    }
    return this.runExclusive(async () => {
      const inputs = this.tokenizer(text, { padding: true, truncation: true });
      const { text_embeds } = await this.textModel(inputs);
      const result = normalizeVector(new Float32Array(text_embeds.data));
      // H-14: 释放 ONNX Tensor 原生内存
      inputs.dispose?.();
      text_embeds.dispose?.();
      return result;
    });
  }

  async encodeImage(imagePath: string): Promise<Float32Array> {
    if (!this.processor || !this.visionModel) {
      throw new Error('AI 模型尚未加载，请先调用 init()');
    }
    return this.runExclusive(async () => {
      const transformers = await new Function('return import("@xenova/transformers")')() as typeof import('@xenova/transformers');
      const image = await this.readImageWithFallback(imagePath, transformers);
      const inputs = await this.processor(image);
      const { image_embeds } = await this.visionModel(inputs);
      const result = normalizeVector(new Float32Array(image_embeds.data));
      // H-14: 释放 ONNX Tensor 原生内存
      inputs.dispose?.();
      image_embeds.dispose?.();
      return result;
    });
  }

  /** 批量编码图片，降低模型加载开销。单张图片加载失败会被跳过并汇总记录日志。 */
  async encodeImages(imagePaths: string[]): Promise<(Float32Array | null)[]> {
    if (!this.processor || !this.visionModel) {
      throw new Error('AI 模型尚未加载，请先调用 init()');
    }
    return this.runExclusive(async () => {
      const transformers = await new Function('return import("@xenova/transformers")')() as typeof import('@xenova/transformers');

      // 逐个加载图片，单张失败不影响整批
      const failedPaths: string[] = [];
      const loadResults = await Promise.all(
        imagePaths.map(async (path) => {
          try {
            const image = await this.readImageWithFallback(path, transformers);
            return { ok: true as const, image, path };
          } catch (error) {
            failedPaths.push(path);
            return { ok: false as const, path, error };
          }
        })
      );

      // 失败的图片汇总打印一条日志，避免刷屏
      if (failedPaths.length > 0) {
        log.warn(`[AI] 本批次 ${failedPaths.length} 张图片加载失败，已跳过:\n${failedPaths.join('\n')}`);
      }

      const validImages = loadResults.filter((r): r is { ok: true; image: any; path: string } => r.ok).map(r => r.image);

      if (validImages.length === 0) {
        throw new Error('批量图片加载全部失败');
      }

      const inputs = await this.processor(validImages);
      const { image_embeds } = await this.visionModel(inputs);
      const validEmbeddings = splitBatchEmbeddings(image_embeds.data, validImages.length, this.config.embeddingDim);

      // 按原始顺序填充结果，失败的返回 null
      const embeddings: (Float32Array | null)[] = [];
      let validIndex = 0;
      for (const result of loadResults) {
        if (result.ok) {
          embeddings.push(validEmbeddings[validIndex++]);
        } else {
          embeddings.push(null);
        }
      }

      // H-14: 释放 ONNX Tensor 原生内存
      inputs.dispose?.();
      image_embeds.dispose?.();

      return embeddings;
    });
  }

  /** 串行化推理调用，避免索引和搜索并发使用同一 ONNX session */
  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.inferenceChain;
    let resolveNext!: () => void;
    this.inferenceChain = new Promise<void>((resolve) => { resolveNext = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      resolveNext();
    }
  }

  /**
   * 读取图片，先尝试 transformers.RawImage.read（严格模式），
   * 失败后回退到 sharp({ failOnError: false }) 容忍损坏的 JPEG/图片。
   */
  private async readImageWithFallback(
    path: string,
    transformers: typeof import('@xenova/transformers')
  ): Promise<any> {
    try {
      return await transformers.RawImage.read(path);
    } catch (primaryError) {
      // 回退：用 sharp 的 failOnError: false 容忍损坏的 JPEG（如 premature end of data segment）
      try {
        const { data, info } = await sharp(path, { failOnError: false })
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        return new transformers.RawImage(
          new Uint8Array(data),
          info.width,
          info.height,
          info.channels
        );
      } catch {
        // 回退也失败，抛出原始错误
        throw primaryError;
      }
    }
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
