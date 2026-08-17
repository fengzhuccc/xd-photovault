import { join, extname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { stat, unlink, readdir, mkdir, rmdir } from 'fs/promises';
import sharp from 'sharp';
import { VideoService } from './video';
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

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.avi']);

function isVideoFile(path: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(path).toLowerCase());
}

export class ThumbnailService {
  thumbnailDir: string;
  // 同一 photoId + size 的缩略图请求共享一次生成过程，避免扫描线程和浏览线程并发写同一文件
  private inFlight = new Map<string, Promise<string>>();
  private videoService?: VideoService;

  constructor(userDataPath: string, videoService?: VideoService) {
    this.thumbnailDir = join(userDataPath, 'thumbnails');
    this.videoService = videoService;
    if (!existsSync(this.thumbnailDir)) {
      mkdirSync(this.thumbnailDir, { recursive: true });
    }
  }

  private getShardDirPath(photoId: string): string {
    return join(this.thumbnailDir, photoId.slice(0, 2));
  }

  /** 写入前确保分片目录存在（异步；recursive mkdir 幂等，无需先 exists） */
  private async ensureShardDir(photoId: string): Promise<string> {
    const dir = this.getShardDirPath(photoId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private getLegacyPath(photoId: string): string {
    return join(this.thumbnailDir, `${photoId}.webp`);
  }

  private getThumbnailPath(photoId: string, thumbSize: ThumbnailSize): string {
    // 查询路径时不创建目录
    return join(this.getShardDirPath(photoId), `${photoId}_${thumbSize}.webp`);
  }

  private async isThumbnailFresh(thumbnailPath: string, photoPath: string): Promise<boolean> {
    try {
      const [thumbStat, sourceStat] = await Promise.all([stat(thumbnailPath), stat(photoPath)]);
      return sourceStat.mtime <= thumbStat.mtime;
    } catch {
      return false;
    }
  }

  /** 异步删除单个文件；文件不存在（ENOENT）静默，其余失败告警。 */
  private async deleteFileQuietly(filePath: string, label: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`[Thumbnail] ${label}失败: ${filePath}`, e);
      }
    }
  }

  private fileUrl(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    // Unix 路径以 / 开头，使用 file:// 避免多一个斜杠；Windows 用 file:///
    return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
  }

  private async generateThumbnail(photoPath: string, thumbnailPath: string, config: ThumbnailConfig): Promise<void> {
    let input: string | Buffer = photoPath;

    if (isVideoFile(photoPath)) {
      if (!this.videoService) {
        throw new Error('未提供 VideoService，无法生成视频缩略图');
      }
      input = await this.videoService.extractFirstFrame(photoPath);
    }

    await sharp(input)
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
    // 源文件已不存在（例如被删除但数据库记录还在），直接返回原图 URL 避免报错
    try {
      await stat(photoPath);
    } catch {
      log.debug(`[Thumbnail] 源文件不存在，跳过缩略图生成: ${photoPath}`);
      return this.fileUrl(photoPath);
    }

    const thumbnailPath = this.getThumbnailPath(photoId, thumbSize);

    if (await this.isThumbnailFresh(thumbnailPath, photoPath)) {
      return this.fileUrl(thumbnailPath);
    }

    // 兼容旧版无分片的 512px 缩略图（视为 medium）
    if (thumbSize === 'medium') {
      const legacyPath = this.getLegacyPath(photoId);
      if (await this.isThumbnailFresh(legacyPath, photoPath)) {
        return this.fileUrl(legacyPath);
      }
      // 旧文件已过期则删除
      await this.deleteFileQuietly(legacyPath, '删除过期旧缩略图');
    }

    try {
      // 确保分片目录存在（getThumbnailPath 不再自动创建）
      await this.ensureShardDir(photoId);
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
    concurrency: number = 8
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
    const entries = await readdir(this.thumbnailDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(this.thumbnailDir, entry.name);
      try {
        if (entry.isDirectory()) {
          await this.removeDirRecursive(fullPath);
        } else if (entry.name.endsWith('.webp')) {
          await unlink(fullPath);
        }
      } catch (e) {
        log.warn(`[Thumbnail] 清理缩略图失败: ${fullPath}`, e);
      }
    }
    log.info('[Thumbnail] 缩略图缓存已清除');
  }

  async getStats(): Promise<{ count: number; totalSize: number; smallCount: number; mediumCount: number }> {
    const stats = { count: 0, totalSize: 0, smallCount: 0, mediumCount: 0 };
    await this.collectStats(this.thumbnailDir, stats);
    return stats;
  }

  private async collectStats(dirPath: string, stats: { count: number; totalSize: number; smallCount: number; mediumCount: number }): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // 目录不存在
    }
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.collectStats(fullPath, stats);
      } else if (entry.name.endsWith('.webp')) {
        try {
          const fileStat = await stat(fullPath);
          stats.count++;
          stats.totalSize += fileStat.size;
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

  private async removeDirRecursive(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.removeDirRecursive(fullPath);
      } else {
        await unlink(fullPath);
      }
    }
    await rmdir(dirPath);
  }

  async deleteThumbnailsByPhotoIds(photoIds: string[]): Promise<void> {
    for (const id of photoIds) {
      // 删除新版多尺寸缩略图
      for (const size of Object.keys(THUMBNAIL_CONFIG) as ThumbnailSize[]) {
        await this.deleteFileQuietly(this.getThumbnailPath(id, size), '删除缩略图');
      }
      // 删除旧版无分片缩略图
      await this.deleteFileQuietly(this.getLegacyPath(id), '删除旧缩略图');
    }
  }

  async cleanOrphanThumbnails(db: { getAllPhotoIds: () => string[] }): Promise<void> {
    try {
      const existingIds = new Set(db.getAllPhotoIds());
      await this.cleanOrphanDir(this.thumbnailDir, existingIds);
    } catch (e) {
      log.warn('[Thumbnail] 清理孤立缩略图失败', e);
    }
  }

  private async cleanOrphanDir(dirPath: string, existingIds: Set<string>): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let fileCount = 0;

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.cleanOrphanDir(fullPath, existingIds);
        // 如果目录已空则删除
        try {
          const remaining = await readdir(fullPath);
          if (remaining.length === 0) {
            await rmdir(fullPath);
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
          await this.deleteFileQuietly(fullPath, '清理孤立缩略图');
        }
      }
    }

    if (fileCount > 0) {
      log.info(`[Thumbnail] 已清理孤立缩略图，扫描目录: ${dirPath}`);
    }
  }
}
