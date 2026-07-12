import { join, parse, dirname, basename } from 'path';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { shell } from 'electron';
import log from 'electron-log';
import type { DatabaseService, PhotoRow } from './database';
import type { ConfigService } from './config';

function setWindowsHiddenAttribute(targetPath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const result = spawnSync('attrib', ['+h', targetPath], { encoding: 'utf-8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `attrib exited with ${result.status}`);
    }
  } catch (e) {
    log.warn('[TrashService] 设置隐藏属性失败:', targetPath, e);
  }
}

export interface TrashMoveResult {
  id: string;
  success: boolean;
  trashPath?: string;
  error?: string;
}

export interface TrashRestoreResult {
  id: string;
  success: boolean;
  restoredPath?: string;
  error?: string;
}

export interface TrashStats {
  count: number;
  totalSize: number;
}

const TRASH_FOLDER_NAME = '.xd-photovault-trash';
const METADATA_FILE = '.metadata.json';

export class TrashService {
  private db: DatabaseService;
  private config: ConfigService;

  constructor(databaseService: DatabaseService, configService: ConfigService) {
    this.db = databaseService;
    this.config = configService;
  }

  private resolveTrashRoot(originalPath: string): string {
    const { root } = parse(originalPath);
    if (root) {
      const trashRoot = join(root, TRASH_FOLDER_NAME);
      if (!existsSync(trashRoot)) {
        mkdirSync(trashRoot, { recursive: true });
      }
      setWindowsHiddenAttribute(trashRoot);
      return trashRoot;
    }

    // 兜底：使用数据目录下的回收站
    const fallback = join(this.config.getDataPath(), TRASH_FOLDER_NAME);
    if (!existsSync(fallback)) {
      mkdirSync(fallback, { recursive: true });
    }
    setWindowsHiddenAttribute(fallback);
    return fallback;
  }

  private ensureTrashFolder(trashRoot: string, photoId: string): string {
    const folder = join(trashRoot, photoId);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
    return folder;
  }

  private writeMetadata(trashFolder: string, photo: PhotoRow): void {
    const metadata = {
      photoId: photo.id,
      originalPath: photo.original_path || photo.path,
      originalFileName: photo.filename,
      deletedAt: photo.deleted_at,
      fileSize: photo.file_size,
    };
    writeFileSync(join(trashFolder, METADATA_FILE), JSON.stringify(metadata, null, 2), 'utf-8');
  }

  private deleteMetadata(trashFolder: string): void {
    const metadataPath = join(trashFolder, METADATA_FILE);
    if (existsSync(metadataPath)) {
      rmSync(metadataPath);
    }
  }

  private removeEmptyTrashFolder(trashFolder: string): void {
    try {
      if (existsSync(trashFolder)) {
        rmdirSync(trashFolder);
      }
    } catch {
      // 文件夹非空或已被删除，忽略
    }
  }

