import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import log from 'electron-log';

function compareDateDesc(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return b.localeCompare(a);
}

/**
 * 面向渲染端的照片列清单（Photo 类型契约）。
 * 浏览/回收站/重复组等列表查询只取这些列，减少 IPC 序列化负载；
 * 详情弹窗走 photo:getById（getPhotoById 全列）。
 * 新增渲染端依赖的列时需同步更新 src/types 的 Photo 类型。
 */
const PHOTO_LIST_COLUMNS = `
  id, folder_id, path, filename, file_size, taken_at,
  latitude, longitude, width, height, camera, media_type,
  duration, frame_hash, deleted_at, original_path, trash_path
`;

export interface PhotoRow {
  id: string;
  folder_id: string;
  path: string;
  filename: string;
  file_size: number;
  file_hash: string | null;
  perceptual_hash: string | null;
  taken_at: string | null;
  modified_time: string | null;
  latitude: number | null;
  longitude: number | null;
  camera: string | null;
  aperture: string | null;
  shutter_speed: string | null;
  iso: number | null;
  focal_length: string | null;
  width: number | null;
  height: number | null;
  thumbnail_path: string | null;
  media_type: 'image' | 'video';
  duration: number | null;
  frame_hash: string | null;
  image_seed: string | null;
  deleted_at: string | null;
  original_path: string | null;
  trash_path: string | null;
  created_at: string;
  updated_at: string;
}

interface FolderRow {
  id: string;
  path: string;
  added_at: string;
  last_scanned: string | null;
  photo_count: number;
  scan_status: string | null;
  scan_total: number | null;
  scan_processed: number | null;
  scan_last_path: string | null;
}

interface DuplicateGroupRow {
  id: string;
  reason: 'exact' | 'similar';
  recommended_photo_id: string;
  created_at: string;
}

interface PhotoDuplicateRow {
  photo_id: string;
  group_id: string;
}

export interface PhotoInsert {
  id: string;
  folderId: string;
  path: string;
  filename: string;
  fileSize: number;
  fileHash: string | null;
  perceptualHash: string | null;
  takenAt: string;
  latitude: number | null;
  longitude: number | null;
  camera: string | null;
  aperture: string | null;
  shutterSpeed: string | null;
  iso: number | null;
  focalLength: string | null;
  width: number | null;
  height: number | null;
  thumbnailPath: string | null;
  modifiedTime: string;
  mediaType: 'image' | 'video';
  duration: number | null;
  frameHash: string | null;
}

interface PhotoFilter {
  folderId?: string;
  dateStart?: string;
  dateEnd?: string;
  hasLocation?: boolean;
  camera?: string;
  mediaType?: 'all' | 'image' | 'video';
  limit?: number;
  offset?: number;
}

interface DuplicateGroupInsert {
  id: string;
  reason: 'exact' | 'similar';
  recommendedPhotoId: string;
}

interface DuplicateGroupDetail {
  id: string;
  reason: 'exact' | 'similar';
  recommended_photo_id: string;
  created_at: string;
  photos: PhotoRow[];
}

interface ExactDuplicateRow {
  key: string;
  photo_ids: string;
  count: number;
}

export interface PhotoWithLocationRow {
  id: string;
  path: string;
  filename: string;
  latitude: number;
  longitude: number;
  taken_at: string | null;
  camera: string | null;
  width: number | null;
  height: number | null;
  file_size: number;
}

export interface PhotoClusterRow {
  cluster_lat: number;
  cluster_lng: number;
  count: number;
  representative_id: string;
  path: string;
  filename: string;
}

interface CameraRow {
  camera: string;
  count: number;
}

interface SchemaVersionRow {
  version: number;
}

interface ColumnInfoRow {
  name: string;
}

export class DatabaseService {
  private db!: Database.Database;
  private dbPath: string;

  constructor(configService: { getDataPath: () => string }) {
    const dataPath = configService.getDataPath();
    log.info('DatabaseService constructor - dataPath:', dataPath);
    
    try {
      if (!existsSync(dataPath)) {
        mkdirSync(dataPath, { recursive: true });
        log.info('DatabaseService - Created data directory');
      }
    } catch (error) {
      log.error('DatabaseService - Failed to create data directory:', error);
    }
    
    this.dbPath = join(dataPath, 'photovault.db');
    log.info('DatabaseService constructor - dbPath:', this.dbPath);
  }

  async initialize(): Promise<void> {
    log.info('DatabaseService initialize - Opening database at:', this.dbPath);
    try {
      this.db = new Database(this.dbPath);
      // 性能调优：WAL 模式适合写多读少的场景（扫描、去重），大缓存减少磁盘 I/O
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = -64000');      // 64MB page cache
      this.db.pragma('temp_store = MEMORY');
      this.db.pragma('busy_timeout = 5000');
      // 开启外键约束：否则所有 ON DELETE CASCADE 声明都不生效，
      // 删除照片时会残留 photo_duplicates / photo_embeddings 孤儿行
      this.db.pragma('foreign_keys = ON');
      this.createTables();
      // 清理历史孤儿数据（开启外键前删除照片残留的关联行，一次性兜底）
      this.cleanupOrphanRows();
      log.info('DatabaseService - Database initialized successfully');
    } catch (error) {
      log.error('DatabaseService - Failed to initialize database:', error);
      throw error;
    }
  }

