import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
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
      return `file:///${thumbnailPath.replace(/\\/g, '/')}`;
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
}
