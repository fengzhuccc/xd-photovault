import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import log from 'electron-log';

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
  image_seed: string | null;
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
  fileHash: string;
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
}

interface PhotoFilter {
  folderId?: string;
  dateStart?: string;
  dateEnd?: string;
  hasLocation?: boolean;
  camera?: string;
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
  file_hash: string;
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

  constructor(userDataPath: string) {
    log.info('DatabaseService constructor - userDataPath:', userDataPath);
    const dataDir = join(userDataPath, 'data');
    log.info('DatabaseService constructor - dataDir:', dataDir);
    
    try {
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
        log.info('DatabaseService - Created data directory');
      }
    } catch (error) {
      log.error('DatabaseService - Failed to create data directory:', error);
    }
    
    this.dbPath = join(dataDir, 'photovault.db');
    log.info('DatabaseService constructor - dbPath:', this.dbPath);
  }

  async initialize(): Promise<void> {
    log.info('DatabaseService initialize - Opening database at:', this.dbPath);
    try {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.createTables();
      log.info('DatabaseService - Database initialized successfully');
    } catch (error) {
      log.error('DatabaseService - Failed to initialize database:', error);
      throw error;
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

      // 删除该文件夹照片的 photo_duplicates 关联
      this.db.prepare(`
        DELETE FROM photo_duplicates WHERE photo_id IN (
          SELECT id FROM photos WHERE folder_id = ?
        )
      `).run(id);

      // 删除受影响的重复组
      for (const g of affectedGroupIds) {
        this.db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(g.group_id);
        this.db.prepare('DELETE FROM photo_duplicates WHERE group_id = ?').run(g.group_id);
      }

      this.db.prepare('DELETE FROM photos WHERE folder_id = ?').run(id);
      this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    });
    transaction();
  }

  deletePhotosByFolder(folderId: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM photo_duplicates WHERE photo_id IN (
          SELECT id FROM photos WHERE folder_id = ?
        )
      `).run(folderId);

      this.db.prepare(`
        DELETE FROM duplicate_groups WHERE id NOT IN (
          SELECT DISTINCT group_id FROM photo_duplicates
        )
      `).run();

      this.db.prepare('DELETE FROM photos WHERE folder_id = ?').run(folderId);
    });
    transaction();
  }

  getFolders(): FolderRow[] {
    const stmt = this.db.prepare('SELECT * FROM folders ORDER BY added_at DESC');
    return stmt.all() as FolderRow[];
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
    const row = this.db.prepare('SELECT COUNT(*) as count FROM photos WHERE folder_id = ?').get(folderId) as { count: number };
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
        iso, focal_length, width, height, thumbnail_path, modified_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      photo.id, photo.folderId, photo.path, photo.filename, photo.fileSize,
      photo.fileHash, photo.perceptualHash, photo.takenAt, photo.latitude,
      photo.longitude, photo.camera, photo.aperture, photo.shutterSpeed,
      photo.iso, photo.focalLength, photo.width, photo.height, photo.thumbnailPath,
      photo.modifiedTime
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
    let sql = 'SELECT * FROM photos WHERE 1=1';
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

  getPhotosPaged(filter: PhotoFilter = {}): { photos: PhotoRow[]; total: number; hasMore: boolean } {
    const limit = filter.limit || 100;
    const offset = filter.offset || 0;

    // 先查总数
    let countSql = 'SELECT COUNT(*) as total FROM photos WHERE 1=1';
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
    const total = (this.db.prepare(countSql).get(...countParams) as { total: number }).total;

    // 查分页数据
    const photos = this.getPhotos({ ...filter, limit, offset });
    return { photos, total, hasMore: offset + photos.length < total };
  }

  getPhotoById(id: string): PhotoRow | null {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE id = ?');
    return stmt.get(id) as PhotoRow | null;
  }

  getPhotoStats() {
    // D8: 合并为1条查询，减少数据库访问次数
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 1 ELSE 0 END), 0) as with_location,
        (SELECT COUNT(*) FROM photo_duplicates) as duplicates,
        (SELECT COUNT(*) FROM folders) as folders
      FROM photos
    `).get() as { total: number; with_location: number; duplicates: number; folders: number };

    const cameras = this.db.prepare(
      'SELECT camera, COUNT(*) as count FROM photos WHERE camera IS NOT NULL GROUP BY camera ORDER BY count DESC LIMIT 10'
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

  findDuplicatesByHash(hash: string): PhotoRow[] {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE file_hash = ?');
    return stmt.all(hash) as PhotoRow[];
  }

  findDuplicatesByPHash(phash: string): PhotoRow[] {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE perceptual_hash = ?');
    return stmt.all(phash) as PhotoRow[];
  }

  updatePhotoPerceptualHash(id: string, phash: string): void {
    this.db.prepare('UPDATE photos SET perceptual_hash = ? WHERE id = ?').run(phash, id);
  }

  getPhotosWithoutPHash(): PhotoRow[] {
    return this.db.prepare('SELECT * FROM photos WHERE perceptual_hash IS NULL').all() as PhotoRow[];
  }

  getAllPhotoHashes(): { id: string; perceptual_hash: string | null; path: string }[] {
    return this.db.prepare('SELECT id, perceptual_hash, path FROM photos').all() as { id: string; perceptual_hash: string | null; path: string }[];
  }

  findExactDuplicates(): ExactDuplicateRow[] {
    const stmt = this.db.prepare(`
      SELECT file_hash, GROUP_CONCAT(id) as photo_ids, COUNT(*) as count
      FROM photos
      WHERE file_hash IS NOT NULL
      GROUP BY file_hash
      HAVING COUNT(*) > 1
    `);
    return stmt.all() as ExactDuplicateRow[];
  }

  findExactDuplicatesByHashes(hashes: string[]): ExactDuplicateRow[] {
    if (hashes.length === 0) return [];
    const placeholders = hashes.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT file_hash, GROUP_CONCAT(id) as photo_ids, COUNT(*) as count
      FROM photos
      WHERE file_hash IN (${placeholders})
      GROUP BY file_hash
      HAVING COUNT(*) > 1
    `);
    return stmt.all(...hashes) as ExactDuplicateRow[];
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

  getDuplicateGroups(): DuplicateGroupDetail[] {
    // D7: 两步查询替代 json_group_array，避免 JSON 序列化开销
    const groups = this.db.prepare(`
      SELECT * FROM duplicate_groups ORDER BY created_at DESC
    `).all() as DuplicateGroupRow[];

    if (groups.length === 0) return [];

    const groupIds = groups.map(g => g.id);
    const placeholders = groupIds.map(() => '?').join(',');

    const photoRows = this.db.prepare(`
      SELECT pd.group_id, p.id, p.path, p.filename, p.file_size, p.taken_at,
             p.latitude, p.longitude, p.width, p.height, p.camera
      FROM photo_duplicates pd
      JOIN photos p ON pd.photo_id = p.id
      WHERE pd.group_id IN (${placeholders})
    `).all(...groupIds) as (PhotoRow & { group_id: string })[];

    // 按组 ID 分组
    const photosByGroup = new Map<string, PhotoRow[]>();
    for (const row of photoRows) {
      const gid = row.group_id;
      if (!photosByGroup.has(gid)) photosByGroup.set(gid, []);
      photosByGroup.get(gid)!.push(row);
    }

    return groups.map(g => ({
      ...g,
      photos: photosByGroup.get(g.id) || [],
    }));
  }

  deletePhoto(id: string): void {
    // 找到该照片所在的重复组
    const groups = this.db.prepare(`
      SELECT group_id FROM photo_duplicates WHERE photo_id = ?
    `).all(id) as { group_id: string }[];

    // 删除照片（CASCADE 会清理 photo_duplicates）
    const stmt = this.db.prepare('DELETE FROM photos WHERE id = ?');
    stmt.run(id);

    // 清理空重复组（组内仅剩1张或0张时删组）
    for (const g of groups) {
      const remaining = this.db.prepare(
        'SELECT COUNT(*) as count FROM photo_duplicates WHERE group_id = ?'
      ).get(g.group_id) as { count: number };
      if (remaining.count <= 1) {
        this.db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(g.group_id);
        this.db.prepare('DELETE FROM photo_duplicates WHERE group_id = ?').run(g.group_id);
      }
    }
  }

  deletePhotosBatch(ids: string[]): void {
    if (ids.length === 0) return;
    const transaction = this.db.transaction(() => {
      // 找到这些照片所在的所有重复组
      const placeholders = ids.map(() => '?').join(',');
      const affectedGroupIds = this.db.prepare(`
        SELECT DISTINCT group_id FROM photo_duplicates WHERE photo_id IN (${placeholders})
      `).all(...ids) as { group_id: string }[];

      // 批量删除照片（CASCADE 会清理 photo_duplicates）
      this.db.prepare(`DELETE FROM photos WHERE id IN (${placeholders})`).run(...ids);

      // 清理空重复组
      for (const g of affectedGroupIds) {
        const remaining = this.db.prepare(
          'SELECT COUNT(*) as count FROM photo_duplicates WHERE group_id = ?'
        ).get(g.group_id) as { count: number };
        if (remaining.count <= 1) {
          this.db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(g.group_id);
          this.db.prepare('DELETE FROM photo_duplicates WHERE group_id = ?').run(g.group_id);
        }
      }
    });
    transaction();
  }

  updatePhotoLocation(id: string, lat: number, lng: number): void {
    const stmt = this.db.prepare(`
      UPDATE photos SET latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    stmt.run(lat, lng, id);
  }

  updatePhotoDate(id: string, date: string): void {
    const stmt = this.db.prepare(`
      UPDATE photos SET taken_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    stmt.run(date, id);
  }

  getAllPhotoPaths(): { id: string; path: string }[] {
    const stmt = this.db.prepare('SELECT id, path FROM photos');
    return stmt.all() as { id: string; path: string }[];
  }

  getPhotosByFolder(folderId: string): PhotoRow[] {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE folder_id = ?');
    return stmt.all(folderId) as PhotoRow[];
  }

  getAllPhotoIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM photos').all() as { id: string }[];
    return rows.map(r => r.id);
  }

  getPhotoByPath(path: string): PhotoRow | null {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE path = ?');
    return stmt.get(path) as PhotoRow | null;
  }

  getPhotosWithLocation(): PhotoWithLocationRow[] {
    const stmt = this.db.prepare(
      'SELECT id, path, filename, latitude, longitude, taken_at, camera, width, height, file_size FROM photos WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    return stmt.all() as PhotoWithLocationRow[];
  }

  clearDuplicateGroups(): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM photo_duplicates').run();
      this.db.prepare('DELETE FROM duplicate_groups').run();
    });
    transaction();
  }

  updatePhotoThumbnail(id: string, thumbnailPath: string): void {
    const stmt = this.db.prepare('UPDATE photos SET thumbnail_path = ? WHERE id = ?');
    stmt.run(thumbnailPath, id);
  }

  clearAllData(): void {
    const transaction = this.db.transaction(() => {
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
}