  /**
   * 将数组按 SQLite 变量上限分批（保守取 900，兼容默认 999 上限的编译版本）。
   * 所有 IN (...) 查询/删除必须经过分批，否则大库批量操作会抛 too many SQL variables。
   */
  static chunk<T>(items: T[], size = 900): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }

  /** 清理指向已不存在照片的关联行（历史版本未开启外键时残留的孤儿数据） */
  private cleanupOrphanRows(): void {
    try {
      const embOrphans = this.db.prepare(
        'DELETE FROM photo_embeddings WHERE photo_id NOT IN (SELECT id FROM photos)'
      ).run().changes;
      const dupOrphans = this.db.prepare(
        'DELETE FROM photo_duplicates WHERE photo_id NOT IN (SELECT id FROM photos)'
      ).run().changes;
      if (embOrphans > 0 || dupOrphans > 0) {
        log.info(`[DB] Cleaned orphan rows: ${embOrphans} embeddings, ${dupOrphans} duplicate members`);
      }
    } catch (error) {
      // 清理失败不阻断启动
      log.warn('[DB] Orphan rows cleanup failed:', error);
    }
  }

  private createTables(): void {
    // 先创建基础表（首次安装）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_scanned DATETIME,
        photo_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY,
        folder_id TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        file_size INTEGER,
        file_hash TEXT,
        perceptual_hash TEXT,
        taken_at DATETIME,
        latitude REAL,
        longitude REAL,
        camera TEXT,
        aperture TEXT,
        shutter_speed TEXT,
        iso INTEGER,
        focal_length TEXT,
        width INTEGER,
        height INTEGER,
        thumbnail_path TEXT,
        media_type TEXT DEFAULT 'image' CHECK(media_type IN ('image', 'video')),
        duration REAL,
        frame_hash TEXT,
        deleted_at DATETIME,
        original_path TEXT,
        trash_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS duplicate_groups (
        id TEXT PRIMARY KEY,
        reason TEXT CHECK(reason IN ('exact', 'similar')),
        recommended_photo_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (recommended_photo_id) REFERENCES photos(id)
      );

      CREATE TABLE IF NOT EXISTS photo_duplicates (
        photo_id TEXT,
        group_id TEXT,
        PRIMARY KEY (photo_id, group_id),
        FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES duplicate_groups(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id);
      CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
      CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(file_hash);
      CREATE INDEX IF NOT EXISTS idx_photos_phash ON photos(perceptual_hash);
      CREATE INDEX IF NOT EXISTS idx_photos_location ON photos(latitude, longitude);
      CREATE INDEX IF NOT EXISTS idx_photos_camera ON photos(camera);
    `);

    // 运行 schema migrations
    this.runMigrations();
  }

  private runMigrations(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);

    const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null } | undefined;
    const currentVersion = row?.v || 0;

    const migrations: { version: number; up: () => void }[] = [
      {
        version: 1,
        up: () => {
          // photos 添加 modified_time 字段
          const columns = (this.db.prepare('PRAGMA table_info(photos)').all() as ColumnInfoRow[]).map(c => c.name);
          if (!columns.includes('modified_time')) {
            this.db.exec('ALTER TABLE photos ADD COLUMN modified_time DATETIME');
          }
        },
      },
      {
        version: 2,
        up: () => {
          // folders 添加扫描状态字段（为后续崩溃恢复做准备）
          const columns = (this.db.prepare('PRAGMA table_info(folders)').all() as ColumnInfoRow[]).map(c => c.name);
          if (!columns.includes('scan_status')) {
            this.db.exec("ALTER TABLE folders ADD COLUMN scan_status TEXT DEFAULT 'idle'");
          }
          if (!columns.includes('scan_total')) {
            this.db.exec('ALTER TABLE folders ADD COLUMN scan_total INTEGER DEFAULT 0');
          }
          if (!columns.includes('scan_processed')) {
            this.db.exec('ALTER TABLE folders ADD COLUMN scan_processed INTEGER DEFAULT 0');
          }
          if (!columns.includes('scan_last_path')) {
            this.db.exec("ALTER TABLE folders ADD COLUMN scan_last_path TEXT DEFAULT ''");
          }
        },
      },
      {
        version: 3,
        up: () => {
          // app_settings 表（为后续地图设置、语言设置做准备）
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS app_settings (
              key TEXT PRIMARY KEY,
              value TEXT
            )
          `);
        },
      },
      {
        version: 4,
        up: () => {
          // 复合索引：优化分页、筛选、地图聚合查询
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_photos_folder_taken ON photos(folder_id, taken_at DESC);
            CREATE INDEX IF NOT EXISTS idx_photos_location_bounds ON photos(latitude, longitude);
            CREATE INDEX IF NOT EXISTS idx_photos_phash_prefix ON photos(SUBSTR(perceptual_hash, 1, 4));
            CREATE INDEX IF NOT EXISTS idx_photo_duplicates_group ON photo_duplicates(group_id);
          `);
        },
      },
      {
        version: 5,
        up: () => {
          // 视频支持：媒体类型、时长、第一帧哈希
          const columns = (this.db.prepare('PRAGMA table_info(photos)').all() as ColumnInfoRow[]).map(c => c.name);
          if (!columns.includes('media_type')) {
            this.db.exec("ALTER TABLE photos ADD COLUMN media_type TEXT DEFAULT 'image' CHECK(media_type IN ('image', 'video'))");
          }
          if (!columns.includes('duration')) {
            this.db.exec('ALTER TABLE photos ADD COLUMN duration REAL');
          }
          if (!columns.includes('frame_hash')) {
            this.db.exec('ALTER TABLE photos ADD COLUMN frame_hash TEXT');
          }
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_photos_frame_hash ON photos(frame_hash);
          `);
        },
      },
      {
        version: 6,
        up: () => {
          // AI 语义搜索：照片向量表
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS photo_embeddings (
              photo_id TEXT PRIMARY KEY,
              embedding BLOB NOT NULL,
              model TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_photo_embeddings_model ON photo_embeddings(model);
          `);
        },
      },
      {
        version: 7,
        up: () => {
          // 回收站：软删除字段
          const columns = (this.db.prepare('PRAGMA table_info(photos)').all() as ColumnInfoRow[]).map(c => c.name);
          if (!columns.includes('deleted_at')) {
            this.db.exec('ALTER TABLE photos ADD COLUMN deleted_at DATETIME');
          }
          if (!columns.includes('original_path')) {
            this.db.exec('ALTER TABLE photos ADD COLUMN original_path TEXT');
          }
          if (!columns.includes('trash_path')) {
            this.db.exec('ALTER TABLE photos ADD COLUMN trash_path TEXT');
          }
          this.db.exec('CREATE INDEX IF NOT EXISTS idx_photos_deleted_at ON photos(deleted_at)');
        },
      },
      {
        version: 8,
        up: () => {
          // 性能优化索引调整（结果等价，仅影响查询计划）：
          // 1. 复合索引覆盖浏览/统计最常用的 WHERE deleted_at + media_type + ORDER BY taken_at
          this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_photos_deleted_media_taken
              ON photos(deleted_at, media_type, taken_at DESC);
          `);
          // 2. idx_photos_location 与 idx_photos_location_bounds 完全同列，删除冗余的一个
          this.db.exec('DROP INDEX IF EXISTS idx_photos_location_bounds');
          // 3. idx_photos_phash_prefix 全库无查询使用 SUBSTR(perceptual_hash,...)，属死索引，
          //    只增加写入开销（相似检测在 JS 内按 band 分桶）
          this.db.exec('DROP INDEX IF EXISTS idx_photos_phash_prefix');
        },
      },
    ];

    const pending = migrations.filter(m => m.version > currentVersion);
    if (pending.length > 0) {
      log.info(`[DB] Running ${pending.length} schema migrations (from v${currentVersion} to v${pending[pending.length - 1].version})`);
      for (const m of pending) {
        this.db.transaction(() => {
          m.up();
          this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
        })();
        log.info(`[DB] Migration v${m.version} applied`);
      }
    }
  }

  addFolder(id: string, path: string): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO folders (id, path) VALUES (?, ?)');
    stmt.run(id, path);
  }

  removeFolder(id: string): void {
    const transaction = this.db.transaction(() => {
      // 先找出包含该文件夹照片的重复组（必须在删 photo_duplicates 之前查）
      const affectedGroupIds = this.db.prepare(`
        SELECT DISTINCT pd.group_id FROM photo_duplicates pd
        JOIN photos p ON pd.photo_id = p.id
        WHERE p.folder_id = ?
      `).all(id) as { group_id: string }[];

      // 解除该文件夹照片作为重复组推荐照片的外键约束
      this.db.prepare(`
        UPDATE duplicate_groups
        SET recommended_photo_id = NULL
        WHERE recommended_photo_id IN (
          SELECT id FROM photos WHERE folder_id = ?
        )
      `).run(id);

      // 删除该文件夹照片的 photo_duplicates 关联
      this.db.prepare(`
        DELETE FROM photo_duplicates WHERE photo_id IN (
          SELECT id FROM photos WHERE folder_id = ?
        )
      `).run(id);

      // 删除受影响的重复组：仅删除变为空组（≤1 张照片）的组，保留跨文件夹的多照片组
      const keptGroups = this.cleanupDuplicateGroups(affectedGroupIds.map(g => g.group_id), 1);
      for (const gid of keptGroups) {
        // 组内仍有多个照片，重新选择推荐照片
        const bestId = this.pickBestPhotoForGroup(gid);
        if (bestId) {
          this.updateDuplicateGroupRecommended(gid, bestId);
        }
      }

      this.db.prepare('DELETE FROM photos WHERE folder_id = ?').run(id);
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    });
    transaction();
  }

  deletePhotosByFolder(folderId: string): void {
    const transaction = this.db.transaction(() => {
      // 收集受影响的重复组（跨文件夹的组在删除本文件夹照片后仍保留）
      const affectedGroups = this.db.prepare(`
        SELECT DISTINCT dg.id, dg.reason FROM duplicate_groups dg
        JOIN photo_duplicates pd ON pd.group_id = dg.id
        JOIN photos p ON p.id = pd.photo_id
        WHERE p.folder_id = ?
      `).all(folderId) as { id: string; reason: string }[];

      // 删除该文件夹照片在重复组中的成员记录
      this.db.prepare(`
        DELETE FROM photo_duplicates WHERE photo_id IN (
          SELECT id FROM photos WHERE folder_id = ?
        )
      `).run(folderId);

      // 删除变为空的重复组（沿用历史行为：仅删空组，保留单张组），并为剩余组重新选择推荐照片
      const keptGroups = this.cleanupDuplicateGroups(affectedGroups.map(g => g.id), 0);
      for (const gid of keptGroups) {
        // 重新选择推荐照片，避免 recommended_photo_id 为 NULL
        const bestId = this.pickBestPhotoForGroup(gid);
        if (bestId) {
          this.updateDuplicateGroupRecommended(gid, bestId);
        }
      }

      // 清理该文件夹照片的 embedding（CASCADE 兜底历史孤儿行）
      this.db.prepare(`
        DELETE FROM photo_embeddings WHERE photo_id IN (
          SELECT id FROM photos WHERE folder_id = ?
        )
      `).run(folderId);

      this.db.prepare('DELETE FROM photos WHERE folder_id = ?').run(folderId);
    });
    transaction();
  }

  getFolders(): FolderRow[] {
    const stmt = this.db.prepare('SELECT * FROM folders ORDER BY added_at DESC');
    return stmt.all() as FolderRow[];
  }

  getFolderById(id: string): FolderRow | null {
    const stmt = this.db.prepare('SELECT * FROM folders WHERE id = ?');
    return stmt.get(id) as FolderRow | null;
  }

  getFolderByPath(path: string): FolderRow | null {
    const stmt = this.db.prepare('SELECT * FROM folders WHERE path = ?');
    return stmt.get(path) as FolderRow | null;
  }

  updateFolderScanTime(id: string, photoCount: number): void {
    const stmt = this.db.prepare(`
      UPDATE folders SET last_scanned = CURRENT_TIMESTAMP, photo_count = ?, scan_status = 'idle', scan_processed = 0, scan_total = 0, scan_last_path = '' WHERE id = ?
    `);
    stmt.run(photoCount, id);
  }

  getPhotoCountByFolder(folderId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM photos WHERE folder_id = ? AND deleted_at IS NULL').get(folderId) as { count: number };
    return row.count;
  }

  updateFolderScanStatus(id: string, status: string, total: number, processed: number, lastPath: string): void {
    const stmt = this.db.prepare(`
      UPDATE folders SET scan_status = ?, scan_total = ?, scan_processed = ?, scan_last_path = ? WHERE id = ?
    `);
    stmt.run(status, total, processed, lastPath, id);
  }

  getInterruptedFolders(): FolderRow[] {
    const stmt = this.db.prepare("SELECT * FROM folders WHERE scan_status = 'scanning'");
    return stmt.all() as FolderRow[];
  }

  insertPhoto(photo: PhotoInsert): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO photos (
        id, folder_id, path, filename, file_size, file_hash, perceptual_hash,
        taken_at, latitude, longitude, camera, aperture, shutter_speed,
        iso, focal_length, width, height, thumbnail_path, modified_time,
        media_type, duration, frame_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      photo.id, photo.folderId, photo.path, photo.filename, photo.fileSize,
      photo.fileHash, photo.perceptualHash, photo.takenAt, photo.latitude,
      photo.longitude, photo.camera, photo.aperture, photo.shutterSpeed,
      photo.iso, photo.focalLength, photo.width, photo.height, photo.thumbnailPath,
      photo.modifiedTime, photo.mediaType, photo.duration, photo.frameHash
    );
  }

  insertPhotos(photos: PhotoInsert[]): void {
    const insert = this.db.transaction((items: PhotoInsert[]) => {
      for (const photo of items) {
        this.insertPhoto(photo);
      }
    });
    insert(photos);
  }

  getPhotos(filter: PhotoFilter = {}): PhotoRow[] {
    let sql = `SELECT ${PHOTO_LIST_COLUMNS} FROM photos WHERE deleted_at IS NULL`;
    const params: (string | number)[] = [];

    if (filter.folderId) {
      sql += ' AND folder_id = ?';
      params.push(filter.folderId);
    }
    if (filter.dateStart) {
      sql += ' AND taken_at >= ?';
      params.push(filter.dateStart);
    }
    if (filter.dateEnd) {
      sql += ' AND taken_at <= ?';
      params.push(filter.dateEnd);
    }
    if (filter.hasLocation === true) {
      sql += ' AND latitude IS NOT NULL AND longitude IS NOT NULL';
    }
    if (filter.hasLocation === false) {
      sql += ' AND (latitude IS NULL OR longitude IS NULL)';
    }
    if (filter.camera) {
      sql += ' AND camera = ?';
      params.push(filter.camera);
    }
    if (filter.mediaType === 'image' || filter.mediaType === 'video') {
      sql += ' AND media_type = ?';
      params.push(filter.mediaType);
    }

    sql += ' ORDER BY taken_at DESC NULLS LAST';

    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }

    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as PhotoRow[];
  }

  getTimeline(filter: PhotoFilter = {}): { key: string; label: string; count: number }[] {
    let sql = `
      SELECT
        COALESCE(strftime('%Y-%m', taken_at), 'unknown') as key,
        COUNT(*) as count,
        MIN(taken_at) as first_date
      FROM photos
      WHERE deleted_at IS NULL
    `;
    const params: (string | number)[] = [];

    if (filter.folderId) {
      sql += ' AND folder_id = ?';
      params.push(filter.folderId);
    }
    if (filter.dateStart) {
      sql += ' AND taken_at >= ?';
      params.push(filter.dateStart);
    }
    if (filter.dateEnd) {
      sql += ' AND taken_at <= ?';
      params.push(filter.dateEnd);
    }
    if (filter.hasLocation === true) {
      sql += ' AND latitude IS NOT NULL AND longitude IS NOT NULL';
    }
    if (filter.hasLocation === false) {
      sql += ' AND (latitude IS NULL OR longitude IS NULL)';
    }
    if (filter.camera) {
      sql += ' AND camera = ?';
      params.push(filter.camera);
    }
    if (filter.mediaType === 'image' || filter.mediaType === 'video') {
      sql += ' AND media_type = ?';
      params.push(filter.mediaType);
    }

    sql += ' GROUP BY key ORDER BY first_date DESC NULLS LAST';

    const rows = this.db.prepare(sql).all(...params) as { key: string; count: number; first_date: string | null }[];

    return rows.map(row => {
      if (row.key === 'unknown' || !row.first_date) {
        return { key: 'unknown', label: '未知时间', count: row.count };
      }
      const date = new Date(row.first_date);
      const label = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
      return { key: row.key, label, count: row.count };
    });
  }

  /**
   * 查询某个月份的第一张照片在当前排序下的 0-based offset。
   * 照片按 taken_at DESC 排序，offset 即 taken_at 大于该月份最大 taken_at 的照片数量。
   */
  getPhotoOffsetByMonth(filter: PhotoFilter = {}, monthKey: string): number | null {
    const baseWhere: string[] = ['deleted_at IS NULL'];
    const baseParams: (string | number)[] = [];

    if (filter.folderId) {
      baseWhere.push('folder_id = ?');
      baseParams.push(filter.folderId);
    }
    if (filter.dateStart) {
      baseWhere.push('taken_at >= ?');
      baseParams.push(filter.dateStart);
    }
    if (filter.dateEnd) {
      baseWhere.push('taken_at <= ?');
      baseParams.push(filter.dateEnd);
    }
    if (filter.hasLocation === true) {
      baseWhere.push('latitude IS NOT NULL AND longitude IS NOT NULL');
    }
    if (filter.hasLocation === false) {
      baseWhere.push('(latitude IS NULL OR longitude IS NULL)');
    }
    if (filter.camera) {
      baseWhere.push('camera = ?');
      baseParams.push(filter.camera);
    }
    if (filter.mediaType === 'image' || filter.mediaType === 'video') {
      baseWhere.push('media_type = ?');
      baseParams.push(filter.mediaType);
    }

    const whereSql = baseWhere.join(' AND ');

    if (monthKey === 'unknown') {
      // 未知时间对应 taken_at 为 NULL 的照片，排序在最后
      const checkSql = `SELECT COUNT(*) as count FROM photos WHERE ${whereSql} AND taken_at IS NULL`;
      const checkRow = this.db.prepare(checkSql).get(...baseParams) as { count: number } | undefined;
      if (!checkRow || checkRow.count === 0) {
        return null;
      }
      const offsetSql = `SELECT COUNT(*) as offset FROM photos WHERE ${whereSql} AND taken_at IS NOT NULL`;
      const row = this.db.prepare(offsetSql).get(...baseParams) as { offset: number } | undefined;
      return row ? row.offset : null;
    }

    // 先确认目标月份是否有照片。
    // taken_at 统一为 ISO 格式（toISOString），月份匹配用范围条件等价改写，
    // 避免 strftime 作用在列上导致索引失效全表扫描。
    // 注意：NULL 的 taken_at 在两种写法下都被排除（NULL 比较结果为 NULL）
    const [year, month] = monthKey.split('-').map(Number);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const monthStart = `${monthKey}-01`;
    const monthEndExclusive = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
    const monthRange = 'taken_at >= ? AND taken_at < ?';

    const checkSql = `SELECT COUNT(*) as count FROM photos WHERE ${whereSql} AND ${monthRange}`;
    const checkRow = this.db.prepare(checkSql).get(...baseParams, monthStart, monthEndExclusive) as { count: number } | undefined;
    if (!checkRow || checkRow.count === 0) {
      return null;
    }

    // 计算 offset
    const offsetSql = `
      SELECT COUNT(*) as offset FROM photos
      WHERE ${whereSql}
        AND taken_at > (SELECT MAX(taken_at) FROM photos WHERE ${whereSql} AND ${monthRange})
    `;
    const offsetParams = [...baseParams, ...baseParams, monthStart, monthEndExclusive];
    const row = this.db.prepare(offsetSql).get(...offsetParams) as { offset: number } | undefined;
    return row ? row.offset : null;
  }

  getPhotosPaged(filter: PhotoFilter = {}): { photos: PhotoRow[]; total: number; hasMore: boolean } {
    const limit = filter.limit || 100;
    const offset = filter.offset || 0;

    // 先查总数
    let countSql = 'SELECT COUNT(*) as total FROM photos WHERE deleted_at IS NULL';
    const countParams: (string | number)[] = [];
    if (filter.folderId) {
      countSql += ' AND folder_id = ?';
      countParams.push(filter.folderId);
    }
    if (filter.dateStart) {
      countSql += ' AND taken_at >= ?';
      countParams.push(filter.dateStart);
    }
    if (filter.dateEnd) {
      countSql += ' AND taken_at <= ?';
      countParams.push(filter.dateEnd);
    }
    if (filter.hasLocation === true) {
      countSql += ' AND latitude IS NOT NULL AND longitude IS NOT NULL';
    }
    if (filter.hasLocation === false) {
      countSql += ' AND (latitude IS NULL OR longitude IS NULL)';
    }
    if (filter.camera) {
      countSql += ' AND camera = ?';
      countParams.push(filter.camera);
    }
    if (filter.mediaType === 'image' || filter.mediaType === 'video') {
      countSql += ' AND media_type = ?';
      countParams.push(filter.mediaType);
    }
    const total = (this.db.prepare(countSql).get(...countParams) as { total: number }).total;

    // 查分页数据
    const photos = this.getPhotos({ ...filter, limit, offset });
    return { photos, total, hasMore: offset + photos.length < total };
  }

  getPhotoById(id: string): PhotoRow | null {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE id = ? AND deleted_at IS NULL');
    return stmt.get(id) as PhotoRow | null;
  }

  getPhotosByIds(ids: string[]): PhotoRow[] {
    if (ids.length === 0) return [];
    // SQLite 默认参数上限 999，分批查询避免超限
    const BATCH = 900;
    const result: PhotoRow[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db.prepare(`SELECT * FROM photos WHERE id IN (${placeholders}) AND deleted_at IS NULL`).all(...batch) as PhotoRow[];
      result.push(...rows);
    }
    return result;
  }

  getPhotoStats() {
    // D8: 合并为1条查询，减少数据库访问次数
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END), 0) as with_location,
        (SELECT COUNT(DISTINCT pd.photo_id) FROM photo_duplicates pd
         WHERE NOT EXISTS (
           SELECT 1 FROM duplicate_groups dg
           WHERE dg.id = pd.group_id AND dg.recommended_photo_id = pd.photo_id
         )) as duplicates,
        (SELECT COUNT(*) FROM folders) as folders
      FROM photos
      WHERE deleted_at IS NULL
    `).get() as { total: number; with_location: number; duplicates: number; folders: number };

    const cameras = this.db.prepare(
      'SELECT camera, COUNT(*) as count FROM photos WHERE camera IS NOT NULL AND deleted_at IS NULL GROUP BY camera ORDER BY count DESC LIMIT 10'
    ).all() as CameraRow[];

    return {
      total: stats.total,
      withLocation: stats.with_location,
      withoutLocation: stats.total - stats.with_location,
      duplicates: stats.duplicates,
      folders: stats.folders,
      cameras,
    };
  }

  /** 批量回写感知哈希：单事务复用 prepared statement，替代 N 次独立写事务 */
  updatePhotoPerceptualHashBatch(entries: { id: string; phash: string }[]): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare('UPDATE photos SET perceptual_hash = ? WHERE id = ? AND deleted_at IS NULL');
    const transaction = this.db.transaction((items: { id: string; phash: string }[]) => {
      for (const e of items) stmt.run(e.phash, e.id);
    });
    transaction(entries);
  }

  /** 批量回写文件哈希：单事务复用 prepared statement，替代 N 次独立写事务 */
  updatePhotoFileHashBatch(entries: { id: string; fileHash: string }[]): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare('UPDATE photos SET file_hash = ? WHERE id = ? AND deleted_at IS NULL');
    const transaction = this.db.transaction((items: { id: string; fileHash: string }[]) => {
      for (const e of items) stmt.run(e.fileHash, e.id);
    });
    transaction(entries);
  }

  getPhotosWithLegacyMd5Hashes(limit: number, offset: number): { id: string; path: string }[] {
    return this.db.prepare(`
      SELECT id, path FROM photos
      WHERE deleted_at IS NULL
        AND file_hash IS NOT NULL
        AND LENGTH(file_hash) = 32
        AND file_hash GLOB '[a-fA-F0-9]*'
      LIMIT ? OFFSET ?
    `).all(limit, offset) as { id: string; path: string }[];
  }

  /** 待补算感知哈希的照片（调用方仅用 id/path） */
  getPhotosWithoutPHash(): { id: string; path: string }[] {
    return this.db.prepare('SELECT id, path FROM photos WHERE perceptual_hash IS NULL AND deleted_at IS NULL').all() as { id: string; path: string }[];
  }

  getAllPhotoHashes(): { id: string; perceptual_hash: string | null; path: string }[] {
    return this.db.prepare('SELECT id, perceptual_hash, path FROM photos WHERE deleted_at IS NULL').all() as { id: string; perceptual_hash: string | null; path: string }[];
  }

  getPhotoHashBatch(limit: number, offset: number): { id: string; perceptual_hash: string | null; file_size: number }[] {
    return this.db.prepare(
      'SELECT id, perceptual_hash, file_size FROM photos WHERE perceptual_hash IS NOT NULL AND deleted_at IS NULL LIMIT ? OFFSET ?'
    ).all(limit, offset) as { id: string; perceptual_hash: string | null; file_size: number }[];
  }

  getPhotoCountWithPHash(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM photos WHERE perceptual_hash IS NOT NULL AND perceptual_hash != '0000000000000000' AND deleted_at IS NULL"
    ).get() as { count: number };
    return row.count;
  }

  findExactDuplicates(): ExactDuplicateRow[] {
    // 图片按文件 hash 分组；视频按 file_size + frame_hash 分组
    const stmt = this.db.prepare(`
      SELECT key, GROUP_CONCAT(id ORDER BY taken_at DESC) as photo_ids, COUNT(*) as count
      FROM (
        SELECT id, taken_at, file_hash as key
        FROM photos
        WHERE deleted_at IS NULL AND media_type = 'image' AND file_hash IS NOT NULL
        UNION ALL
        SELECT id, taken_at, frame_hash || '_' || file_size as key
        FROM photos
        WHERE deleted_at IS NULL AND media_type = 'video' AND frame_hash IS NOT NULL
      )
      GROUP BY key
      HAVING COUNT(*) > 1
    `);
    return stmt.all() as ExactDuplicateRow[];
  }

  findExactDuplicatesByHashes(hashes: string[]): ExactDuplicateRow[] {
    if (hashes.length === 0) return [];
    // 分批查询：每个 hash 只属于一批，组内 GROUP BY 结果跨批合并后语义不变
    const result: ExactDuplicateRow[] = [];
    for (const batch of DatabaseService.chunk(hashes)) {
      const placeholders = batch.map(() => '?').join(',');
      const stmt = this.db.prepare(`
        SELECT file_hash as key, GROUP_CONCAT(id) as photo_ids, COUNT(*) as count
        FROM photos
        WHERE deleted_at IS NULL AND media_type = 'image' AND file_hash IN (${placeholders})
        GROUP BY file_hash
        HAVING COUNT(*) > 1
      `);
      result.push(...(stmt.all(...batch) as ExactDuplicateRow[]));
    }
    return result;
  }

  findExactDuplicatesByFrameHashes(frameHashes: string[]): ExactDuplicateRow[] {
    if (frameHashes.length === 0) return [];
    const result: ExactDuplicateRow[] = [];
    for (const batch of DatabaseService.chunk(frameHashes)) {
      const placeholders = batch.map(() => '?').join(',');
      const stmt = this.db.prepare(`
        SELECT frame_hash || '_' || file_size as key, GROUP_CONCAT(id) as photo_ids, COUNT(*) as count
        FROM photos
        WHERE deleted_at IS NULL AND media_type = 'video' AND frame_hash IN (${placeholders})
          AND file_size IS NOT NULL
        GROUP BY frame_hash, file_size
        HAVING COUNT(*) > 1
      `);
      result.push(...(stmt.all(...batch) as ExactDuplicateRow[]));
    }
    return result;
  }

  getPhotoDuplicateGroup(photoId: string): string | null {
    const row = this.db.prepare(
      'SELECT group_id FROM photo_duplicates WHERE photo_id = ?'
    ).get(photoId) as { group_id: string } | undefined;
    return row?.group_id || null;
  }

  insertDuplicateGroup(group: DuplicateGroupInsert): void {
    const stmt = this.db.prepare(`
      INSERT INTO duplicate_groups (id, reason, recommended_photo_id) VALUES (?, ?, ?)
    `);
    stmt.run(group.id, group.reason, group.recommendedPhotoId);
  }

  insertPhotoDuplicate(photoId: string, groupId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO photo_duplicates (photo_id, group_id) VALUES (?, ?)
    `);
    stmt.run(photoId, groupId);
  }

  /** 获取重复组内所有照片（用于删除后重选推荐照片） */
  getPhotosInDuplicateGroup(groupId: string): PhotoRow[] {
    return this.db.prepare(`
      SELECT p.* FROM photos p
      JOIN photo_duplicates pd ON p.id = pd.photo_id
      WHERE pd.group_id = ? AND p.deleted_at IS NULL
    `).all(groupId) as PhotoRow[];
  }

  /** 更新重复组的推荐照片 */
  updateDuplicateGroupRecommended(groupId: string, photoId: string): void {
    this.db.prepare(`
      UPDATE duplicate_groups SET recommended_photo_id = ? WHERE id = ?
    `).run(photoId, groupId);
  }

  /**
   * 选择组内最佳照片作为推荐照片。
   * 简化版评分：有 GPS > 文件大小更大 > 拍摄时间更早。
   * 与 ScannerService.selectBestPhoto 的策略保持一致。
   */
  private pickBestPhotoForGroup(groupId: string): string | null {
    const row = this.db.prepare(`
      SELECT p.id FROM photos p
      JOIN photo_duplicates pd ON pd.photo_id = p.id
      WHERE pd.group_id = ? AND p.deleted_at IS NULL
      ORDER BY
        (p.latitude IS NOT NULL AND p.longitude IS NOT NULL) DESC,
        p.file_size DESC,
        p.taken_at IS NULL,
        p.taken_at ASC
      LIMIT 1
    `).get(groupId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getDuplicateGroups(): DuplicateGroupDetail[] {
    // D7: 两步查询替代 json_group_array，避免 JSON 序列化开销
    const groups = this.db.prepare(`
      SELECT * FROM duplicate_groups
    `).all() as DuplicateGroupRow[];

    if (groups.length === 0) return [];

    // 分批查询组内照片（大库可能有上万重复组，IN 变量数需分批）
    const photoRows: (PhotoRow & { group_id: string })[] = [];
    for (const batch of DatabaseService.chunk(groups.map(g => g.id))) {
      const placeholders = batch.map(() => '?').join(',');
      photoRows.push(...(this.db.prepare(`
        SELECT pd.group_id, p.id, p.path, p.filename, p.file_size, p.taken_at,
               p.latitude, p.longitude, p.width, p.height, p.camera
        FROM photo_duplicates pd
        JOIN photos p ON pd.photo_id = p.id
        WHERE pd.group_id IN (${placeholders}) AND p.deleted_at IS NULL
      `).all(...batch) as (PhotoRow & { group_id: string })[]));
    }

    // 按组 ID 分组，并按拍摄时间倒序排列组内照片
    const photosByGroup = new Map<string, PhotoRow[]>();
    for (const row of photoRows) {
      const gid = row.group_id;
      if (!photosByGroup.has(gid)) photosByGroup.set(gid, []);
      photosByGroup.get(gid)!.push(row);
    }
    for (const photos of photosByGroup.values()) {
      photos.sort((a, b) => compareDateDesc(a.taken_at, b.taken_at));
    }

    return groups
      .map(g => ({
        ...g,
        photos: photosByGroup.get(g.id) || [],
      }))
      .sort((a, b) => {
        // 稳定排序：照片数量多的排在前面，数量相同按最近拍摄时间倒序
        if (a.photos.length !== b.photos.length) return b.photos.length - a.photos.length;
        const aLatest = a.photos[0]?.taken_at;
        const bLatest = b.photos[0]?.taken_at;
        return compareDateDesc(aLatest, bLatest);
      });
  }

  getDuplicateGroupsPaged(
    limit: number = 50,
    offset: number = 0,
    reason?: 'exact' | 'similar'
  ): { groups: DuplicateGroupDetail[]; total: number } {
    const whereClause = reason ? 'WHERE reason = ?' : '';
    const total = (this.db.prepare(`
      SELECT COUNT(*) as total FROM duplicate_groups ${whereClause}
    `).get(...(reason ? [reason] : [])) as { total: number }).total;

    const groups = this.db.prepare(`
      SELECT * FROM duplicate_groups ${whereClause} LIMIT ? OFFSET ?
    `).all(...(reason ? [reason] : []), limit, offset) as DuplicateGroupRow[];

    if (groups.length === 0) return { groups: [], total };

    const groupIds = groups.map(g => g.id);
    const placeholders = groupIds.map(() => '?').join(',');

    const photoRows = this.db.prepare(`
      SELECT pd.group_id, p.id, p.path, p.filename, p.file_size, p.taken_at,
             p.latitude, p.longitude, p.width, p.height, p.camera
      FROM photo_duplicates pd
      JOIN photos p ON pd.photo_id = p.id
      WHERE pd.group_id IN (${placeholders}) AND p.deleted_at IS NULL
    `).all(...groupIds) as (PhotoRow & { group_id: string })[];

    const photosByGroup = new Map<string, PhotoRow[]>();
    for (const row of photoRows) {
      const gid = row.group_id;
      if (!photosByGroup.has(gid)) photosByGroup.set(gid, []);
      photosByGroup.get(gid)!.push(row);
    }
    for (const photos of photosByGroup.values()) {
      photos.sort((a, b) => compareDateDesc(a.taken_at, b.taken_at));
    }

    return {
      groups: groups
        .map(g => ({
          ...g,
          photos: photosByGroup.get(g.id) || [],
        }))
        .sort((a, b) => {
          if (a.photos.length !== b.photos.length) return b.photos.length - a.photos.length;
          const aLatest = a.photos[0]?.taken_at;
          const bLatest = b.photos[0]?.taken_at;
          return compareDateDesc(aLatest, bLatest);
        }),
      total,
    };
  }

  /**
   * 照片删除后清理其重复组：剩余成员数 ≤ threshold 的组整组删除（含成员行），
   * 其余组返回给调用方处理（重选推荐照片等）。
   * 用一条 GROUP BY 统计剩余成员数，替代每组一次 COUNT 的 N+1 循环。
   * @param threshold 删组阈值：deletePhoto 系列为 1（≤1 张即无重复意义），
   *                  deletePhotosByFolder 沿用历史行为 0（仅删空组，保留单张组）
   */
  private cleanupDuplicateGroups(groupIds: string[], threshold: number): string[] {
    if (groupIds.length === 0) return [];
    const kept: string[] = [];
    const BATCH = 900; // SQLite 变量数上限防御
    for (let i = 0; i < groupIds.length; i += BATCH) {
      const chunk = groupIds.slice(i, i + BATCH);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT group_id, COUNT(*) as count FROM photo_duplicates
        WHERE group_id IN (${placeholders})
        GROUP BY group_id
      `).all(...chunk) as { group_id: string; count: number }[];
      const countByGroup = new Map(rows.map(r => [r.group_id, r.count]));

      const empty: string[] = [];
      for (const gid of chunk) {
        if ((countByGroup.get(gid) ?? 0) <= threshold) {
          empty.push(gid);
        } else {
          kept.push(gid);
        }
      }

      if (empty.length > 0) {
        const emptyPlaceholders = empty.map(() => '?').join(',');
        this.db.prepare(`DELETE FROM photo_duplicates WHERE group_id IN (${emptyPlaceholders})`).run(...empty);
        this.db.prepare(`DELETE FROM duplicate_groups WHERE id IN (${emptyPlaceholders})`).run(...empty);
      }
    }
    return kept;
  }

  deletePhoto(id: string): void {
    // 找到该照片所在的重复组
    const groups = this.db.prepare(`
      SELECT group_id FROM photo_duplicates WHERE photo_id = ?
    `).all(id) as { group_id: string }[];

    // 整个删除+清理空组包裹在事务中，避免中途崩溃导致数据不一致
    const transaction = this.db.transaction(() => {
      // 解除该照片作为重复组推荐照片的外键约束
      this.db.prepare(`
        UPDATE duplicate_groups SET recommended_photo_id = NULL WHERE recommended_photo_id = ?
      `).run(id);

      // 显式清理 embedding（CASCADE 兜底：历史数据在开启外键前可能残留孤儿行）
      this.db.prepare('DELETE FROM photo_embeddings WHERE photo_id = ?').run(id);

      // 删除照片（CASCADE 会清理 photo_duplicates）
      this.db.prepare('DELETE FROM photos WHERE id = ?').run(id);

      // 清理空重复组（组内仅剩1张或0张时删组）
      this.cleanupDuplicateGroups(groups.map(g => g.group_id), 1);
    });
    transaction();
  }

  /**
   * 批量删除照片。
   * @returns 受影响且仍然存在（剩余照片数 > 1）的重复组 ID 列表，
   *          调用方需对这些组重新选择推荐照片（避免 recommended_photo_id 为 NULL）。
   */
  deletePhotosBatch(ids: string[], opts?: { onlyTrashed?: boolean }): string[] {
    if (ids.length === 0) return [];
    // 分批处理：SQLite 变量数有上限（默认 999 / 编译版 32766），
    // 大库批量删除（如文件夹被清空时全量 id）会直接抛 too many SQL variables
    const BATCH = 900;
    const allAffected: string[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      allAffected.push(...this.deletePhotosBatchInner(ids.slice(i, i + BATCH), opts));
    }
    return [...new Set(allAffected)];
  }

  private deletePhotosBatchInner(ids: string[], opts?: { onlyTrashed?: boolean }): string[] {
    const affectedGroupIds: string[] = [];
    const transaction = this.db.transaction(() => {
      const placeholders = ids.map(() => '?').join(',');
      // onlyTrashed：仅删除已在回收站中的记录。
      // 防御"永久删除执行中照片被并发恢复"的竞态——不加条件会把已恢复的照片记录一并删掉
      const trashGuard = opts?.onlyTrashed ? ' AND deleted_at IS NOT NULL' : '';

      // 这些照片被设为某些重复组的推荐照片，先解除外键约束避免删除失败
      this.db.prepare(`
        UPDATE duplicate_groups
        SET recommended_photo_id = NULL
        WHERE recommended_photo_id IN (${placeholders})
      `).run(...ids);

      // 找到这些照片所在的所有重复组
      const affected = this.db.prepare(`
        SELECT DISTINCT group_id FROM photo_duplicates WHERE photo_id IN (${placeholders})
      `).all(...ids) as { group_id: string }[];

      // 显式清理 embedding（CASCADE 兜底：历史数据在开启外键前可能残留孤儿行）
      this.db.prepare(`DELETE FROM photo_embeddings WHERE photo_id IN (${placeholders})`).run(...ids);

      // 批量删除照片（CASCADE 会清理 photo_duplicates）
      this.db.prepare(`DELETE FROM photos WHERE id IN (${placeholders})${trashGuard}`).run(...ids);

      // 清理空重复组，收集仍存在的组供调用方修复推荐照片
      affectedGroupIds.push(...this.cleanupDuplicateGroups(affected.map(g => g.group_id), 1));
    });
    transaction();
    return affectedGroupIds;
  }

  // region Trash
  movePhotosToTrash(entries: { id: string; trashPath: string }[]): void {
    if (entries.length === 0) return;
    const transaction = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        UPDATE photos
        SET deleted_at = CURRENT_TIMESTAMP,
            original_path = path,
            trash_path = ?,
            path = ?
        WHERE id = ? AND deleted_at IS NULL
      `);
      for (const entry of entries) {
        stmt.run(entry.trashPath, entry.trashPath, entry.id);
      }
    });
    transaction();
  }

  /**
   * 从回收站恢复照片。
   * @param entries 每张照片的 id 与实际恢复落点路径——原位置存在同名文件时
   *                恢复文件会被改名为 "xxx (1).jpg"，必须按实际路径更新 DB，
   *                否则 DB 指向不存在的路径，后续打开/缩略图/再删除全部失效
   */
  restorePhotosFromTrash(entries: { id: string; restoredPath: string }[]): { id: string; restoredPath: string }[] {
    if (entries.length === 0) return [];
    const result: { id: string; restoredPath: string }[] = [];
    const transaction = this.db.transaction(() => {
      const selectStmt = this.db.prepare('SELECT id FROM photos WHERE id = ? AND deleted_at IS NOT NULL');
      const updateStmt = this.db.prepare(`
        UPDATE photos
        SET path = ?,
            original_path = NULL,
            trash_path = NULL,
            deleted_at = NULL
        WHERE id = ?
      `);
      for (const entry of entries) {
        const row = selectStmt.get(entry.id) as { id: string } | undefined;
        if (row) {
          updateStmt.run(entry.restoredPath, entry.id);
          result.push({ id: entry.id, restoredPath: entry.restoredPath });
        }
      }
    });
    transaction();
    return result;
  }

  getTrashedPhotos(): PhotoRow[] {
    return this.db
      .prepare(`SELECT ${PHOTO_LIST_COLUMNS} FROM photos WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`)
      .all() as PhotoRow[];
  }

  getTrashedPhotosByIds(ids: string[]): PhotoRow[] {
    if (ids.length === 0) return [];
    const BATCH = 900;
    const result: PhotoRow[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM photos WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`)
        .all(...batch) as PhotoRow[];
      result.push(...rows);
    }
    return result;
  }

  getTrashStats(): { count: number; totalSize: number } {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) as count, COALESCE(SUM(file_size), 0) as total_size
        FROM photos WHERE deleted_at IS NOT NULL
      `)
      .get() as { count: number; total_size: number };
    return { count: row.count, totalSize: row.total_size };
  }

  getTrashCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM photos WHERE deleted_at IS NOT NULL')
      .get() as { count: number };
    return row.count;
  }
  // endregion

  updatePhotoLocation(id: string, lat: number, lng: number): void {
    const stmt = this.db.prepare(`
      UPDATE photos SET latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL
    `);
    stmt.run(lat, lng, id);
  }

  updatePhotoDate(id: string, date: string): void {
    const stmt = this.db.prepare(`
      UPDATE photos SET taken_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL
    `);
    stmt.run(date, id);
  }

  getAllPhotoPaths(): { id: string; path: string }[] {
    const stmt = this.db.prepare('SELECT id, path FROM photos WHERE deleted_at IS NULL');
    return stmt.all() as { id: string; path: string }[];
  }

  getPhotosByFolder(folderId: string): PhotoRow[] {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE folder_id = ? AND deleted_at IS NULL');
    return stmt.all(folderId) as PhotoRow[];
  }

  getPhotosByPaths(paths: string[]): { id: string; path: string; file_hash: string | null; file_size: number; modified_time: string | null }[] {
    if (paths.length === 0) return [];
    const result: { id: string; path: string; file_hash: string | null; file_size: number; modified_time: string | null }[] = [];
    for (const batch of DatabaseService.chunk(paths)) {
      const placeholders = batch.map(() => '?').join(',');
      result.push(...(this.db.prepare(
        `SELECT id, path, file_hash, file_size, modified_time FROM photos WHERE deleted_at IS NULL AND path IN (${placeholders})`
      ).all(...batch) as { id: string; path: string; file_hash: string | null; file_size: number; modified_time: string | null }[]));
    }
    return result;
  }

  getPhotoPathsByFolder(folderId: string, limit: number, offset: number): { id: string; path: string }[] {
    return this.db.prepare(
      'SELECT id, path FROM photos WHERE folder_id = ? AND deleted_at IS NULL LIMIT ? OFFSET ?'
    ).all(folderId, limit, offset) as { id: string; path: string }[];
  }

  getAllPhotoPathsByFolder(folderId: string): { id: string; path: string }[] {
    return this.db.prepare(
      'SELECT id, path FROM photos WHERE folder_id = ? AND deleted_at IS NULL'
    ).all(folderId) as { id: string; path: string }[];
  }

  getAllPhotoIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM photos WHERE deleted_at IS NULL').all() as { id: string }[];
    return rows.map(r => r.id);
  }

  getPhotoByPath(path: string): PhotoRow | null {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE path = ? AND deleted_at IS NULL');
    return stmt.get(path) as PhotoRow | null;
  }

  getPhotosWithLocation(): PhotoWithLocationRow[] {
    const stmt = this.db.prepare(
      'SELECT id, path, filename, latitude, longitude, taken_at, camera, width, height, file_size FROM photos WHERE deleted_at IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    return stmt.all() as PhotoWithLocationRow[];
  }

  getPhotosInBounds(south: number, west: number, north: number, east: number): PhotoWithLocationRow[] {
    const stmt = this.db.prepare(
      'SELECT id, path, filename, latitude, longitude, taken_at, camera, width, height, file_size FROM photos WHERE deleted_at IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?'
    );
    return stmt.all(south, north, west, east) as PhotoWithLocationRow[];
  }

  /**
   * 基于地图 zoom 的网格聚合查询。
   * 把视口内照片按经纬度网格分组，返回聚合簇，避免前端 O(n²) 聚类。
   */
  getPhotoClustersInBounds(south: number, west: number, north: number, east: number, zoom: number): PhotoClusterRow[] {
    // 聚合网格精度：约 64 像素对应的经纬度跨度
    const precision = Math.max(90 / Math.pow(2, zoom), 0.0001);
    const stmt = this.db.prepare(`
      SELECT c.cluster_lat, c.cluster_lng, c.count, c.representative_id, p.path, p.filename
      FROM (
        SELECT
          ROUND(latitude / ?) * ? AS cluster_lat,
          ROUND(longitude / ?) * ? AS cluster_lng,
          COUNT(*) AS count,
          MIN(id) AS representative_id
        FROM photos
        WHERE deleted_at IS NULL
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
          AND latitude BETWEEN ? AND ?
          AND longitude BETWEEN ? AND ?
        GROUP BY cluster_lat, cluster_lng
      ) c
      JOIN photos p ON p.id = c.representative_id AND p.deleted_at IS NULL
    `);
    return stmt.all(precision, precision, precision, precision, south, north, west, east) as PhotoClusterRow[];
  }

  clearDuplicateGroups(): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM photo_duplicates').run();
      this.db.prepare('DELETE FROM duplicate_groups').run();
    });
    transaction();
  }

  clearDuplicateGroupsByReason(reason: 'exact' | 'similar'): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM photo_duplicates WHERE group_id IN (
          SELECT id FROM duplicate_groups WHERE reason = ?
        )
      `).run(reason);
      this.db.prepare('DELETE FROM duplicate_groups WHERE reason = ?').run(reason);
    });
    transaction();
  }

  /**
   * 原子性地重建某一类重复组：先清空旧组，再批量写入新组。
   * 整个操作在一个事务中完成，避免中断后留下半完成状态。
   */
  rebuildDuplicateGroups(
    reason: 'exact' | 'similar',
    groups: { id: string; recommendedPhotoId: string; photoIds: string[] }[]
  ): void {
    const transaction = this.db.transaction(() => {
      this.clearDuplicateGroupsByReason(reason);
      for (const g of groups) {
        this.insertDuplicateGroup({ id: g.id, reason, recommendedPhotoId: g.recommendedPhotoId });
        for (const photoId of g.photoIds) {
          this.insertPhotoDuplicate(photoId, g.id);
        }
      }
    });
    transaction();
  }

  updatePhotoThumbnail(id: string, thumbnailPath: string): void {
    const stmt = this.db.prepare('UPDATE photos SET thumbnail_path = ? WHERE id = ? AND deleted_at IS NULL');
    stmt.run(thumbnailPath, id);
  }

  clearAllData(): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM photo_embeddings').run();
      this.db.prepare('DELETE FROM photo_duplicates').run();
      this.db.prepare('DELETE FROM duplicate_groups').run();
      this.db.prepare('DELETE FROM photos').run();
      this.db.prepare('DELETE FROM folders').run();
    });
    transaction();
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
  }

  removeSetting(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }

  // region AI Embeddings
  upsertPhotoEmbedding(photoId: string, embedding: Float32Array, model: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO photo_embeddings (photo_id, embedding, model, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(photo_id) DO UPDATE SET
        embedding = excluded.embedding,
        model = excluded.model,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(photoId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), model);
  }

  getPhotoEmbedding(photoId: string): { embedding: Float32Array; model: string } | null {
    const row = this.db.prepare('SELECT embedding, model FROM photo_embeddings WHERE photo_id = ?').get(photoId) as
      | { embedding: Buffer; model: string }
      | undefined;
    if (!row) return null;
    // 复制到新对齐缓冲区，避免 better-sqlite3 返回的 Buffer 字节对齐不满足 Float32Array 要求
    const bytes = new Uint8Array(row.embedding);
    const embedding = new Float32Array(bytes.buffer.slice(0));
    return {
      embedding,
      model: row.model,
    };
  }

  getPhotosWithoutEmbedding(limit: number, excludeIds: string[] = []): { id: string; path: string; filename: string; media_type: 'image' | 'video' }[] {
    if (excludeIds.length === 0) {
      return this.db.prepare(`
        SELECT p.id, p.path, p.filename, p.media_type FROM photos p
        LEFT JOIN photo_embeddings pe ON p.id = pe.photo_id
        WHERE p.deleted_at IS NULL AND pe.photo_id IS NULL AND p.media_type = 'image'
        LIMIT ?
      `).all(limit) as { id: string; path: string; filename: string; media_type: 'image' | 'video' }[];
    }
    // 排除列表用临时表承载：失败照片可能累积数千个 id，
    // 直接拼 NOT IN 会超出 SQLite 变量上限导致索引任务崩溃
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS tmp_embedding_exclude (id TEXT PRIMARY KEY)');
    this.db.prepare('DELETE FROM tmp_embedding_exclude').run();
    const insertStmt = this.db.prepare('INSERT OR IGNORE INTO tmp_embedding_exclude (id) VALUES (?)');
    const insertAll = this.db.transaction((ids: string[]) => {
      for (const id of ids) insertStmt.run(id);
    });
    for (const batch of DatabaseService.chunk(excludeIds)) {
      insertAll(batch);
    }
    const rows = this.db.prepare(`
      SELECT p.id, p.path, p.filename, p.media_type FROM photos p
      LEFT JOIN photo_embeddings pe ON p.id = pe.photo_id
      WHERE p.deleted_at IS NULL AND pe.photo_id IS NULL AND p.media_type = 'image'
        AND p.id NOT IN (SELECT id FROM tmp_embedding_exclude)
      LIMIT ?
    `).all(limit) as { id: string; path: string; filename: string; media_type: 'image' | 'video' }[];
    this.db.prepare('DELETE FROM tmp_embedding_exclude').run();
    return rows;
  }

  getEmbeddingCount(model?: string): number {
    if (model) {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM photo_embeddings WHERE model = ?').get(model) as { count: number };
      return row.count;
    }
    const row = this.db.prepare('SELECT COUNT(*) as count FROM photo_embeddings').get() as { count: number };
    return row.count;
  }

  getTotalPhotoCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM photos WHERE deleted_at IS NULL AND media_type = 'image'").get() as { count: number };
    return row.count;
  }

  deletePhotoEmbeddings(photoIds: string[]): void {
    if (photoIds.length === 0) return;
    for (const batch of DatabaseService.chunk(photoIds)) {
      const placeholders = batch.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM photo_embeddings WHERE photo_id IN (${placeholders})`).run(...batch);
    }
  }

  /** 加载指定模型的所有 embedding 及对应照片，供搜索服务缓存使用 */
  getAllEmbeddings(model: string): { photo: PhotoRow; embedding: Float32Array }[] {
    const rows = this.db.prepare(`
      SELECT p.*, pe.embedding FROM photos p
      JOIN photo_embeddings pe ON p.id = pe.photo_id
      WHERE p.deleted_at IS NULL AND pe.model = ?
    `).all(model) as (PhotoRow & { embedding: Buffer })[];

    return rows.map(row => ({
      photo: row,
      // 复制 Buffer 数据到独立的 Float32Array，避免引用共享的 SQLite 内存
      embedding: new Float32Array(
        row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.length
        )
      ),
    }));
  }
  // endregion

  setDuplicateDetectionDirty(reason: 'exact' | 'similar', dirty: boolean): void {
    this.setSetting(`duplicate_${reason}_dirty`, dirty ? '1' : '0');
  }

  isDuplicateDetectionDirty(reason: 'exact' | 'similar'): boolean {
    return this.getSetting(`duplicate_${reason}_dirty`) === '1';
  }

  /** 关闭数据库连接，应用退出时调用以确保 WAL checkpoint */
  close(): void {
    try {
      if (this.db) {
        this.db.close();
        log.info('[Database] 数据库连接已关闭');
      }
    } catch (err) {
      log.error('[Database] 关闭数据库失败:', err);
    }
  }
}
