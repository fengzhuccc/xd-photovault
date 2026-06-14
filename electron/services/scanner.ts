import { readdir, stat } from 'fs/promises';
import { existsSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { shell } from 'electron';
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

  async addFolder(path: string): Promise<{ id: string; path: string; isNew: boolean; conflict?: { type: 'child' | 'parent'; childFolderIds: string[]; childFolderPaths: string[] } }> {
    const existing = this.db.getFolderByPath(path);
    if (existing) {
      return { id: existing.id, path: existing.path, isNew: false };
    }

    // 嵌套校验
    const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const folders = this.db.getFolders();
    const childFolderIds: string[] = [];
    const childFolderPaths: string[] = [];

    for (const folder of folders) {
      const normalizedExisting = folder.path.replace(/\\/g, '/').replace(/\/+$/, '');

      // 新路径是已有文件夹的子目录
      if (normalizedPath.startsWith(normalizedExisting + '/')) {
        return {
          id: '', path, isNew: false,
          conflict: { type: 'child', childFolderIds: [folder.id], childFolderPaths: [folder.path] },
        };
      }

      // 新路径是已有文件夹的父目录，收集所有子目录
      if (normalizedExisting.startsWith(normalizedPath + '/')) {
        childFolderIds.push(folder.id);
        childFolderPaths.push(folder.path);
      }
    }

    if (childFolderIds.length > 0) {
      return {
        id: '', path, isNew: false,
        conflict: { type: 'parent', childFolderIds, childFolderPaths },
      };
    }

    const id = uuidv4();
    this.db.addFolder(id, path);
    log.info(`[Scanner] 添加文件夹: ${path}`);
    return { id, path, isNew: true };
  }

  async replaceWithParentFolder(childFolderIds: string[], parentPath: string): Promise<{ id: string; path: string }> {
    // 删除所有子目录的缩略图和数据库记录
    for (const childFolderId of childFolderIds) {
      const childPhotos = this.db.getPhotosByFolder(childFolderId);
      if (childPhotos.length > 0) {
        this.thumbnailService.deleteThumbnailsByPhotoIds(childPhotos.map((p: any) => p.id));
      }
      this.db.deletePhotosByFolder(childFolderId);
      this.db.removeFolder(childFolderId);
    }

    // 添加父目录
    const id = uuidv4();
    this.db.addFolder(id, parentPath);
    log.info(`[Scanner] 替换文件夹: ${parentPath} 替换子目录`);
    return { id, path: parentPath };
  }

  async startScan(
    folderId: string,
    onProgress: (progress: ScanProgress) => void,
    forceRescan: boolean = false
  ): Promise<{ totalPhotos: number; skipped: number }> {
    if (this.scanning) {
      throw new Error('扫描正在进行中');
    }

    const folders = this.db.getFolders();
    const folder = folders.find(f => f.id === folderId);
    if (!folder) {
      throw new Error('Folder not found');
    }

    this.scanning = true;
    log.info(`[Scanner] 开始${forceRescan ? '强制重新' : ''}扫描文件夹: ${folder.path}`);

    try {
      // 强制重新扫描时，先清除该文件夹的所有数据
      if (forceRescan) {
        const existingPhotos = this.db.getPhotosByFolder(folderId);
        if (existingPhotos.length > 0) {
          log.info(`[Scanner] 强制重新扫描：清除文件夹 ${existingPhotos.length} 条照片记录及缓存`);
          // 删除缩略图缓存
          this.thumbnailService.deleteThumbnailsByPhotoIds(existingPhotos.map((p: any) => p.id));
          // 删除数据库中该文件夹的所有照片和重复记录
          this.db.deletePhotosByFolder(folderId);
        }
      }

      // 第一步：收集所有图片文件路径
      onProgress({ current: 0, total: 0, currentFile: '正在收集文件列表...', status: 'scanning' });
      await yieldToMain();

      const files = await this.getAllImageFiles(folder.path);
      const total = files.length;
      log.info(`[Scanner] 找到 ${total} 个图片文件`);

      if (total === 0) {
        this.db.updateFolderScanTime(folderId, 0);
        onProgress({ current: 0, total: 0, currentFile: '', status: 'complete' });
        return { totalPhotos: 0, skipped: 0 };
      }

      // 第二步：获取已有照片，用于增量扫描
      const existingPathMap = new Map<string, { id: string; fileHash: string; fileSize: number; modifiedTime: string }>();
      if (!forceRescan) {
        const existingPhotos = this.db.getPhotosByFolder(folderId);
        for (const p of existingPhotos) {
          existingPathMap.set(p.path, {
            id: p.id,
            fileHash: p.file_hash,
            fileSize: p.file_size,
            modifiedTime: p.modified_time || '',
          });
        }
      }

      // 第三步：分批处理文件
      const newPhotos: any[] = [];
      const newHashes: string[] = [];
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

          // 增量扫描：检查文件是否已存在且未修改（强制重新扫描时跳过此检查）
          const existing = existingPathMap.get(filePath);
          if (!forceRescan && existing
              && existing.fileSize === stats.size
              && existing.modifiedTime === stats.mtime.toISOString()) {
            // 文件大小和修改时间均相同，未修改，跳过
            skipped++;
            existingPathMap.delete(filePath);
            continue;
          }

          // 新文件或已修改的文件，需要完整处理
          newCount++;

          // 如果是已修改的文件（existing存在但mtime/size不同），先删除旧记录
          if (existing) {
            this.db.deletePhoto(existing.id);
          }

          const exifData = await this.exifService.extractExif(filePath);
          const fileHash = await this.hashService.calculateFileHash(filePath);

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
            modifiedTime: stats.mtime.toISOString(),
          });
          newHashes.push(fileHash);

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
      const deletedIds: string[] = [];
      for (const [path, info] of existingPathMap) {
        deletedIds.push(info.id);
        deletedCount++;
      }
      if (deletedIds.length > 0) {
        this.thumbnailService.deleteThumbnailsByPhotoIds(deletedIds);
        this.db.deletePhotosBatch(deletedIds);
        log.info(`[Scanner] 删除 ${deletedCount} 个不存在的照片记录`);
      }

      // 更新文件夹扫描时间
      const totalPhotos = this.db.getPhotosByFolder(folderId).length;
      this.db.updateFolderScanTime(folderId, totalPhotos);

      // 扫描完成后自动触发增量重复检测
      if (newCount > 0 || deletedCount > 0) {
        await this.detectDuplicates(false, newHashes);
      }

      log.info(`[Scanner] 扫描完成: 总计 ${totalPhotos} 张, 新增 ${newCount} 张, 跳过 ${skipped} 张, 删除 ${deletedCount} 张`);
      onProgress({ current: total, total, currentFile: '', status: 'complete', newCount, skipped, deletedCount });

      return { totalPhotos, skipped };
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

  async detectDuplicates(fullRebuild: boolean = true, newHashes: string[] = []): Promise<number> {
    log.info(`[Scanner] 开始检测重复照片 (fullRebuild=${fullRebuild}, newHashes=${newHashes.length})...`);

    if (fullRebuild) {
      // 全量重建：清除所有旧重复组
      this.db.clearDuplicateGroups();
    }

    // 增量模式：只查新增照片的哈希；全量模式：查所有重复
    const exactDuplicates = fullRebuild
      ? this.db.findExactDuplicates()
      : this.db.findExactDuplicatesByHashes(newHashes);

    let groupCount = 0;
    for (const dup of exactDuplicates) {
      const photoIds = dup.photo_ids.split(',');

      if (fullRebuild) {
        // 全量模式：直接创建新组
        const photos = photoIds
          .map((id: string) => this.db.getPhotoById(id))
          .filter(Boolean);

        if (photos.length > 1) {
          const groupId = uuidv4();
          const recommended = this.selectBestPhoto(photos);
          this.db.insertDuplicateGroup({
            id: groupId,
            reason: 'exact',
            recommendedPhotoId: recommended.id,
          });

          for (const photo of photos) {
            this.db.insertPhotoDuplicate(photo.id, groupId);
          }
          groupCount++;
        }
      } else {
        // 增量模式：只处理尚未分组的重复
        // 检查这些照片是否已在某个组中
        const ungroupedPhotos = photoIds.filter((id: string) => {
          return !this.db.getPhotoDuplicateGroup(id);
        });

        if (ungroupedPhotos.length > 0) {
          // 找出已有组（如果有照片已在组中）
          const existingGroupId = photoIds
            .map((id: string) => this.db.getPhotoDuplicateGroup(id))
            .find(Boolean) || null;

          const allPhotos = photoIds
            .map((id: string) => this.db.getPhotoById(id))
            .filter(Boolean);

          if (allPhotos.length > 1) {
            let groupId: string;
            if (existingGroupId) {
              // 加入已有组
              groupId = existingGroupId;
            } else {
              // 创建新组
              groupId = uuidv4();
              const recommended = this.selectBestPhoto(allPhotos);
              this.db.insertDuplicateGroup({
                id: groupId,
                reason: 'exact',
                recommendedPhotoId: recommended.id,
              });
              groupCount++;
            }

            // 只添加未分组的照片
            for (const photoId of ungroupedPhotos) {
              this.db.insertPhotoDuplicate(photoId, groupId);
            }
          }
        }
      }

      // 每处理100组让出一次
      if (groupCount > 0 && groupCount % 100 === 0) {
        await yieldToMain();
      }
    }

    log.info(`[Scanner] 检测到 ${groupCount} 组重复照片`);
    return groupCount;
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
        try {
          await shell.trashItem(photo.path);
        } catch (e) {
          log.warn(`[Scanner] 移动文件到回收站失败: ${photo.path}`, e);
        }
        // 删除缩略图文件
        const thumbnailPath = join(this.thumbnailService.thumbnailDir, `${id}.webp`);
        try {
          if (existsSync(thumbnailPath)) {
            unlinkSync(thumbnailPath);
          }
        } catch (e) {
          log.warn(`[Scanner] 删除缩略图失败: ${thumbnailPath}`, e);
        }
        this.db.deletePhoto(id);
      }
    }
  }
}
