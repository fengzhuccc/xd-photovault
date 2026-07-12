import log from 'electron-log';
import type { DatabaseService, PhotoRow } from './database';
import { AiEmbeddingService } from './aiEmbedding';
import type { TranslateService } from './translateService';
import { getAiConfig } from './aiConfig';

export interface AiSearchResult {
  photo: PhotoRow;
  similarity: number;
}

interface CacheEntry {
  photo: PhotoRow;
  embedding: Float32Array;
}

/** 单条查询及其对应的相似度阈值 */
interface QueryPlan {
  text: string;
  threshold: number;
  /** 标记来源，用于日志 */
  label: string;
}

export class AiSearchService {
  private db: DatabaseService;
  private embeddingService: AiEmbeddingService;
  private translateService?: TranslateService;
  // embedding 内存缓存，避免每次搜索都全表加载
  private cache: CacheEntry[] | null = null;
  private cacheModel: string | null = null;

  constructor(
    db: DatabaseService,
    dataPath: string,
    embeddingService?: AiEmbeddingService,
    translateService?: TranslateService,
  ) {
    this.db = db;
    this.embeddingService = embeddingService ?? new AiEmbeddingService(dataPath);
    this.translateService = translateService;
  }

  async init(): Promise<void> {
    await this.embeddingService.init();
  }

  isReady(): boolean {
    return this.embeddingService.isReady();
  }

  /** 索引完成后调用，清除缓存使下次搜索重新加载 */
  invalidateCache(): void {
    if (this.cache !== null) {
      this.cache = null;
      this.cacheModel = null;
      log.info('[AI] 搜索缓存已失效，下次搜索将重新加载');
    }
  }

  async search(query: string, limit: number = 50): Promise<AiSearchResult[]> {
    // L-10: 验证 limit 参数，限制在合理范围内
    const safeLimit = Math.max(1, Math.min(limit, 500));

    if (!this.isReady()) {
      await this.init();
    }

    const config = getAiConfig();
    log.info(`[AI] 语义搜索: "${query}"`);

    const isChinese = hasChinese(query);
    const augmentedQuery = augmentQuery(query);

    // 构建查询计划：中文查询时尝试翻译成英文，双语并行查询取 max 相似度
    const plans: QueryPlan[] = [{
      text: augmentedQuery,
      // 中文查询的英文 CLIP 打分普遍偏低，用低阈值保证召回
      threshold: isChinese ? Math.min(config.searchMinSimilarity, 0.18) : config.searchMinSimilarity,
      label: isChinese ? 'zh' : 'en',
    }];

    let translatedText: string | null = null;
    if (isChinese && config.enableTranslation && this.translateService) {
      try {
        translatedText = await this.translateService.translate(query);
      } catch (error) {
        log.warn('[AI] 翻译异常，仅用中文查询:', error);
      }
      if (translatedText) {
        plans.push({
          text: `a photo of ${translatedText}`,
          threshold: config.searchMinSimilarity,
          label: 'translated-en',
        });
      }
    }

    log.info(
      `[AI] 查询计划: 原始="${query}", 翻译="${translatedText ?? 'N/A'}', ` +
      `查询数=${plans.length}, ` +
      plans.map(p => `${p.label}(阈值${p.threshold})`).join(' | ')
    );

    // 对每个查询编码向量（encodeText 内部有互斥锁，会串行执行）
    const textEmbeddings = await Promise.all(
      plans.map(p => this.embeddingService.encodeText(p.text))
    );

    // 加载或复用 embedding 缓存
    if (this.cache === null || this.cacheModel !== config.model) {
      this.cache = this.db.getAllEmbeddings(config.model);
      this.cacheModel = config.model;
      log.info(`[AI] 搜索缓存已加载: ${this.cache.length} 条 embedding`);
    }

    const results: AiSearchResult[] = [];
    for (const entry of this.cache) {
      // 多查询并行：任一查询超过其阈值即命中，相似度取最大值用于排序
      let maxSim = -Infinity;
      let hit = false;
      for (let i = 0; i < textEmbeddings.length; i++) {
        const sim = cosineSimilarity(textEmbeddings[i], entry.embedding);
        if (sim > maxSim) maxSim = sim;
        if (sim >= plans[i].threshold) hit = true;
      }
      if (hit) {
        results.push({ photo: entry.photo, similarity: maxSim });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, safeLimit);
  }
}

/**
 * 判断查询是否包含中文字符。
 * 用于中文查询时降低相似度阈值，因为英文 CLIP 对中文的打分普遍偏低。
 */
function hasChinese(query: string): boolean {
  return /[\u4e00-\u9fa5]/.test(query);
}

/**
 * 对搜索查询做提示工程增强，让 CLIP 的文本编码更接近训练分布。
 * 中文查询使用 "{query} 的照片"，其他语言使用 "a photo of {query}"。
 */
function augmentQuery(query: string): string {
  const trimmed = query.trim();
  if (hasChinese(trimmed)) {
    return `${trimmed} 的照片`;
  }
  // 英文/其他语言使用 CLIP 训练时更常见的描述句式
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('a photo of') || lower.startsWith('an image of') || lower.startsWith('picture of')) {
    return trimmed;
  }
  return `a photo of ${trimmed}`;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += (a[i] || 0) * (b[i] || 0);
  }
  // embedding 已归一化，dot 即 cosine
  return dot;
}
