import log from 'electron-log';
import type { DatabaseService, PhotoRow } from './database';
import { AiEmbeddingService } from './aiEmbedding';
import { getAiConfig } from './aiConfig';

export interface AiSearchResult {
  photo: PhotoRow;
  similarity: number;
}

export class AiSearchService {
  private db: DatabaseService;
  private embeddingService: AiEmbeddingService;

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

  async search(query: string, limit: number = 50): Promise<AiSearchResult[]> {
    if (!this.isReady()) {
      await this.init();
    }

    const config = getAiConfig();
    log.info(`[AI] 语义搜索: "${query}"`);

    const textEmbedding = await this.embeddingService.encodeText(query);
    const results = this.db.searchPhotosByEmbedding(textEmbedding, config.model, limit);

    return results;
  }
}
