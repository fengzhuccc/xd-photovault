import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'fs';
import sharp from 'sharp';
import log from 'electron-log';

export type ThumbnailSize = 'small' | 'medium';

interface ThumbnailConfig {
  size: number;
  quality: number;
}

const THUMBNAIL_CONFIG: Record<ThumbnailSize, ThumbnailConfig> = {
  small: { size: 128, quality: 85 },
  medium: { size: 512, quality: 90 },
};

export class ThumbnailService {
  thumbnailDir: string;
  // 同一 photoId + size 的缩略图请求共享一次生成过程，避免扫描线程和浏览线程并发写同一文件
  private inFlight = new Map<string, Promise<string>>();

  constructor(userDataPath: string) {
    this.thumbnailDir = join(userDataPath, 'thumbnails');
    if (!existsSync(this.thumbnailDir)) {
      mkdirSync(this.thumbnailDir, { recursive: true });
    }
  }

  private getShardDir(photoId: string): string {
    const prefix = photoId.slice(0, 2);
    const dir = join(this.thumbnailDir, prefix);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getLegacyPath(photoId: string): string {
    return join(this.thumbnailDir, `${photoId}.webp`);
  }

  private getThumbnailPath(photoId: string, thumbSize: ThumbnailSize): string {
    return join(this.getShardDir(photoId), `${photoId}_${thumbSize}.webp`);
  }

  private isThumbnailFresh(thumbnailPath: string, photoPath: string): boolean {
    if (!existsSync(thumbnailPath)) return false;
    try {
      const thumbStat = statSync(thumbnailPath);
      const sourceStat = statSync(photoPath);
      return sourceStat.mtime <= thumbStat.mtime;
    } catch {
      return false;
    }
  }

  private fileUrl(filePath: string): string {
    return `file:///${filePath.replace(/\\/g, '/')}`;
  }

  private async generateThumbnail(photoPath: string, thumbnailPath: string, config: ThumbnailConfig): Promise<void> {
    await sharp(photoPath)
      .resize(config.size, config.size, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: config.quality })
      .toFile(thumbnailPath);
  }

