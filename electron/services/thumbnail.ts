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

  /**
   * 后台批量生成缩略图，带并发限制。
   * 用于扫描完成后渐进式生成网格缩略图，避免首次浏览卡顿。
   */
  async generateThumbnailsInBackground(
    photoIds: string[],
    getPhotoPath: (id: string) => string | undefined,
    size: ThumbnailSize = 'small',
    concurrency: number = 3
  ): Promise<void> {
    if (photoIds.length === 0) return;

    log.info(`[Thumbnail] 后台开始生成 ${photoIds.length} 张 ${size} 缩略图`);
    const queue = [...photoIds];
    let completed = 0;
    let failed = 0;

    const worker = async () => {
      while (queue.length > 0) {
        const id = queue.shift()!;
        const path = getPhotoPath(id);
        if (!path) continue;
        try {
          await this.getThumbnail(id, path, size);
          completed++;
        } catch (e) {
          failed++;
          log.warn(`[Thumbnail] 后台生成缩略图失败: ${path}`, e);
        }
        if ((completed + failed) % 100 === 0) {
          log.info(`[Thumbnail] 后台缩略图进度: ${completed + failed}/${photoIds.length}`);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, photoIds.length) }, () => worker());
    await Promise.all(workers);
    log.info(`[Thumbnail] 后台缩略图生成完成: 成功 ${completed}，失败 ${failed}`);
  }
}
