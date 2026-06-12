import { readdir, stat } from 'fs/promises';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from './database';
import { HashService } from './hash';
import { ExifService } from './exif';
import { ThumbnailService } from './thumbnail';
import log from 'electron-log';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw'];

// 每批处理数量，处理完让出事件循环
const BATCH_SIZE = 50;
// 进度上报间隔（每N张上报一次）
const PROGRESS_INTERVAL = 20;

export interface ScanProgress {
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'hashing' | 'complete' | 'idle';
  newCount?: number;
  skipped?: number;
  duplicates?: number;
  deletedCount?: number;
}

// 让出事件循环，避免阻塞主进程
function yieldToMain(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export class ScannerService {
  private db: DatabaseService;
  private hashService: HashService;
  private exifService: ExifService;
  private thumbnailService: ThumbnailService;
  private scanning = false;

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

  get isScanning(): boolean {
    return this.scanning;
  }

  async addFolder(path: string): Promise<{ id: string; path: string; isNew: boolean }> {
    const existing = this.db.getFolderByPath(path);
    if (existing) {
      return { id: existing.id, path: existing.path, isNew: false };
    }

    const id = uuidv4();
    this.db.addFolder(id, path);
    log.info(`[Scanner] 添加文件夹: ${path}`);
    return { id, path, isNew: true };
  }

  async startScan(
    folderId: string,
    onProgress: (progress: ScanProgress) => void
  ): Promise<{ totalPhotos: number; duplicates: number; skipped: number }> {
    if (this.scanning) {
      throw new Error('扫描正在进行中');
    }

    const folders = this.db.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) {
      throw new Error('Folder not found');
    }

    this.scanning = true;
    log.info(`[Scanner] 开始扫描文件夹: ${folder.path}`);

    try {
      // 第一步：收集所有图片文件路径
      onProgress({ current: 0, total: 0, currentFile: '正在收集文件列表...', status: 'scanning' });
      await yieldToMain();

      const files = await this.getAllImageFiles(folder.path);
      const total = files.length;
      log.info(`[Scanner] 找到 ${total} 个图片文件`);

      if (total === 0) {
        this.db.updateFolderScanTime(folderId, 0);
        onProgress({ current: 0, total: 0, currentFile: '', status: 'complete' });
        return { totalPhotos: 0, duplicates: 0, skipped: 0 };
      }

      // 第二步：获取已有照片，用于增量扫描
      const existingPhotos = this.db.getPhotosByFolder(folderId);
      const existingPathMap = new Map<string, { id: string; fileHash: string; fileSize: number; modifiedTime: string }>();
      for (const p of existingPhotos) {
        existingPathMap.set(p.path, {
          id: p.id,
          fileHash: p.file_hash,
          fileSize: p.file_size,
          modifiedTime: p.taken_at || '',
        });
      }

      // 第三步：分批处理文件
      const newPhotos: any[] = [];
      const hashMap = new Map<string, string[]>();
      let duplicates = 0;
      let skipped = 0;
      let newCount = 0;

      for (let i = 0; i < files.length; i++) {
        const filePath = files[i];

        // 每批处理后让出事件循环
        if (i > 0 && i % BATCH_SIZE === 0) {
          // 分批写入数据库
          if (newPhotos.length > 0) {
            this.db.insertPhotos(newPhotos);
            newPhotos.length = 0;
          }
          await yieldToMain();
        }

        // 进度上报（每20张或最后一张）
        if (i % PROGRESS_INTERVAL === 0 || i === files.length - 1) {
          onProgress({
            current: i + 1,
            total,
            currentFile: filePath.split(/[/\\]/).pop() || filePath,
            status: 'scanning',
          });
        }

        try {
          const stats = await stat(filePath);

          // 增量扫描：检查文件是否已存在且未修改
          const existing = existingPathMap.get(filePath);
          if (existing && existing.fileSize === stats.size) {
            // 文件大小相同，大概率未修改，跳过
            skipped++;
            existingPathMap.delete(filePath);

            // 仍然加入hash map用于重复检测
            if (existing.fileHash) {
              if (!hashMap.has(existing.fileHash)) {
                hashMap.set(existing.fileHash, [filePath]);
              } else {
                hashMap.get(existing.fileHash)!.push(filePath);
                duplicates++;
              }
            }
            continue;
          }

          // 新文件或已修改的文件，需要完整处理
          newCount++;
          const exifData = await this.exifService.extractExif(filePath);
          const fileHash = await this.hashService.calculateFileHash(filePath);

          if (hashMap.has(fileHash)) {
            hashMap.get(fileHash)!.push(filePath);
            duplicates++;
          } else {
            hashMap.set(fileHash, [filePath]);
          }

          const photoId = existing?.id || uuidv4();

          // 扫描时不生成缩略图，延迟到浏览时按需生成
          const takenAt = exifData.takenAt || stats.mtime;

          newPhotos.push({
            id: photoId,
            folderId,
            path: filePath,
            filename: filePath.split(/[/\\]/).pop() || '',
            fileSize: stats.size,
            fileHash,
            perceptualHash: fileHash.substring(0, 16),
            takenAt: takenAt.toISOString(),
            latitude: exifData.latitude,
            longitude: exifData.longitude,
            width: exifData.width,
            height: exifData.height,
            camera: exifData.camera,
            aperture: exifData.aperture,
            shutterSpeed: exifData.shutterSpeed,
            iso: exifData.iso,
            focalLength: exifData.focalLength,
            thumbnailPath: null, // 延迟生成
          });

          existingPathMap.delete(filePath);
        } catch (error) {
          log.warn(`[Scanner] 处理文件失败: ${filePath}`, error);
        }
      }

      // 写入剩余的照片
      if (newPhotos.length > 0) {
        this.db.insertPhotos(newPhotos);
      }

      // 删除不再存在的照片（existingPathMap中剩余的就是已删除的文件）
      let deletedCount = 0;
      for (const [path, info] of existingPathMap) {
        this.db.deletePhoto(info.id);
        deletedCount++;
      }
      if (deletedCount > 0) {
        log.info(`[Scanner] 删除 ${deletedCount} 个不存在的照片记录`);
      }

      // 更新文件夹扫描时间
      const totalPhotos = this.db.getPhotosByFolder(folderId).length;
      this.db.updateFolderScanTime(folderId, totalPhotos);

      // 重复检测
      onProgress({ current: total, total, currentFile: '正在检测重复照片...', status: 'hashing' });
      await yieldToMain();
      await this.detectDuplicates(hashMap);

      log.info(`[Scanner] 扫描完成: 总计 ${totalPhotos} 张, 新增 ${newCount} 张, 跳过 ${skipped} 张, 重复 ${duplicates} 组, 删除 ${deletedCount} 张`);
      onProgress({ current: total, total, currentFile: '', status: 'complete', newCount, skipped, duplicates, deletedCount });

      return { totalPhotos, duplicates, skipped };
    } finally {
      this.scanning = false;
    }
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
      log.warn(`[Scanner] 扫描目录失败: ${dirPath}`, error);
    }
  }

  private async detectDuplicates(hashMap: Map<string, string[]>): Promise<void> {
    // 清除旧的重复记录
    this.db.clearDuplicateGroups();

    let count = 0;
    for (const [hash, paths] of hashMap) {
      if (paths.length > 1) {
        const groupId = uuidv4();
        const photos = paths
          .map(p => this.db.getPhotoByPath(p))
          .filter(Boolean);

        if (photos.length > 1) {
          const recommended = this.selectBestPhoto(photos);
          this.db.insertDuplicateGroup({
            id: groupId,
            reason: 'exact',
            recommendedPhotoId: recommended.id,
          });

          for (const photo of photos) {
            this.db.insertPhotoDuplicate(photo.id, groupId);
          }
          count++;
        }
      }

      // 每处理100组让出一次
      if (count > 0 && count % 100 === 0) {
        await yieldToMain();
      }
    }
    log.info(`[Scanner] 检测到 ${count} 组重复照片`);
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
    const trash = (await import('trash')).default;
    for (const id of photoIds) {
      const photo = this.db.getPhotoById(id);
      if (photo) {
        await trash(photo.path);
        this.db.deletePhoto(id);
      }
    }
  }
}
