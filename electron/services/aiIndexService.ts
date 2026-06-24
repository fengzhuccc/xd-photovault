import log from 'electron-log';
import type { DatabaseService } from './database';
import { AiEmbeddingService } from './aiEmbedding';
import { getAiConfig } from './aiConfig';

export interface AiIndexProgress {
  status: 'idle' | 'loading' | 'indexing' | 'pausing' | 'paused' | 'complete' | 'error';
  processed: number;
  total: number;
  currentFile: string;
  message: string;
}

export interface AiIndexStatus {
  status: AiIndexProgress['status'];
  processed: number;
  total: number;
  currentFile: string;
  message: string;
}

export class AiIndexService {
  private db: DatabaseService;
  private embeddingService: AiEmbeddingService;
  private running = false;
  private paused = false;
  private cancelled = false;
  private processed = 0;
  private total = 0;
  private currentFile = '';
  private message = '';
  private status: AiIndexProgress['status'] = 'idle';
  private onProgressCallback?: (progress: AiIndexProgress) => void;
  // 本次运行中索引失败的照片 ID，避免重复查询导致死循环
  private failedPhotoIds: Set<string> = new Set();

  constructor(db: DatabaseService, dataPath: string, embeddingService?: AiEmbeddingService) {
    this.db = db;
    this.embeddingService = embeddingService ?? new AiEmbeddingService(dataPath);
  }

  onProgress(callback: (progress: AiIndexProgress) => void): void {
    this.onProgressCallback = callback;
  }

  private emitProgress(): void {
    const progress: AiIndexProgress = {
      status: this.status,
      processed: this.processed,
      total: this.total,
      currentFile: this.currentFile,
      message: this.message,
    };
    try {
      this.onProgressCallback?.(progress);
    } catch (e) {
      log.warn('[AI] 上报索引进度失败', e);
    }
  }

  getStatus(): AiIndexStatus {
    return {
      status: this.status,
      processed: this.processed,
      total: this.total,
      currentFile: this.currentFile,
      message: this.message,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      log.info('[AI] 索引任务已在运行');
      return;
    }

    this.running = true;
    this.cancelled = false;
    this.paused = false;
    this.processed = 0;
    this.failedPhotoIds.clear();
    this.status = 'loading';
    this.message = '正在加载 AI 模型...';
    this.emitProgress();

    try {
      await this.embeddingService.init();
    } catch (error) {
      this.status = 'error';
      this.message = `模型加载失败: ${error instanceof Error ? error.message : String(error)}`;
      this.emitProgress();
      this.running = false;
      return;
    }

    this.status = 'indexing';
    this.message = '开始索引照片...';
    const config = getAiConfig();
    this.total = this.db.getTotalPhotoCount();
    this.processed = this.db.getEmbeddingCount(config.model);
    this.emitProgress();

    // GPU 模式下一次从数据库取更多照片，以便批量推理；CPU 模式保持小批量
    const effectiveIndexBatchSize = config.useGpu ? 16 : config.indexBatchSize;

    try {
      while (!this.cancelled) {
        await this.waitWhilePaused();
        if (this.cancelled) break;

        const photos = this.db.getPhotosWithoutEmbedding(effectiveIndexBatchSize, [...this.failedPhotoIds]);
        if (photos.length === 0) {
          break;
        }

        // 查询已过滤为仅图片，直接使用
        const imagePhotos = photos;

        this.currentFile = imagePhotos[0].filename;
        this.message = `正在索引 ${imagePhotos[0].filename}`;
        this.emitProgress();

        if (config.useGpu) {
          // GPU 模式：批量编码，充分利用 GPU 算力
          try {
            const imagePaths = imagePhotos.map(p => p.path);
            const embeddings = await this.embeddingService.encodeImages(imagePaths);
            for (let i = 0; i < imagePhotos.length; i++) {
              if (this.cancelled) break;
              await this.waitWhilePaused();
              const embedding = embeddings[i];
              if (embedding) {
                this.db.upsertPhotoEmbedding(imagePhotos[i].id, embedding, config.model);
                this.processed++;
              } else {
                log.warn(`[AI] 该照片批量索引失败，跳过: ${imagePhotos[i].path}`);
                this.failedPhotoIds.add(imagePhotos[i].id);
                this.processed++;
              }
            }
          } catch (error) {
            log.error('[AI] GPU 批量索引失败，降级为单张重试:', error);
            // 批量失败时降级为单张处理，避免整批跳过导致死循环
            for (const photo of imagePhotos) {
              if (this.cancelled) break;
              await this.waitWhilePaused();
              try {
                const embedding = await this.embeddingService.encodeImage(photo.path);
                this.db.upsertPhotoEmbedding(photo.id, embedding, config.model);
                this.processed++;
              } catch (err) {
                log.warn(`[AI] 单张索引失败，跳过: ${photo.path}`, err);
                this.failedPhotoIds.add(photo.id);
                this.processed++;
              }
            }
          }
        } else {
          // CPU 模式：单张单张推理，避免占用过多内存和线程
          for (let i = 0; i < imagePhotos.length; i++) {
            if (this.cancelled) break;
            await this.waitWhilePaused();

            const photo = imagePhotos[i];
            this.currentFile = photo.filename;
            this.message = `正在索引 ${photo.filename}`;
            this.emitProgress();

            try {
              const embedding = await this.embeddingService.encodeImage(photo.path);
              this.db.upsertPhotoEmbedding(photo.id, embedding, config.model);
              this.processed++;
            } catch (error) {
              log.warn(`[AI] 索引照片失败，跳过: ${photo.path}`, error);
              this.failedPhotoIds.add(photo.id);
              this.processed++;
            }

            // 每处理完一张让出事件循环，避免主进程/Worker卡死
            if (i % config.inferenceBatchSize === 0) {
              await this.yieldToMain();
            }
          }
        }
      }

      if (this.cancelled) {
        this.status = 'idle';
        this.message = '索引已取消';
      } else {
        this.status = 'complete';
        this.message = '索引完成';
      }
    } catch (error) {
      this.status = 'error';
      this.message = `索引出错: ${error instanceof Error ? error.message : String(error)}`;
      log.error('[AI] 索引任务异常', error);
    } finally {
      this.running = false;
      this.currentFile = '';
      this.emitProgress();
    }
  }

  pause(): void {
    if (!this.running) return;
    this.paused = true;
    // M-13: 直接设置为 paused 状态，避免卡在 'pausing' 状态
    this.status = 'paused';
    this.message = '索引已暂停';
    this.emitProgress();
    log.info('[AI] 索引任务暂停请求已收到');
  }

  resume(): void {
    if (!this.running) return;
    this.paused = false;
    log.info('[AI] 索引任务继续');
  }

  cancel(): void {
    this.cancelled = true;
    this.paused = false;
    // L-5: 立即更新状态为 idle，避免 UI 仍显示 indexing 数秒
    if (this.status === 'indexing' || this.status === 'paused' || this.status === 'pausing') {
      this.status = 'idle';
      this.message = '索引已取消';
      this.emitProgress();
    }
    log.info('[AI] 索引任务取消');
  }

  private async waitUntilResumed(): Promise<void> {
    while (this.paused && !this.cancelled) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.paused || this.cancelled) return;
    this.status = 'paused';
    this.message = '索引已暂停';
    this.emitProgress();
    await this.waitUntilResumed();
    this.status = 'indexing';
    this.message = '继续索引...';
    this.emitProgress();
  }

  private async yieldToMain(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
  }
}
