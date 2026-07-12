import { existsSync } from 'fs';
import { join } from 'path';
import log from 'electron-log';
import { getModelCachePath } from './aiConfig';

/** 中英翻译模型 ID，用于将中文查询翻译成英文以匹配英文 CLIP 向量空间 */
const TRANSLATE_MODEL_ID = 'Xenova/opus-mt-zh-en';
/** 单次翻译超时时间，超时返回 null 由调用方降级 */
const TRANSLATE_TIMEOUT_MS = 3000;
/** LRU 缓存上限：用户搜索词重复率高，缓存命中后零延迟 */
const CACHE_MAX_SIZE = 500;

/**
 * 中英翻译服务：基于 Xenova/opus-mt-zh-en（Helsinki NLP MarianMT 量化版）。
 *
 * 设计要点：
 * - 懒加载：首次中文搜索时才加载模型，不影响英文搜索和启动速度
 * - LRU 缓存：搜索词重复率高，命中后零延迟
 * - 超时降级：单次翻译超过 3s 放弃，回退到中文直查
 * - 失败降级：模型缺失/加载失败/翻译出错均返回 null，调用方负责回退
 */
export class TranslateService {
  private dataPath: string;
  private bundledModelPath?: string;
  // 用 pipeline API（内部封装 tokenizer + model + generate + decode）
  private translator: any = null;
  private ready = false;
  private initFailed = false;
  private initPromise?: Promise<void>;
  // LRU 缓存：Map 按插入顺序迭代，淘汰时删第一个
  private cache = new Map<string, string>();
  // 推理互斥锁：与 embedding 服务共享 ONNX session 线程，串行化避免并发崩溃
  private inferenceChain: Promise<unknown> = Promise.resolve();

  constructor(dataPath: string, bundledModelPath?: string) {
    this.dataPath = dataPath;
    this.bundledModelPath = bundledModelPath;
  }

  async init(): Promise<void> {
    if (this.ready || this.initFailed) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().finally(() => { this.initPromise = undefined; });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const transformers = await new Function('return import("@xenova/transformers")')() as typeof import('@xenova/transformers');

    if (this.bundledModelPath) {
      const modelDir = join(this.bundledModelPath, TRANSLATE_MODEL_ID);
      if (!existsSync(modelDir)) {
        log.warn('[Translate] 翻译模型不存在，中文搜索将降级为中文直查:', modelDir);
        this.initFailed = true;
        return;
      }
      transformers.env.localModelPath = this.bundledModelPath;
      transformers.env.allowRemoteModels = false;
    } else {
      transformers.env.cacheDir = getModelCachePath(this.dataPath);
    }

    log.info('[Translate] 开始加载翻译模型:', TRANSLATE_MODEL_ID);

    try {
      this.translator = await transformers.pipeline('translation', TRANSLATE_MODEL_ID, { quantized: true });
      this.ready = true;
      log.info('[Translate] 翻译模型加载完成');
    } catch (error) {
      this.initFailed = true;
      log.warn('[Translate] 翻译模型加载失败，中文搜索将降级为中文直查:', error);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * 将中文文本翻译成英文。失败或超时返回 null，调用方应回退到中文直查。
   * 结果会缓存，相同输入第二次调用零延迟。
   */
  async translate(zhText: string): Promise<string | null> {
    const trimmed = zhText.trim();
    if (!trimmed) return null;

    const cached = this.cache.get(trimmed);
    if (cached !== undefined) return cached;

    if (!this.ready) {
      if (this.initFailed) return null;
      try {
        await this.init();
      } catch {
        return null;
      }
      if (!this.ready) return null;
    }

    try {
      const result = await Promise.race([
        this.doTranslate(trimmed),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TRANSLATE_TIMEOUT_MS)),
      ]);
      if (result !== null) {
        this.setCache(trimmed, result);
      }
      return result;
    } catch (error) {
      log.warn('[Translate] 翻译失败，降级处理:', error);
      return null;
    }
  }

  private async doTranslate(zhText: string): Promise<string | null> {
    return this.runExclusive(async () => {
      const output = await this.translator(zhText, {
        max_new_tokens: 50,
        num_beams: 4,
      });
      const text = output?.[0]?.translation_text?.trim() ?? '';
      return text || null;
    });
  }

  private setCache(key: string, value: string): void {
    if (this.cache.size >= CACHE_MAX_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

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

  /** 卸载模型并清空缓存，下次 init() 会重新加载 */
  reset(): void {
    // pipeline 内部封装了 model 和 tokenizer，通过其属性释放原生内存
    this.translator?.model?.dispose?.();
    this.translator?.tokenizer?.dispose?.();
    this.translator = null;
    this.ready = false;
    this.initFailed = false;
    this.initPromise = undefined;
    this.cache.clear();
    log.info('[Translate] 翻译服务已重置');
  }
}
