import { readdir, stat } from 'fs/promises';
import { join, extname, sep } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { shell } from 'electron';
import { DatabaseService, PhotoRow, PhotoInsert } from './database';
import { HashService } from './hash';
import { ExifService } from './exif';
import { ThumbnailService } from './thumbnail';
import log from 'electron-log';

const SUPPORTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.raw', '.cr2', '.nef', '.arw'];

// 进度上报间隔（每N张上报一次）
const PROGRESS_INTERVAL = 200;
// 扫描状态写入数据库间隔（每N张写一次）
const SCAN_STATUS_INTERVAL = 200;
// 增量扫描时，每批查询已有记录的路径数量（避免一次性加载整个文件夹）
const PATH_BATCH_SIZE = 500;
// 清理已删除照片记录时，每批处理数量
const DELETE_BATCH_SIZE = 1000;
// 机械硬盘等 I/O 受限场景下，扫描并发不宜过高，避免磁头来回寻道
const THUMBNAIL_WORKER_CONCURRENCY = 1;
const FILE_WORKER_CONCURRENCY = 2;
// 扫描期间不实时生成缩略图，扫描结束后统一后台生成，避免 I/O 争抢
const DEFER_THUMBNAILS_DURING_SCAN = true;

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

export interface DuplicateProgress {
  stage: 'hashing' | 'exact' | 'similar' | 'complete';
  current: number;
  total: number;
  message: string;
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
  private activeScanFolderId: string | null = null;
  private cancelRequested = false;
  private thumbnailQueue: Array<{ id: string; path: string }> = [];
  private thumbnailWorkersActive = false;
  onProgress?: (progress: DuplicateProgress) => void;

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

