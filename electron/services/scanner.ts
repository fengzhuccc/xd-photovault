import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import trash from 'trash';
import { DatabaseService } from './database.js';
import { HashService } from './hash.js';
import { ExifService } from './exif.js';
import { ThumbnailService } from './thumbnail.js';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw'];

export interface ScanProgress {
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'hashing' | 'complete' | 'idle';
}

export class ScannerService {
  private db: DatabaseService;
  private hashService: HashService;
  private exifService: ExifService;
  private thumbnailService: ThumbnailService;

  constructor(
    db: DatabaseService,
    hashService: HashService,
    exifService: ExifService,
    thumbnailService: ThumbnailService
  ) {
    this.db = db;
    this.hashService = hashService;
    this.exifService = exifService;
    this.thumbnailService = thumbnailService;
  }

  async addFolder(path: string): Promise<{ id: string; path: string; isNew: boolean }> {
    const existing = this.db.getFolderByPath(path);
    if (existing) {
      return { id: existing.id, path: existing.path, isNew: false };
    }

    const id = uuidv4();
    this.db.addFolder(id, path);
    return { id, path, isNew: true };
  }

  async startScan(
    folderId: string,
    onProgress: (progress: ScanProgress) => void
  ): Promise<{ totalPhotos: number; duplicates: number }> {
    const folders = this.db.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) {
      throw new Error('Folder not found');
    }

    const files = await this.getAllImageFiles(folder.path);
    const total = files.length;
    let duplicates = 0;

    onProgress({ current: 0, total, currentFile: '', status: 'scanning' });

    const photos: any[] = [];
    const hashMap = new Map<string, string[]>();

    for (let i = 0; i < files.length; i++) {
      const filePath = files[i];
      onProgress({
        current: i + 1,
        total,
        currentFile: filePath.split('/').pop() || filePath,
        status: 'scanning',
      });

      try {
        const stats = await stat(filePath);
        const exifData = await this.exifService.extractExif(filePath);
        const fileHash = await this.hashService.calculateFileHash(filePath);

        if (hashMap.has(fileHash)) {
          hashMap.get(fileHash)!.push(filePath);
          duplicates++;
        } else {
          hashMap.set(fileHash, [filePath]);
        }

        const photoId = uuidv4();
        const thumbnailPath = await this.thumbnailService.getThumbnail(photoId, filePath);

        photos.push({
          id: photoId,
          folderId,
          path: filePath,
          filename: filePath.split('/').pop() || '',
          fileSize: stats.size,
          fileHash,
          perceptualHash: fileHash.substring(0, 16),
          takenAt: exifData.takenAt?.toISOString() || null,
          latitude: exifData.latitude,
          longitude: exifData.longitude,
          width: exifData.width,
          height: exifData.height,
          camera: exifData.camera,
          aperture: exifData.aperture,
          shutterSpeed: exifData.shutterSpeed,
          iso: exifData.iso,
          focalLength: exifData.focalLength,
          thumbnailPath,
        });
      } catch (error) {
        console.error(`Failed to process ${filePath}:`, error);
      }
    }

    this.db.insertPhotos(photos);
    this.db.updateFolderScanTime(folderId, photos.length);

    await this.detectDuplicates(hashMap);

    onProgress({ current: total, total, currentFile: '', status: 'complete' });

    return { totalPhotos: photos.length, duplicates };
  }

  private async getAllImageFiles(dirPath: string): Promise<string[]> {
    const files: string[] = [];
    await this.scanDirectory(dirPath, files);
    return files;
  }

  private async scanDirectory(dirPath: string, files: string[]): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== '@eaDir') {
            await this.scanDirectory(fullPath, files);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (SUPPORTED_EXTENSIONS.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      console.error(`Failed to scan directory ${dirPath}:`, error);
    }
  }

  private async detectDuplicates(hashMap: Map<string, string[]>): Promise<void> {
    for (const [hash, paths] of hashMap) {
      if (paths.length > 1) {
        const groupId = uuidv4();
        const photos = paths.map(p => this.db.getPhotoById(
          this.db.getAllPhotoPaths().find(photo => photo.path === p)?.id || ''
        )).filter(Boolean);

        if (photos.length > 0) {
          const recommended = this.selectBestPhoto(photos);
          this.db.insertDuplicateGroup({
            id: groupId,
            reason: 'exact',
            recommendedPhotoId: recommended.id,
          });

          for (const photo of photos) {
            this.db.insertPhotoDuplicate(photo.id, groupId);
          }
        }
      }
    }
  }

  private selectBestPhoto(photos: any[]): any {
    return photos.reduce((best, current) => {
      if (current.latitude && current.longitude && (!best.latitude || !best.longitude)) {
        return current;
      }
      if (current.file_size > best.file_size) {
        return current;
      }
      if ((current.width || 0) * (current.height || 0) > (best.width || 0) * (best.height || 0)) {
        return current;
      }
      return best;
    });
  }

  async deletePhotos(photoIds: string[]): Promise<void> {
    for (const id of photoIds) {
      const photo = this.db.getPhotoById(id);
      if (photo) {
        await trash(photo.path);
        this.db.deletePhoto(id);
      }
    }
  }
}
