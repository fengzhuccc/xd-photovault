import { readdir, stat } from 'fs/promises';
import { existsSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { shell } from 'electron';
import { DatabaseService, PhotoRow, PhotoInsert } from './database';
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

// S6: 流式文件收集 AsyncGenerator
async function* walkImageFiles(dirPath: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    log.warn(`[Scanner] 扫描目录失败: ${dirPath}`, error);
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== '@eaDir') {
        yield* walkImageFiles(fullPath);
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        yield fullPath;
      }
    }
  }
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
        this.thumbnailService.deleteThumbnailsByPhotoIds(childPhotos.map((p: PhotoRow) => p.id));
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
          this.thumbnailService.deleteThumbnailsByPhotoIds(existingPhotos.map((p: PhotoRow) => p.id));
          // 删除数据库中该文件夹的所有照片和重复记录
          this.db.deletePhotosByFolder(folderId);
        }
      }

      // S8: 标记扫描状态为 scanning
      this.db.updateFolderScanStatus(folderId, 'scanning', 0, 0, '');

      // 第一步：收集所有图片文件路径（S6: 使用 AsyncGenerator 流式收集）
      onProgress({ current: 0, total: 0, currentFile: '正在收集文件列表...', status: 'scanning' });
      await yieldToMain();

      const files: string[] = [];
      for await (const filePath of walkImageFiles(folder.path)) {
        files.push(filePath);
      }
      const total = files.length;
      log.info(`[Scanner] 找到 ${total} 个图片文件`);

      // S8: 更新扫描总数
      this.db.updateFolderScanStatus(folderId, 'scanning', total, 0, '');

      if (total === 0) {
        this.db.updateFolderScanTime(folderId, 0);
        onProgress({ current: 0, total: 0, currentFile: '', status: 'complete' });
        return { totalPhotos: 0, skipped: 0 };
      }

      // 第二步：获取已有照片，用于增量扫描
      const existingPathMap = new Map<string, { id: string; fileHash: string | null; fileSize: number; modifiedTime: string }>();
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
      const newPhotos: PhotoInsert[] = [];
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

        // S8: 定期更新扫描进度到数据库（每50张）
        if (i > 0 && i % 50 === 0) {
          this.db.updateFolderScanStatus(folderId, 'scanning', total, i + 1, filePath);
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

          // S5: extractExif 内部已优化，先用 sharp 获取宽高，不再重复 I/O
          const exifData = await this.exifService.extractExif(filePath);
          const fileHash = await this.hashService.calculateFileHash(filePath);

          // pHash 延迟到去重检测时按需计算，避免拖慢扫描速度
          const perceptualHash = null;

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
            perceptualHash,
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

      // S7: 使用 SELECT COUNT(*) 代替加载全部照片
      const totalPhotos = this.db.getPhotoCountByFolder(folderId);
      this.db.updateFolderScanTime(folderId, totalPhotos);

      // 先发送扫描完成事件，再去重检测（去重可能耗时较长，不应阻塞完成通知）
      log.info(`[Scanner] 扫描完成: 总计 ${totalPhotos} 张, 新增 ${newCount} 张, 跳过 ${skipped} 张, 删除 ${deletedCount} 张`);
      onProgress({ current: total, total, currentFile: '', status: 'complete', newCount, skipped, deletedCount });

      // 扫描完成后异步触发增量重复检测
      if (newCount > 0 || deletedCount > 0) {
        // 不 await，让去重检测在后台执行
        this.detectDuplicates(false, newHashes).catch(err => {
          log.error('[Scanner] 后台去重检测失败:', err);
        });
      }

      return { totalPhotos, skipped };
    } finally {
      this.scanning = false;
    }
  }

  /**
   * S8: 检查并恢复中断的扫描
   * 应用启动时调用，检查是否有 scan_status='scanning' 的文件夹
   * 如果有，说明上次扫描被中断，需要清理状态
   */
  recoverInterruptedScans(): { recoveredCount: number; folderPaths: string[] } {
    const interrupted = this.db.getInterruptedFolders();
    const folderPaths: string[] = [];

    for (const folder of interrupted) {
      log.info(`[Scanner] 发现中断的扫描: ${folder.path} (已处理 ${folder.scan_processed}/${folder.scan_total})`);
      // 将状态重置为 idle，用户可以手动重新扫描
      this.db.updateFolderScanStatus(folder.id, 'idle', 0, 0, '');
      folderPaths.push(folder.path);
    }

    if (folderPaths.length > 0) {
      log.info(`[Scanner] 已恢复 ${folderPaths.length} 个中断的扫描`);
    }

    return { recoveredCount: folderPaths.length, folderPaths };
  }

  async detectDuplicates(fullRebuild: boolean = true, newHashes: string[] = []): Promise<number> {
    log.info(`[Scanner] 开始检测重复照片 (fullRebuild=${fullRebuild}, newHashes=${newHashes.length})...`);

    if (fullRebuild) {
      // 全量重建：清除所有旧重复组
      this.db.clearDuplicateGroups();
    }

    // 第一步：确保所有照片都有 pHash（按需计算）
    await this.ensurePerceptualHashes();

    // 第二步：检测精确重复（file_hash 相同）
    const exactDuplicates = fullRebuild
      ? this.db.findExactDuplicates()
      : this.db.findExactDuplicatesByHashes(newHashes);

    let groupCount = 0;
    for (const dup of exactDuplicates) {
      const photoIds = dup.photo_ids.split(',');

      if (fullRebuild) {
        const photos = photoIds
          .map((id: string) => this.db.getPhotoById(id))
          .filter((p): p is PhotoRow => p !== null);

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
        const ungroupedPhotos = photoIds.filter((id: string) => {
          return !this.db.getPhotoDuplicateGroup(id);
        });

        if (ungroupedPhotos.length > 0) {
          const existingGroupId = photoIds
            .map((id: string) => this.db.getPhotoDuplicateGroup(id))
            .find(Boolean) || null;

          const allPhotos = photoIds
            .map((id: string) => this.db.getPhotoById(id))
            .filter((p): p is PhotoRow => p !== null);

          if (allPhotos.length > 1) {
            let groupId: string;
            if (existingGroupId) {
              groupId = existingGroupId;
            } else {
              groupId = uuidv4();
              const recommended = this.selectBestPhoto(allPhotos);
              this.db.insertDuplicateGroup({
                id: groupId,
                reason: 'exact',
                recommendedPhotoId: recommended.id,
              });
              groupCount++;
            }

            for (const photoId of ungroupedPhotos) {
              this.db.insertPhotoDuplicate(photoId, groupId);
            }
          }
        }
      }

      if (groupCount > 0 && groupCount % 100 === 0) {
        await yieldToMain();
      }
    }

    log.info(`[Scanner] 精确重复检测完成: ${groupCount} 组`);

    // 第三步：检测相似图片（pHash 汉明距离 < 阈值）
    const similarGroupCount = await this.detectSimilarDuplicates(fullRebuild);
    groupCount += similarGroupCount;

    log.info(`[Scanner] 检测到 ${groupCount} 组重复/相似照片`);
    return groupCount;
  }

  /**
   * 确保所有照片都有 perceptual_hash，缺失的按需计算
   */
  private async ensurePerceptualHashes(): Promise<void> {
    const photos = this.db.getPhotosWithoutPHash();
    if (photos.length === 0) return;

    log.info(`[Scanner] 需要计算 ${photos.length} 张照片的感知哈希...`);
    let computed = 0;

    for (const photo of photos) {
      try {
        const phash = await this.hashService.calculatePerceptualHash(photo.path);
        this.db.updatePhotoPerceptualHash(photo.id, phash);
        computed++;

        if (computed % 50 === 0) {
          await yieldToMain();
          log.info(`[Scanner] 已计算 ${computed}/${photos.length} 张照片的感知哈希`);
        }
      } catch (error) {
        log.warn(`[Scanner] 计算感知哈希失败: ${photo.path}`, error);
      }
    }

    log.info(`[Scanner] 感知哈希计算完成: ${computed}/${photos.length}`);
  }

  /**
   * 基于 pHash 汉明距离检测相似图片
   * 阈值 < 10 视为相似（64 位哈希中差异不超过 10 位）
   */
  private async detectSimilarDuplicates(fullRebuild: boolean): Promise<number> {
    const PHASH_THRESHOLD = 10;

    const allHashes = this.db.getAllPhotoHashes();
    // 只处理有 pHash 的照片，且排除已在 exact 组中的
    const withPHash = allHashes.filter(h => h.perceptual_hash !== null && h.perceptual_hash !== '0'.repeat(64));

    if (withPHash.length < 2) return 0;

    log.info(`[Scanner] 开始相似图片检测: ${withPHash.length} 张照片有 pHash`);

    // 按文件大小分组，只比较大小相近的（相似图片大小通常接近）
    // 先按大小排序，然后滑动窗口比较
    const photoDetails = withPHash.map(h => {
      const photo = this.db.getPhotoById(h.id);
      return photo ? { ...h, file_size: photo.file_size } : null;
    }).filter((p): p is NonNullable<typeof p> => p !== null);

    photoDetails.sort((a, b) => a.file_size - b.file_size);

    // 用 Union-Find 管理分组
    const parent = new Map<string, string>();
    const find = (id: string): string => {
      if (!parent.has(id)) parent.set(id, id);
      let root = id;
      while (parent.get(root) !== root) {
        root = parent.get(root)!;
      }
      // 路径压缩
      let current = id;
      while (current !== root) {
        const next = parent.get(current)!;
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    // 滑动窗口比较：大小差 2 倍以内的才比较
    let comparisons = 0;
    for (let i = 0; i < photoDetails.length; i++) {
      const a = photoDetails[i];
      for (let j = i + 1; j < photoDetails.length; j++) {
        const b = photoDetails[j];
        // 大小差超过 2 倍，跳过（相似图片大小不会差太多）
        if (b.file_size > a.file_size * 2) break;

        // 跳过已在同一组的
        if (parent.has(a.id) && parent.has(b.id) && find(a.id) === find(b.id)) continue;

        const distance = this.hashService.hammingDistance(a.perceptual_hash!, b.perceptual_hash!);
        if (distance < PHASH_THRESHOLD) {
          union(a.id, b.id);
        }

        comparisons++;
        if (comparisons % 10000 === 0) {
          await yieldToMain();
        }
      }

      if (i % 200 === 0) {
        await yieldToMain();
      }
    }

    // 收集分组
    const groups = new Map<string, string[]>();
    for (const photo of photoDetails) {
      const root = find(photo.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(photo.id);
    }

    // 只保留多张照片的组
    let similarGroupCount = 0;
    for (const [_, ids] of groups) {
      if (ids.length < 2) continue;

      // 检查是否已在 exact 重复组中
      if (!fullRebuild) {
        const hasGroup = ids.some(id => this.db.getPhotoDuplicateGroup(id));
        if (hasGroup) continue;
      }

      const photos = ids
        .map(id => this.db.getPhotoById(id))
        .filter((p): p is PhotoRow => p !== null);

      if (photos.length < 2) continue;

      const groupId = uuidv4();
      const recommended = this.selectBestPhoto(photos);
      this.db.insertDuplicateGroup({
        id: groupId,
        reason: 'similar',
        recommendedPhotoId: recommended.id,
      });

      for (const photo of photos) {
        this.db.insertPhotoDuplicate(photo.id, groupId);
      }
      similarGroupCount++;
    }

    log.info(`[Scanner] 相似图片检测完成: ${similarGroupCount} 组 (比较 ${comparisons} 对)`);
    return similarGroupCount;
  }

  private selectBestPhoto(photos: PhotoRow[]): PhotoRow {
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