  private moveFileAcrossDevices(src: string, dest: string): void {
    try {
      renameSync(src, dest);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EXDEV') {
        // 跨盘移动：先复制再删除原文件
        copyFileSync(src, dest);
        rmSync(src);
      } else {
        throw error;
      }
    }
  }

  private ensureUniquePath(targetPath: string): string {
    if (!existsSync(targetPath)) {
      return targetPath;
    }
    const ext = parse(targetPath).ext;
    const base = targetPath.slice(0, targetPath.length - ext.length);
    let counter = 1;
    let candidate = `${base} (${counter})${ext}`;
    while (existsSync(candidate)) {
      counter++;
      candidate = `${base} (${counter})${ext}`;
    }
    return candidate;
  }

  async moveToTrash(photoIds: string[]): Promise<TrashMoveResult[]> {
    if (photoIds.length === 0) return [];

    const photos = this.db.getPhotosByIds(photoIds);
    const results: TrashMoveResult[] = [];
    const dbEntries: { id: string; trashPath: string }[] = [];

    for (const photo of photos) {
      try {
        if (!existsSync(photo.path)) {
          results.push({ id: photo.id, success: false, error: '原文件不存在' });
          continue;
        }

        const trashRoot = this.resolveTrashRoot(photo.original_path || photo.path);
        const trashFolder = this.ensureTrashFolder(trashRoot, photo.id);
        const trashPath = join(trashFolder, photo.filename);

        this.moveFileAcrossDevices(photo.path, trashPath);
        this.writeMetadata(trashFolder, photo);

        dbEntries.push({ id: photo.id, trashPath });
        results.push({ id: photo.id, success: true, trashPath });
      } catch (error) {
        log.error('[TrashService] 移入回收站失败:', photo.id, error);
        results.push({ id: photo.id, success: false, error: String(error) });
      }
    }

    if (dbEntries.length > 0) {
      this.db.movePhotosToTrash(dbEntries);
    }

    return results;
  }

  async restoreFromTrash(photoIds: string[]): Promise<TrashRestoreResult[]> {
    if (photoIds.length === 0) return [];

    const photos = this.db.getTrashedPhotosByIds(photoIds);
    const results: TrashRestoreResult[] = [];
    const restoredIds: string[] = [];

    for (const photo of photos) {
      try {
        if (!photo.original_path) {
          results.push({ id: photo.id, success: false, error: '缺少原路径信息' });
          continue;
        }
        if (!photo.trash_path || !existsSync(photo.trash_path)) {
          results.push({ id: photo.id, success: false, error: '回收站文件不存在' });
          continue;
        }

        const targetDir = dirname(photo.original_path);
        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
        }

        const targetPath = this.ensureUniquePath(photo.original_path);
        this.moveFileAcrossDevices(photo.trash_path, targetPath);

        restoredIds.push(photo.id);
        results.push({ id: photo.id, success: true, restoredPath: targetPath });

        // 清理空回收站子文件夹
        const trashFolder = dirname(photo.trash_path);
        this.deleteMetadata(trashFolder);
        this.removeEmptyTrashFolder(trashFolder);
      } catch (error) {
        log.error('[TrashService] 还原失败:', photo.id, error);
        results.push({ id: photo.id, success: false, error: String(error) });
      }
    }

    if (restoredIds.length > 0) {
      try {
        this.db.restorePhotosFromTrash(restoredIds);
      } catch (error) {
        log.error('[TrashService] 还原后更新数据库失败:', error);
        for (const result of results) {
          if (result.success) {
            result.success = false;
            result.error = '数据库更新失败';
          }
        }
        restoredIds.length = 0;
      }
    }

    return results;
  }

  private async moveToSystemTrash(filePath: string): Promise<void> {
    await shell.trashItem(filePath);
  }

  async permanentDelete(photoIds: string[]): Promise<{ id: string; success: boolean; error?: string }[]> {
    if (photoIds.length === 0) return [];

    const photos = this.db.getTrashedPhotosByIds(photoIds);
    const results: { id: string; success: boolean; error?: string }[] = [];
    const deletedIds: string[] = [];

    for (const photo of photos) {
      try {
        if (photo.trash_path && existsSync(photo.trash_path)) {
          await this.moveToSystemTrash(photo.trash_path);
        }

        // 删除缩略图
        if (photo.thumbnail_path && existsSync(photo.thumbnail_path)) {
          await this.moveToSystemTrash(photo.thumbnail_path);
        }

        // 清理回收站子文件夹
        if (photo.trash_path) {
          const trashFolder = dirname(photo.trash_path);
          this.deleteMetadata(trashFolder);
          this.removeEmptyTrashFolder(trashFolder);
        }

        deletedIds.push(photo.id);
        results.push({ id: photo.id, success: true });
      } catch (error) {
        log.error('[TrashService] 彻底删除失败:', photo.id, error);
        results.push({ id: photo.id, success: false, error: String(error) });
      }
    }

    if (deletedIds.length > 0) {
      this.db.deletePhotosBatch(deletedIds);
    }

    return results;
  }

  async emptyTrash(): Promise<{ id: string; success: boolean; error?: string }[]> {
    const photos = this.db.getTrashedPhotos();
    return this.permanentDelete(photos.map(p => p.id));
  }

  listTrash(): PhotoRow[] {
    return this.db.getTrashedPhotos();
  }

  getStats(): TrashStats {
    return this.db.getTrashStats();
  }

  getCount(): number {
    return this.db.getTrashCount();
  }
}
