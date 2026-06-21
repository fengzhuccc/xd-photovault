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
    this.total = this.db.getTotalPhotoCount();
    this.processed = this.db.getEmbeddingCount();
    this.emitProgress();

    const config = getAiConfig();
    // GPU 模式下一次从数据库取更多照片，以便批量推理；CPU 模式保持小批量
    const effectiveIndexBatchSize = config.useGpu ? 16 : config.indexBatchSize;

    try {
      while (!this.cancelled) {
        await this.waitWhilePaused();
        if (this.cancelled) break;

        const photos = this.db.getPhotosWithoutEmbedding(effectiveIndexBatchSize);
        if (photos.length === 0) {
          break;
        }

        const imagePhotos = photos.filter(p => p.media_type === 'image');

        if (imagePhotos.length > 0) {
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
                this.db.upsertPhotoEmbedding(imagePhotos[i].id, embeddings[i], config.model);
                this.processed++;
              }
            } catch (error) {
              log.error('[AI] GPU 批量索引失败，本次批次跳过:', error);
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
                log.warn(`[AI] 索引照片失败: ${photo.path}`, error);
              }

              // 每处理完一张让出事件循环，避免主进程/Worker卡死
              if (i % config.inferenceBatchSize === 0) {
                await this.yieldToMain();
              }
            }
          }
        }

        // 处理视频：抽取第一帧再编码（当前仅跳过，后续可扩展）
        const videos = photos.filter(p => p.media_type === 'video');
        for (const video of videos) {
          if (this.cancelled) break;
          await this.waitWhilePaused();
          log.info(`[AI] 跳过视频索引: ${video.path}`);
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
    this.status = 'pausing';
    this.message = '正在暂停，等待当前批次完成...';
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
