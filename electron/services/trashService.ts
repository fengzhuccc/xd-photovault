import { join, parse, dirname, basename } from 'path';
import { homedir } from 'os';
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
  // 已设置隐藏属性的回收站根目录（attrib 每个 root 只 spawn 一次，批量删除不再逐张起进程）
  private hiddenTrashRoots = new Set<string>();

  constructor(databaseService: DatabaseService, configService: ConfigService) {
    this.db = databaseService;
    this.config = configService;
  }

  /**
   * 解析照片所在盘的回收站根目录，保证"同盘移动"（rename 瞬时完成，无需跨盘复制）：
   * - 系统盘（与用户主目录同卷，通常是 C:）：卷根目录普通用户无写权限，改放用户主目录下
   * - 数据盘（D:/E: 等普通本地盘）：放卷根目录
   * - 不支持的盘（网络盘等）：返回 null，由调用方记为失败
   */
  private resolveTrashRoot(originalPath: string): string | null {
    const { root } = parse(originalPath);
    if (!root) {
      log.error('[TrashService] 无法解析照片所在磁盘:', originalPath);
      return null;
    }

    const trashRoot = root === parse(homedir()).root
      ? join(homedir(), TRASH_FOLDER_NAME)
      : join(root, TRASH_FOLDER_NAME);

    try {
      if (!existsSync(trashRoot)) {
        mkdirSync(trashRoot, { recursive: true });
      }
    } catch (error) {
      log.error('[TrashService] 所在磁盘不支持创建回收站目录:', trashRoot, error);
      return null;
    }

    if (!this.hiddenTrashRoots.has(trashRoot)) {
      setWindowsHiddenAttribute(trashRoot);
      this.hiddenTrashRoots.add(trashRoot);
    }
    return trashRoot;
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
        if (!trashRoot) {
          results.push({ id: photo.id, success: false, error: '所在磁盘不支持回收站' });
          continue;
        }
        const trashFolder = this.ensureTrashFolder(trashRoot, photo.id);
        const trashPath = join(trashFolder, photo.filename);

        this.moveFileAcrossDevices(photo.path, trashPath);
        try {
          this.writeMetadata(trashFolder, photo);
        } catch (metaError) {
          // 元数据写失败：把文件移回原路径，避免"文件已离开原位置但 DB 未标记删除"
          // 导致照片在界面上看似存在、实际打开失败且无法找回
          try {
            this.moveFileAcrossDevices(trashPath, photo.path);
            this.removeEmptyTrashFolder(trashFolder);
          } catch (rollbackError) {
            log.error('[TrashService] 回滚失败，文件滞留回收站目录:', trashPath, rollbackError);
          }
          throw metaError;
        }

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
    // 记录每张成功移动的文件信息，供 DB 更新失败时补偿回滚
    const moved: { id: string; trashPath: string; trashFolder: string; restoredPath: string }[] = [];

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

        moved.push({ id: photo.id, trashPath: photo.trash_path, trashFolder: dirname(photo.trash_path), restoredPath: targetPath });
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

    if (moved.length > 0) {
      try {
        // 按实际落点路径更新 DB（原位置冲突时文件会被改名为 "xxx (1).jpg"）
        this.db.restorePhotosFromTrash(moved.map(m => ({ id: m.id, restoredPath: m.restoredPath })));
      } catch (error) {
        log.error('[TrashService] 还原后更新数据库失败，尝试回滚文件:', error);
        // DB 更新失败：文件已移回原位置，把文件重新移回回收站目录，
        // 保持 DB（仍记录 trash_path）与文件系统一致，用户可重试恢复
        let allRolledBack = true;
        for (const m of moved) {
          try {
            if (!existsSync(m.trashFolder)) {
              mkdirSync(m.trashFolder, { recursive: true });
            }
            this.moveFileAcrossDevices(m.restoredPath, m.trashPath);
          } catch (rollbackError) {
            allRolledBack = false;
            log.error('[TrashService] 回滚失败，文件留在原位置但 DB 仍指向回收站:', m.restoredPath, rollbackError);
          }
        }
        for (const result of results) {
          if (result.success) {
            if (allRolledBack) {
              result.success = false;
              result.error = '数据库更新失败';
            } else {
              result.success = false;
              result.error = '数据库更新失败（部分文件已还原到原位置，请重试）';
            }
          }
        }
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
      // onlyTrashed：防止"永久删除执行中（trashItem await 让出事件循环）照片被并发恢复"
      // 的竞态——恢复后 deleted_at 已置 NULL，无条件 DELETE 会把已恢复照片的记录一并删掉
      this.db.deletePhotosBatch(deletedIds, { onlyTrashed: true });
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