  private emitDuplicateProgress(progress: DuplicateProgress): void {
    try {
      this.onProgress?.(progress);
    } catch (e) {
      log.warn('[Scanner] 上报去重进度失败', e);
    }
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  /**
   * 请求停止对指定文件夹的扫描，并等待扫描真正结束。
   * 同时清理该文件夹下照片未处理的缩略图任务。
   */
  async stopScan(folderId: string): Promise<void> {
    if (this.activeScanFolderId !== folderId) {
      return;
    }
    this.cancelRequested = true;
    log.info(`[Scanner] 请求停止扫描文件夹: ${folderId}`);

    // 清理该文件夹未处理的缩略图任务
    const folder = this.db.getFolderById(folderId);
    if (folder) {
      this.clearThumbnailQueueForFolder(folder.path);
    }

    // 等待扫描循环结束
    while (this.scanning) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private clearThumbnailQueueForFolder(folderPath: string): void {
    const prefix = folderPath.endsWith(sep) ? folderPath : folderPath + sep;
    this.thumbnailQueue = this.thumbnailQueue.filter(item => !item.path.startsWith(prefix));
  }

  private checkCancelled(folderId: string): boolean {
    if (!this.cancelRequested || this.activeScanFolderId !== folderId) {
      return false;
    }
    log.info(`[Scanner] 扫描已取消，提前结束: ${folderId}`);
    return true;
  }

  private completeScanEarly(
    folderId: string,
    onProgress: (progress: ScanProgress) => void,
    reason: 'cancelled' | 'folder_deleted'
  ): { totalPhotos: number; skipped: number } {
    log.info(`[Scanner] 扫描提前结束 (${reason}): ${folderId}`);
    // 如果 folder 仍存在（仅取消而非删除），把状态重置为 idle
    if (reason === 'cancelled' && this.db.getFolderById(folderId)) {
      this.db.updateFolderScanStatus(folderId, 'idle', 0, 0, '');
    }
    // 通知 UI 扫描已结束，让 LibraryPage 重置 isScanning
    onProgress({ current: 0, total: 0, currentFile: '', status: 'complete' });
    return { totalPhotos: 0, skipped: 0 };
  }

  /**
   * 处理单张照片：stat → 检查是否变化 → EXIF + hash → 入队缩略图。
   * 返回 'skipped' 表示未变化跳过；null 表示处理失败；否则返回 photo 和 hash。
   */
  private async processSingleFile(
    filePath: string,
    folderId: string,
    existingPathMap: Map<string, { id: string; fileHash: string | null; fileSize: number; modifiedTime: string }>,
    forceRescan: boolean
  ): Promise<{ photo: PhotoInsert; hash: string } | 'skipped' | null> {
    if (this.checkCancelled(folderId)) return null;

    try {
      const stats = await stat(filePath);

      const existing = existingPathMap.get(filePath);
      if (!forceRescan && existing
        && existing.fileSize === stats.size
        && existing.modifiedTime === stats.mtime.toISOString()) {
        return 'skipped';
      }

      if (existing) {
        this.db.deletePhoto(existing.id);
      }

      const [exifData, fileHash] = await Promise.all([
        this.exifService.extractExif(filePath),
        this.hashService.calculateFileHash(filePath),
      ]);

      const photoId = existing?.id || uuidv4();
      const takenAt = exifData.takenAt || stats.mtime;

      const photo: PhotoInsert = {
        id: photoId,
        folderId,
        path: filePath,
        filename: filePath.split(/[/\\]/).pop() || '',
        fileSize: stats.size,
        fileHash,
        perceptualHash: null,
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
        thumbnailPath: null,
        modifiedTime: stats.mtime.toISOString(),
      };

      // 机械硬盘场景：扫描期间不入队实时缩略图，扫描结束后统一生成
      if (!DEFER_THUMBNAILS_DURING_SCAN) {
        this.enqueueThumbnail(photoId, filePath);
      }
      return { photo, hash: fileHash };
    } catch (error) {
      log.warn(`[Scanner] 处理文件失败: ${filePath}`, error);
      return null;
    }
  }

  /**
   * 使用 worker pool 并发处理一批文件。
   * 每个 worker 维护自己的 DB 写入批次，避免集中 flush 阻塞主循环。
   */
  private async processFilesConcurrently(
    files: string[],
    folderId: string,
    existingPathMap: Map<string, { id: string; fileHash: string | null; fileSize: number; modifiedTime: string }>,
    forceRescan: boolean,
    total: number,
    processedCountRef: { count: number },
    onProgress: (progress: ScanProgress) => void
  ): Promise<{ hashes: string[]; photoIds: string[]; newCount: number; skipped: number }> {
    const queue = [...files];
    const hashes: string[] = [];
    const photoIds: string[] = [];
    let newCount = 0;
    let skipped = 0;

    const worker = async () => {
      const localBatch: PhotoInsert[] = [];

      while (true) {
        const filePath = queue.shift();
        if (!filePath) break;
        if (this.checkCancelled(folderId)) break;

        const result = await this.processSingleFile(filePath, folderId, existingPathMap, forceRescan);
        processedCountRef.count++;

        if (result === 'skipped') {
          skipped++;
        } else if (result) {
          hashes.push(result.hash);
          photoIds.push(result.photo.id);
          newCount++;
          localBatch.push(result.photo);
        }

        // 进度上报（全 worker 共享计数）
        if (processedCountRef.count % PROGRESS_INTERVAL === 0 || processedCountRef.count === total) {
          onProgress({
            current: processedCountRef.count,
            total,
            currentFile: filePath.split(/[/\\]/).pop() || filePath,
            status: 'scanning',
          });
        }

        // 扫描状态写入数据库
        if (processedCountRef.count > 0 && processedCountRef.count % SCAN_STATUS_INTERVAL === 0) {
          this.db.updateFolderScanStatus(folderId, 'scanning', total, processedCountRef.count, filePath);
        }

        // 分批写入数据库，避免内存堆积
        if (localBatch.length >= 50) {
          this.db.insertPhotos(localBatch);
          localBatch.length = 0;
        }

        // 让出事件循环，避免阻塞 UI 和其他 IPC
        if (processedCountRef.count % 10 === 0) {
          await yieldToMain();
        }
      }

      if (localBatch.length > 0) {
        this.db.insertPhotos(localBatch);
      }
    };

    const workers = Array.from({ length: FILE_WORKER_CONCURRENCY }, () => worker());
    await Promise.all(workers);

    return { hashes, photoIds, newCount, skipped };
  }

  /**
   * 扫描过程中实时入队生成缩略图，不阻塞主扫描循环。
   */
  private enqueueThumbnail(photoId: string, photoPath: string): void {
    this.thumbnailQueue.push({ id: photoId, path: photoPath });
    this.startThumbnailWorkers();
  }

  private startThumbnailWorkers(): void {
    if (this.thumbnailWorkersActive) return;
    this.thumbnailWorkersActive = true;

    const workers = Array.from({ length: THUMBNAIL_WORKER_CONCURRENCY }, () => this.thumbnailWorker());
    Promise.all(workers).then(() => {
      this.thumbnailWorkersActive = false;
      // 如果扫描期间又入队了新任务，继续消费
      if (this.thumbnailQueue.length > 0) {
        this.startThumbnailWorkers();
      }
    });
  }

  private async thumbnailWorker(): Promise<void> {
    while (this.thumbnailQueue.length > 0) {
      const item = this.thumbnailQueue.shift();
      if (!item) continue;

      // 生成前先确认照片仍在数据库中，避免扫描取消/文件夹删除后生成孤儿缩略图
      const photo = this.db.getPhotoById(item.id);
      if (!photo) continue;

      try {
        await this.thumbnailService.getThumbnail(item.id, item.path, 'small');
      } catch (e) {
        log.warn(`[Scanner] 实时缩略图生成失败: ${item.path}`, e);
      }
      // 让出事件循环，避免缩略图生成阻塞主进程
      await yieldToMain();
    }
  }

  /**
   * 扫描结束后统一后台生成缩略图，适用于机械硬盘等 I/O 受限场景。
   * 分批从数据库读取照片路径，避免一次性加载大量记录到内存。
   */
  private async generateThumbnailsAfterScan(photoIds: string[]): Promise<void> {
    log.info(`[Scanner] 扫描结束后统一生成 ${photoIds.length} 张缩略图`);
    const BATCH = 100;
    for (let i = 0; i < photoIds.length; i += BATCH) {
      const batchIds = photoIds.slice(i, i + BATCH);
      const photos = this.db.getPhotosByIds(batchIds);
      const items = photos
        .filter((p): p is PhotoRow => p !== null)
        .map(p => ({ photoId: p.id, photoPath: p.path, size: 'small' as const }));
      if (items.length > 0) {
        await this.thumbnailService.getThumbnailsBatch(items, 2);
      }
      await yieldToMain();
    }
    log.info(`[Scanner] 扫描结束后缩略图生成完成`);
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
    this.activeScanFolderId = folderId;
    this.cancelRequested = false;
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

      // 第二步：分批处理文件，同时按批次查询已有记录，避免一次性加载整个文件夹
      const newHashes: string[] = [];
      const newPhotoIds: string[] = [];
      const seenPaths = new Set(files);
      let skipped = 0;
      let newCount = 0;
      const processedCountRef = { count: 0 };

      for (let batchStart = 0; batchStart < files.length; batchStart += PATH_BATCH_SIZE) {
        // 检查是否已取消，或 folder 已被删除
        if (this.checkCancelled(folderId)) {
          return this.completeScanEarly(folderId, onProgress, 'cancelled');
        }
        if (!this.db.getFolderById(folderId)) {
          return this.completeScanEarly(folderId, onProgress, 'folder_deleted');
        }

        const batchEnd = Math.min(batchStart + PATH_BATCH_SIZE, files.length);
        const batchFiles = files.slice(batchStart, batchEnd);

        // 查询本批次文件的已有记录（避免加载整个文件夹的所有照片）
        const existingPathMap = new Map<string, { id: string; fileHash: string | null; fileSize: number; modifiedTime: string }>();
        if (!forceRescan) {
          const existingRows = this.db.getPhotosByPaths(batchFiles);
          for (const p of existingRows) {
            existingPathMap.set(p.path, {
              id: p.id,
              fileHash: p.file_hash,
              fileSize: p.file_size,
              modifiedTime: p.modified_time || '',
            });
          }
        }

        // 使用 worker pool 并发处理本批次文件
        const batchResult = await this.processFilesConcurrently(
          batchFiles,
          folderId,
          existingPathMap,
          forceRescan,
          total,
          processedCountRef,
          onProgress
        );

        newHashes.push(...batchResult.hashes);
        newPhotoIds.push(...batchResult.photoIds);
        newCount += batchResult.newCount;
        skipped += batchResult.skipped;

        await yieldToMain();
      }

      // 如果文件夹已被删除，跳过后续清理和状态更新
      if (this.checkCancelled(folderId)) {
        return this.completeScanEarly(folderId, onProgress, 'cancelled');
      }
      if (!this.db.getFolderById(folderId)) {
        return this.completeScanEarly(folderId, onProgress, 'folder_deleted');
      }

      // 删除不再存在的照片（分页查询，避免加载整个文件夹）
      let deletedCount = 0;
      let offset = 0;
      while (true) {
        const batch = this.db.getPhotoPathsByFolder(folderId, DELETE_BATCH_SIZE, offset);
        if (batch.length === 0) break;

        const toDelete = batch.filter(p => !seenPaths.has(p.path));
        if (toDelete.length > 0) {
          const deletedIds = toDelete.map(p => p.id);
          this.thumbnailService.deleteThumbnailsByPhotoIds(deletedIds);
          this.db.deletePhotosBatch(deletedIds);
          deletedCount += toDelete.length;
        }

        offset += batch.length;
        if (batch.length < DELETE_BATCH_SIZE) break;
        await yieldToMain();
      }
      if (deletedCount > 0) {
        log.info(`[Scanner] 删除 ${deletedCount} 个不存在的照片记录`);
      }

      // 如果文件夹已被删除，不再更新状态或触发去重
      if (this.checkCancelled(folderId)) {
        return this.completeScanEarly(folderId, onProgress, 'cancelled');
      }
      if (!this.db.getFolderById(folderId)) {
        return this.completeScanEarly(folderId, onProgress, 'folder_deleted');
      }

      // S7: 使用 SELECT COUNT(*) 代替加载全部照片
      const totalPhotos = this.db.getPhotoCountByFolder(folderId);
      this.db.updateFolderScanTime(folderId, totalPhotos);

      // 先发送扫描完成事件，再去重检测（去重可能耗时较长，不应阻塞完成通知）
      log.info(`[Scanner] 扫描完成: 总计 ${totalPhotos} 张, 新增 ${newCount} 张, 跳过 ${skipped} 张, 删除 ${deletedCount} 张`);
      onProgress({ current: total, total, currentFile: '', status: 'complete', newCount, skipped, deletedCount });

      // 扫描完成后异步触发增量精确去重（相似去重需用户手动触发）
      if (newCount > 0 || deletedCount > 0) {
        this.detectExactDuplicates(false, newHashes).catch(err => {
          log.error('[Scanner] 后台精确去重检测失败:', err);
        });
      }

      // 机械硬盘场景：扫描期间未实时生成缩略图，扫描结束后统一后台生成
      if (DEFER_THUMBNAILS_DURING_SCAN && newPhotoIds.length > 0) {
        this.generateThumbnailsAfterScan(newPhotoIds).catch(err => {
          log.error('[Scanner] 扫描后批量生成缩略图失败:', err);
        });
      }

      return { totalPhotos, skipped };
    } finally {
      this.scanning = false;
      this.activeScanFolderId = null;
      this.cancelRequested = false;
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

  /**
   * 全量去重前，将旧版 MD5 file_hash 迁移为 xxhash64。
   * 增量扫描时新文件已使用 xxhash64，无需迁移。
   */
  private async migrateLegacyHashes(): Promise<number> {
    const BATCH = 200;
    let migrated = 0;
    let offset = 0;

    while (true) {
      const photos = this.db.getPhotosWithLegacyMd5Hashes(BATCH, offset);
      if (photos.length === 0) break;

      for (const photo of photos) {
        try {
          const newHash = await this.hashService.calculateFileHash(photo.path);
          this.db.updatePhotoFileHash(photo.id, newHash);
          migrated++;
        } catch (error) {
          log.warn(`[Scanner] 迁移旧 hash 失败: ${photo.path}`, error);
        }
      }

      offset += photos.length;
      await yieldToMain();
      if (photos.length < BATCH) break;
    }

    if (migrated > 0) {
      log.info(`[Scanner] 已迁移 ${migrated} 张旧照片 hash 为 xxhash64`);
    }
    return migrated;
  }

  async detectDuplicates(fullRebuild: boolean = true, newHashes: string[] = []): Promise<number> {
    return this.detectDuplicatesWithMode(fullRebuild, 'all', newHashes);
  }

  async detectExactDuplicates(fullRebuild: boolean = true, newHashes: string[] = []): Promise<number> {
    return this.detectDuplicatesWithMode(fullRebuild, 'exact', newHashes);
  }

  async detectSimilarDuplicates(fullRebuild: boolean = true): Promise<number> {
    return this.detectDuplicatesWithMode(fullRebuild, 'similar', []);
  }

  private async detectDuplicatesWithMode(
    fullRebuild: boolean,
    mode: 'exact' | 'similar' | 'all',
    newHashes: string[] = []
  ): Promise<number> {
    log.info(`[Scanner] 开始检测重复照片 (mode=${mode}, fullRebuild=${fullRebuild}, newHashes=${newHashes.length})...`);

    if (fullRebuild) {
      await this.migrateLegacyHashes();
      if (mode === 'all') {
        this.db.clearDuplicateGroups();
      } else if (mode === 'exact') {
        this.db.clearDuplicateGroupsByReason('exact');
      } else if (mode === 'similar') {
        this.db.clearDuplicateGroupsByReason('similar');
      }
    }

    if (mode !== 'exact') {
      await this.ensurePerceptualHashes();
    }

    let groupCount = 0;

    if (mode === 'exact' || mode === 'all') {
      groupCount += await this.runExactDuplicateDetection(fullRebuild, newHashes);
    }

    if (mode === 'similar' || mode === 'all') {
      const similarCount = await this.runSimilarDuplicateDetection(fullRebuild);
      groupCount += similarCount;
    }

    this.emitDuplicateProgress({ stage: 'complete', current: 1, total: 1, message: '去重检测完成' });
    log.info(`[Scanner] 检测到 ${groupCount} 组重复/相似照片`);
    return groupCount;
  }

  private async runExactDuplicateDetection(fullRebuild: boolean, newHashes: string[]): Promise<number> {
    this.emitDuplicateProgress({ stage: 'exact', current: 0, total: 0, message: '正在检测精确重复...' });

    const exactDuplicates = fullRebuild
      ? this.db.findExactDuplicates()
      : this.db.findExactDuplicatesByHashes(newHashes);

    const total = exactDuplicates.length;
    const newGroups: { id: string; recommendedPhotoId: string; photoIds: string[] }[] = [];

    for (let i = 0; i < exactDuplicates.length; i++) {
      const dup = exactDuplicates[i];
      const photoIds = dup.photo_ids.split(',');
      const photoMap = new Map(this.db.getPhotosByIds(photoIds).map(p => [p.id, p]));

      if (fullRebuild) {
        const photos = photoIds
          .map((id: string) => photoMap.get(id))
          .filter((p): p is PhotoRow => p !== null);

        if (photos.length > 1) {
          const recommended = this.selectBestPhoto(photos);
          newGroups.push({
            id: uuidv4(),
            recommendedPhotoId: recommended.id,
            photoIds: photos.map(p => p.id),
          });
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
            .map((id: string) => photoMap.get(id))
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
            }

            for (const photoId of ungroupedPhotos) {
              this.db.insertPhotoDuplicate(photoId, groupId);
            }
          }
        }
      }

      if ((i + 1) % 100 === 0 || i === total - 1) {
        this.emitDuplicateProgress({
          stage: 'exact',
          current: i + 1,
          total,
          message: `正在检测精确重复 ${i + 1}/${total}`
        });
        await yieldToMain();
      }
    }

    // 全量模式下，原子性批量写入：先清空旧 exact 组，再写入所有新组
    if (fullRebuild && newGroups.length > 0) {
      this.db.rebuildDuplicateGroups('exact', newGroups);
    }

    log.info(`[Scanner] 精确重复检测完成: ${newGroups.length} 组`);
    return newGroups.length;
  }

  /**
   * 确保所有照片都有 perceptual_hash，缺失的按需并发计算。
   * 使用 2 个并发 worker（适配机械硬盘），避免单线程顺序等待。
   */
  private async ensurePerceptualHashes(): Promise<void> {
    const photos = this.db.getPhotosWithoutPHash();
    if (photos.length === 0) return;

    const CONCURRENCY = 2;
    log.info(`[Scanner] 需要计算 ${photos.length} 张照片的感知哈希 (并发=${CONCURRENCY})...`);
    let computed = 0;
    let failed = 0;
    let index = 0;

    const worker = async () => {
      while (index < photos.length) {
        const photo = photos[index++];
        try {
          const phash = await this.hashService.calculatePerceptualHash(photo.path);
          this.db.updatePhotoPerceptualHash(photo.id, phash);
          computed++;
        } catch (error) {
          failed++;
          log.warn(`[Scanner] 计算感知哈希失败: ${photo.path}`, error);
        }

        if ((computed + failed) % 50 === 0) {
          this.emitDuplicateProgress({
            stage: 'hashing',
            current: computed + failed,
            total: photos.length,
            message: `正在计算感知哈希 ${computed + failed}/${photos.length}`
          });
          await yieldToMain();
          log.info(`[Scanner] 已计算 ${computed}/${photos.length} 张照片的感知哈希`);
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONCURRENCY, photos.length) }, () => worker());
    await Promise.all(workers);

    log.info(`[Scanner] 感知哈希计算完成: 成功 ${computed}, 失败 ${failed}, 总计 ${photos.length}`);
  }

  /**
   * 基于 pHash 的 LSH（局部敏感哈希）检测相似图片。
   * 把 64 位 pHash 分成 4 个 16 位 band，共享任一 band 的照片才进入汉明距离精细比较，
   * 将 O(n²) 降为接近 O(n)。
   * 阈值 < 10 视为相似（64 位哈希中差异不超过 10 位）
   */
  private async runSimilarDuplicateDetection(fullRebuild: boolean): Promise<number> {
    this.emitDuplicateProgress({ stage: 'similar', current: 0, total: 0, message: '正在检测相似图片...' });

    // 标记相似去重正在执行；如果中断，启动时会清理可能不完整的相似组
    this.db.setDuplicateDetectionDirty('similar', true);

    const PHASH_THRESHOLD = 10;
    const LSH_BANDS = 4;
    const LSH_BAND_SIZE = 16; // 64 / 4
    const BATCH_SIZE = 5000;

    // 统计有 pHash 的照片总数
    const totalCount = this.db.getPhotoCountWithPHash();

    if (totalCount < 2) return 0;

    log.info(`[Scanner] 开始相似图片检测 (LSH): ${totalCount} 张照片有 pHash`);

    // Union-Find
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

    const phashMap = new Map<string, string>();
    const fileSizeMap = new Map<string, number>();
    const lshBuckets = new Map<string, Set<string>>();
    const ZERO_PREFIX = '0'.repeat(16);

    // 第一趟：分批读取 pHash，构建 LSH 桶
    let loaded = 0;
    let offset = 0;
    while (offset < totalCount) {
      const batch = this.db.getPhotoHashBatch(BATCH_SIZE, offset);
      for (const row of batch) {
        const phash = row.perceptual_hash;
        if (!phash || phash === '0'.repeat(64)) continue;

        phashMap.set(row.id, phash);
        fileSizeMap.set(row.id, row.file_size);

        for (let i = 0; i < LSH_BANDS; i++) {
          const band = phash.slice(i * LSH_BAND_SIZE, (i + 1) * LSH_BAND_SIZE);
          // 跳过全 0 band，避免产生超大桶
          if (band === ZERO_PREFIX) continue;
          const key = `${i}_${band}`;
          if (!lshBuckets.has(key)) lshBuckets.set(key, new Set());
          lshBuckets.get(key)!.add(row.id);
        }
      }
      loaded += batch.length;
      offset += BATCH_SIZE;
      if (loaded % 20000 === 0) {
        this.emitDuplicateProgress({
          stage: 'similar',
          current: loaded,
          total: totalCount,
          message: `正在构建相似索引 ${loaded}/${totalCount}`
        });
        await yieldToMain();
        log.info(`[Scanner] LSH 建桶进度: ${loaded}/${totalCount}`);
      }
    }

    // 第二趟：在每个桶内做精细汉明距离比较
    let comparisons = 0;
    let bucketIndex = 0;
    for (const [, ids] of lshBuckets) {
      if (ids.size < 2) continue;

      const idList = Array.from(ids);
      // 额外按文件大小排序，大小差 2 倍以上跳过，减少无效比较
      idList.sort((a, b) => fileSizeMap.get(a)! - fileSizeMap.get(b)!);

      for (let i = 0; i < idList.length; i++) {
        const a = idList[i];
        const ha = phashMap.get(a)!;
        for (let j = i + 1; j < idList.length; j++) {
          const b = idList[j];
          // 文件大小差超过 2 倍，后续都更大，跳过
          if (fileSizeMap.get(b)! > fileSizeMap.get(a)! * 2) break;

          // 已在同一组则跳过
          if (find(a) === find(b)) continue;

          const distance = this.hashService.hammingDistance(ha, phashMap.get(b)!);
          if (distance < PHASH_THRESHOLD) {
            union(a, b);
          }

          comparisons++;
          if (comparisons % 50000 === 0) {
            await yieldToMain();
          }
        }
      }

      bucketIndex++;
      if (bucketIndex % 500 === 0) {
        await yieldToMain();
      }
    }

    // 收集分组
    const groups = new Map<string, string[]>();
    for (const id of phashMap.keys()) {
      const root = find(id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(id);
    }

    // 只保留多张照片的组
    // 先收集所有需要查库的 photoId，避免每组内部逐条查询
    const candidateGroups: string[][] = [];
    for (const [, ids] of groups) {
      if (ids.length < 2) continue;
      candidateGroups.push(ids);
    }

    const allNeededIds = fullRebuild
      ? candidateGroups.flat()
      : candidateGroups
          .filter(ids => !ids.some(id => this.db.getPhotoDuplicateGroup(id)))
          .flat();

    const photoMap = new Map(this.db.getPhotosByIds(allNeededIds).map(p => [p.id, p]));

    const newGroups: { id: string; recommendedPhotoId: string; photoIds: string[] }[] = [];
    for (const ids of candidateGroups) {
      // 增量模式下，只要组内任一照片已在重复组中就跳过整组
      if (!fullRebuild && ids.some(id => this.db.getPhotoDuplicateGroup(id))) continue;

      const photos = ids
        .map(id => photoMap.get(id))
        .filter((p): p is PhotoRow => p !== undefined);

      if (photos.length < 2) continue;

      const recommended = this.selectBestPhoto(photos);
      newGroups.push({
        id: uuidv4(),
        recommendedPhotoId: recommended.id,
        photoIds: photos.map(p => p.id),
      });

      if (newGroups.length % 100 === 0) {
        this.emitDuplicateProgress({
          stage: 'similar',
          current: newGroups.length,
          total: candidateGroups.length,
          message: `已生成 ${newGroups.length} 组相似照片`
        });
        await yieldToMain();
      }
    }

    if (fullRebuild) {
      // 全量模式：原子性替换所有相似组（包括清空旧组）
      this.db.rebuildDuplicateGroups('similar', newGroups);
    } else {
      // 增量模式：只追加新组
      for (const g of newGroups) {
        this.db.insertDuplicateGroup({ id: g.id, reason: 'similar', recommendedPhotoId: g.recommendedPhotoId });
        for (const photoId of g.photoIds) {
          this.db.insertPhotoDuplicate(photoId, g.id);
        }
      }
    }

    // 成功完成后清除脏标记
    this.db.setDuplicateDetectionDirty('similar', false);

    log.info(`[Scanner] 相似图片检测完成: ${newGroups.length} 组 (比较 ${comparisons} 对，桶数 ${lshBuckets.size})`);
    return newGroups.length;
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
    const photos = this.db.getPhotosByIds(photoIds);
    if (photos.length === 0) return;

    // 移动文件到回收站（顺序执行，避免文件系统竞争）
    for (const photo of photos) {
      try {
        await shell.trashItem(photo.path);
      } catch (e) {
        log.warn(`[Scanner] 移动文件到回收站失败: ${photo.path}`, e);
      }
    }

    // 批量删除缩略图文件（含新版多尺寸和旧版无分片）
    this.thumbnailService.deleteThumbnailsByPhotoIds(photos.map(p => p.id));

    // 批量删除数据库记录
    this.db.deletePhotosBatch(photos.map(p => p.id));
  }
}
