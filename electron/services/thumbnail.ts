import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import sharp from 'sharp';
import log from 'electron-log';

const THUMBNAIL_SIZE = 512;
const THUMBNAIL_QUALITY = 90;

export class ThumbnailService {
  thumbnailDir: string;

  constructor(userDataPath: string) {
    this.thumbnailDir = join(userDataPath, 'thumbnails');
    if (!existsSync(this.thumbnailDir)) {
      mkdirSync(this.thumbnailDir, { recursive: true });
    }
  }

  async getThumbnail(photoId: string, photoPath: string): Promise<string> {
    const thumbnailPath = join(this.thumbnailDir, `${photoId}.webp`);

    if (existsSync(thumbnailPath)) {
      // 校验源文件 mtime，如果源文件比缩略图新则重新生成
      try {
        const thumbStat = statSync(thumbnailPath);
        const sourceStat = statSync(photoPath);
        if (sourceStat.mtime <= thumbStat.mtime) {
          return `file:///${thumbnailPath.replace(/\\/g, '/')}`;
        }
        // 源文件已更新，删除旧缩略图
        unlinkSync(thumbnailPath);
      } catch {
        // 源文件可能不存在，返回缩略图
        return `file:///${thumbnailPath.replace(/\\/g, '/')}`;
      }
    }

    try {
      await sharp(photoPath)
        .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: THUMBNAIL_QUALITY })
        .toFile(thumbnailPath);

      return `file:///${thumbnailPath.replace(/\\/g, '/')}`;
    } catch (error) {
      log.warn(`[Thumbnail] 生成缩略图失败: ${photoPath}`, error);
      return `file:///${photoPath.replace(/\\/g, '/')}`;
    }
  }

  async clearThumbnails(): Promise<void> {
    const files = readdirSync(this.thumbnailDir);
    for (const file of files) {
      if (file.endsWith('.webp')) {
        unlinkSync(join(this.thumbnailDir, file));
      }
    }
    log.info('[Thumbnail] 缩略图缓存已清除');
  }

  deleteThumbnailsByPhotoIds(photoIds: string[]): void {
    for (const id of photoIds) {
      const thumbnailPath = join(this.thumbnailDir, `${id}.webp`);
      try {
        if (existsSync(thumbnailPath)) {
          unlinkSync(thumbnailPath);
        }
      } catch (e) {
        log.warn(`[Thumbnail] 删除缩略图失败: ${thumbnailPath}`, e);
      }
    }
  }

  cleanOrphanThumbnails(db: { getAllPhotoIds: () => string[] }): void {
    // 清理数据库中已无对应照片的孤立缩略图文件
    try {
      const files = readdirSync(this.thumbnailDir).filter(f => f.endsWith('.webp'));
      if (files.length === 0) return;

      const existingIds = new Set(
        db.getAllPhotoIds().map((id: string) => `${id}.webp`)
      );

      let cleaned = 0;
      for (const file of files) {
        if (!existingIds.has(file)) {
          try {
            unlinkSync(join(this.thumbnailDir, file));
            cleaned++;
          } catch (e) {
            log.warn(`[Thumbnail] 清理孤立缩略图失败: ${file}`, e);
          }
        }
      }
      if (cleaned > 0) {
        log.info(`[Thumbnail] 清理了 ${cleaned} 个孤立缩略图`);
      }
    } catch (e) {
      log.warn('[Thumbnail] 清理孤立缩略图失败', e);
    }
  }
}
