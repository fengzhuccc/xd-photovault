import log from 'electron-log';
import type { DatabaseService, PhotoRow } from './database';
import { AiEmbeddingService } from './aiEmbedding';
import { getAiConfig } from './aiConfig';

export interface AiSearchResult {
  photo: PhotoRow;
  similarity: number;
}

interface CacheEntry {
  photo: PhotoRow;
  embedding: Float32Array;
}

export class AiSearchService {
  private db: DatabaseService;
  private embeddingService: AiEmbeddingService;
  // embedding 内存缓存，避免每次搜索都全表加载
  private cache: CacheEntry[] | null = null;
  private cacheModel: string | null = null;

  constructor(db: DatabaseService, dataPath: string, embeddingService?: AiEmbeddingService) {
    this.db = db;
    this.embeddingService = embeddingService ?? new AiEmbeddingService(dataPath);
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

    const augmentedQuery = augmentQuery(query);
    const isChinese = hasChinese(query);
    // 英文 CLIP 对中文查询的相似度分数普遍偏低，适当降低阈值
    const minSimilarity = isChinese
      ? Math.min(config.searchMinSimilarity, 0.18)
      : config.searchMinSimilarity;
    log.info(`[AI] 语义搜索原始查询: "${query}" -> 增强查询: "${augmentedQuery}" (中文: ${isChinese}, 阈值: ${minSimilarity})`);

    const textEmbedding = await this.embeddingService.encodeText(augmentedQuery);

    // 加载或复用 embedding 缓存
    if (this.cache === null || this.cacheModel !== config.model) {
      this.cache = this.db.getAllEmbeddings(config.model);
      this.cacheModel = config.model;
      log.info(`[AI] 搜索缓存已加载: ${this.cache.length} 条 embedding`);
    }

    const results: AiSearchResult[] = [];
    for (const entry of this.cache) {
      const similarity = cosineSimilarity(textEmbedding, entry.embedding);
      if (similarity >= minSimilarity) {
        results.push({ photo: entry.photo, similarity });
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
