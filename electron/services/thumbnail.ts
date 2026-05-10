import { join } from 'path';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import sharp from 'sharp';

const THUMBNAIL_SIZE = 512;
const THUMBNAIL_QUALITY = 90;

export class ThumbnailService {
  private thumbnailDir: string;

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
      console.error(`Failed to generate thumbnail for ${photoPath}:`, error);
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
  }
}
