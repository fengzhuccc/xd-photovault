import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import sharp from 'sharp';

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
      return thumbnailPath;
    }

    try {
      await sharp(photoPath)
        .resize(256, 256, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toFile(thumbnailPath);

      return thumbnailPath;
    } catch (error) {
      console.error(`Failed to generate thumbnail for ${photoPath}:`, error);
      return photoPath;
    }
  }

  async generateThumbnail(photoPath: string, outputPath: string): Promise<void> {
    await sharp(photoPath)
      .resize(256, 256, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toFile(outputPath);
  }
}