  async getThumbnail(photoId: string, photoPath: string, thumbSize: ThumbnailSize = 'medium'): Promise<string> {
    const key = `${photoId}:${thumbSize}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = this.doGetThumbnail(photoId, photoPath, thumbSize).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async doGetThumbnail(photoId: string, photoPath: string, thumbSize: ThumbnailSize): Promise<string> {
    const thumbnailPath = this.getThumbnailPath(photoId, thumbSize);

    if (this.isThumbnailFresh(thumbnailPath, photoPath)) {
      return this.fileUrl(thumbnailPath);
    }

    // 兼容旧版无分片的 512px 缩略图（视为 medium）
    if (thumbSize === 'medium') {
      const legacyPath = this.getLegacyPath(photoId);
      if (this.isThumbnailFresh(legacyPath, photoPath)) {
        return this.fileUrl(legacyPath);
      }
      // 旧文件已过期则删除
      try {
        if (existsSync(legacyPath)) {
          unlinkSync(legacyPath);
        }
      } catch (e) {
        log.warn(`[Thumbnail] 删除过期旧缩略图失败: ${legacyPath}`, e);
      }
    }

    try {
      await this.generateThumbnail(photoPath, thumbnailPath, THUMBNAIL_CONFIG[thumbSize]);
      return this.fileUrl(thumbnailPath);
    } catch (error) {
      log.warn(`[Thumbnail] 生成缩略图失败: ${photoPath}`, error);
      return this.fileUrl(photoPath);
    }
  }

  /**
   * 批量获取缩略图，带并发限制。
   * 返回 photoId -> URL 的映射；失败的条目回退到原图 URL。
   */
  async getThumbnailsBatch(
    items: { photoId: string; photoPath: string; size?: ThumbnailSize }[],
    concurrency: number = 4
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (items.length === 0) return result;

    const queue = [...items];

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift()!;
        try {
          result[item.photoId] = await this.getThumbnail(item.photoId, item.photoPath, item.size || 'small');
        } catch (e) {
          log.warn(`[Thumbnail] 批量生成缩略图失败: ${item.photoPath}`, e);
          result[item.photoId] = this.fileUrl(item.photoPath);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return result;
  }

  async clearThumbnails(): Promise<void> {
    const entries = readdirSync(this.thumbnailDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(this.thumbnailDir, entry.name);
      try {
        if (entry.isDirectory()) {
          this.removeDirRecursive(fullPath);
        } else if (entry.name.endsWith('.webp')) {
          unlinkSync(fullPath);
        }
      } catch (e) {
        log.warn(`[Thumbnail] 清理缩略图失败: ${fullPath}`, e);
      }
    }
    log.info('[Thumbnail] 缩略图缓存已清除');
  }

  getStats(): { count: number; totalSize: number; smallCount: number; mediumCount: number } {
    const stats = { count: 0, totalSize: 0, smallCount: 0, mediumCount: 0 };
    this.collectStats(this.thumbnailDir, stats);
    return stats;
  }

  private collectStats(dirPath: string, stats: { count: number; totalSize: number; smallCount: number; mediumCount: number }): void {
    if (!existsSync(dirPath)) return;
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.collectStats(fullPath, stats);
      } else if (entry.name.endsWith('.webp')) {
        try {
          const stat = statSync(fullPath);
          stats.count++;
          stats.totalSize += stat.size;
          if (entry.name.endsWith('_small.webp')) {
            stats.smallCount++;
          } else if (entry.name.endsWith('_medium.webp')) {
            stats.mediumCount++;
          }
        } catch (e) {
          log.warn(`[Thumbnail] 获取缩略图 stat 失败: ${fullPath}`, e);
        }
      }
    }
  }

  private removeDirRecursive(dirPath: string): void {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.removeDirRecursive(fullPath);
      } else {
        unlinkSync(fullPath);
      }
    }
    rmdirSync(dirPath);
  }

  deleteThumbnailsByPhotoIds(photoIds: string[]): void {
    for (const id of photoIds) {
      // 删除新版多尺寸缩略图
      for (const size of Object.keys(THUMBNAIL_CONFIG) as ThumbnailSize[]) {
        const path = this.getThumbnailPath(id, size);
        try {
          if (existsSync(path)) {
            unlinkSync(path);
          }
        } catch (e) {
          log.warn(`[Thumbnail] 删除缩略图失败: ${path}`, e);
        }
      }
      // 删除旧版无分片缩略图
      const legacyPath = this.getLegacyPath(id);
      try {
        if (existsSync(legacyPath)) {
          unlinkSync(legacyPath);
        }
      } catch (e) {
        log.warn(`[Thumbnail] 删除旧缩略图失败: ${legacyPath}`, e);
      }
    }
  }

  cleanOrphanThumbnails(db: { getAllPhotoIds: () => string[] }): void {
    try {
      const existingIds = new Set(db.getAllPhotoIds());
      this.cleanOrphanDir(this.thumbnailDir, existingIds);
    } catch (e) {
      log.warn('[Thumbnail] 清理孤立缩略图失败', e);
    }
  }

  private cleanOrphanDir(dirPath: string, existingIds: Set<string>): void {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    let fileCount = 0;

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        this.cleanOrphanDir(fullPath, existingIds);
        // 如果目录已空则删除
        try {
          const remaining = readdirSync(fullPath);
          if (remaining.length === 0) {
            rmdirSync(fullPath);
          }
        } catch (e) {
          log.warn(`[Thumbnail] 删除空目录失败: ${fullPath}`, e);
        }
      } else if (entry.name.endsWith('.webp')) {
        fileCount++;
        // 文件名格式：{id}_{size}.webp 或旧版 {id}.webp
        const baseName = entry.name.replace(/\.webp$/, '');
        const photoId = baseName.includes('_') ? baseName.split('_')[0] : baseName;
        if (!existingIds.has(photoId)) {
          try {
            unlinkSync(fullPath);
          } catch (e) {
            log.warn(`[Thumbnail] 清理孤立缩略图失败: ${fullPath}`, e);
          }
        }
      }
    }

    if (fileCount > 0) {
      log.info(`[Thumbnail] 已清理孤立缩略图，扫描目录: ${dirPath}`);
    }
  }
}
