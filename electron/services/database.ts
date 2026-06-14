import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import log from 'electron-log';

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

    const row = this.db.prepare('SELECT MAX(version) as v FROM schema_version').get() as any;
    const currentVersion = row?.v || 0;

    const migrations: { version: number; up: () => void }[] = [
      {
        version: 1,
        up: () => {
          // photos 添加 modified_time 字段
          const columns = (this.db.prepare('PRAGMA table_info(photos)').all() as any[]).map(c => c.name);
          if (!columns.includes('modified_time')) {
            this.db.exec('ALTER TABLE photos ADD COLUMN modified_time DATETIME');
          }
        },
      },
      {
        version: 2,
        up: () => {
          // folders 添加扫描状态字段（为后续崩溃恢复做准备）
          const columns = (this.db.prepare('PRAGMA table_info(folders)').all() as any[]).map(c => c.name);
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
    // 先找出包含该文件夹照片的重复组（必须在删 photo_duplicates 之前查）
    const affectedGroupIds = this.db.prepare(`
      SELECT DISTINCT pd.group_id FROM photo_duplicates pd
      JOIN photos p ON pd.photo_id = p.id
      WHERE p.folder_id = ?
    `).all(id) as { group_id: string }[];

    // 删除该文件夹照片的 photo_duplicates 关联
    const deletePhotoDuplicates = this.db.prepare(`
      DELETE FROM photo_duplicates WHERE photo_id IN (
        SELECT id FROM photos WHERE folder_id = ?
      )
    `);
    deletePhotoDuplicates.run(id);

    // 删除受影响的重复组
    for (const g of affectedGroupIds) {
      this.db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(g.group_id);
      // 删除组内其他照片的关联
      this.db.prepare('DELETE FROM photo_duplicates WHERE group_id = ?').run(g.group_id);
    }

    const deletePhotos = this.db.prepare('DELETE FROM photos WHERE folder_id = ?');
    deletePhotos.run(id);

    const stmt = this.db.prepare('DELETE FROM folders WHERE id = ?');
    stmt.run(id);
  }

  deletePhotosByFolder(folderId: string): void {
    const deletePhotoDuplicates = this.db.prepare(`
      DELETE FROM photo_duplicates WHERE photo_id IN (
        SELECT id FROM photos WHERE folder_id = ?
      )
    `);
    deletePhotoDuplicates.run(folderId);

    const deleteDuplicateGroups = this.db.prepare(`
      DELETE FROM duplicate_groups WHERE id NOT IN (
        SELECT DISTINCT group_id FROM photo_duplicates
      )
    `);
    deleteDuplicateGroups.run();

    const deletePhotos = this.db.prepare('DELETE FROM photos WHERE folder_id = ?');
    deletePhotos.run(folderId);
  }

  getFolders(): any[] {
    const stmt = this.db.prepare('SELECT * FROM folders ORDER BY added_at DESC');
    return stmt.all() as any[];
  }

  getFolderByPath(path: string): any | null {
    const stmt = this.db.prepare('SELECT * FROM folders WHERE path = ?');
    return stmt.get(path) as any | null;
  }

  updateFolderScanTime(id: string, photoCount: number): void {
    const stmt = this.db.prepare(`
      UPDATE folders SET last_scanned = CURRENT_TIMESTAMP, photo_count = ? WHERE id = ?
    `);
    stmt.run(photoCount, id);
  }

  insertPhoto(photo: any): void {
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

  insertPhotos(photos: any[]): void {
    const insert = this.db.transaction((items: any[]) => {
      for (const photo of items) {
        this.insertPhoto(photo);
      }
    });
    insert(photos);
  }

  getPhotos(filter: any = {}): any[] {
    let sql = 'SELECT * FROM photos WHERE 1=1';
    const params: any[] = [];

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
    return stmt.all(...params) as any[];
  }

  getPhotoById(id: string): any | null {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE id = ?');
    return stmt.get(id) as any | null;
  }

  getPhotoStats(): any {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM photos').get() as any).count;
    const withLocation = (this.db.prepare(
      'SELECT COUNT(*) as count FROM photos WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    ).get() as any).count;
    const duplicates = (this.db.prepare(
      'SELECT COUNT(*) as count FROM photo_duplicates'
    ).get() as any).count;
    const folders = (this.db.prepare(
      'SELECT COUNT(*) as count FROM folders'
    ).get() as any).count;
    const cameras = this.db.prepare(
      'SELECT camera, COUNT(*) as count FROM photos WHERE camera IS NOT NULL GROUP BY camera ORDER BY count DESC LIMIT 10'
    ).all() as any[];

    return {
      total,
      withLocation,
      withoutLocation: total - withLocation,
      duplicates,
      folders,
      cameras,
    };
  }

  findDuplicatesByHash(hash: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE file_hash = ?');
    return stmt.all(hash) as any[];
  }

  findDuplicatesByPHash(phash: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE perceptual_hash = ?');
    return stmt.all(phash) as any[];
  }

  findExactDuplicates(): { file_hash: string; photo_ids: string; count: number }[] {
    const stmt = this.db.prepare(`
      SELECT file_hash, GROUP_CONCAT(id) as photo_ids, COUNT(*) as count
      FROM photos
      WHERE file_hash IS NOT NULL
      GROUP BY file_hash
      HAVING COUNT(*) > 1
    `);
    return stmt.all() as { file_hash: string; photo_ids: string; count: number }[];
  }

  getPhotoDuplicateGroup(photoId: string): string | null {
    const row = this.db.prepare(
      'SELECT group_id FROM photo_duplicates WHERE photo_id = ?'
    ).get(photoId) as any;
    return row?.group_id || null;
  }

  insertDuplicateGroup(group: any): void {
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

  getDuplicateGroups(): any[] {
    const groups = this.db.prepare(`
      SELECT dg.*, 
        json_group_array(
          json_object(
            'id', p.id,
            'path', p.path,
            'filename', p.filename,
            'file_size', p.file_size,
            'taken_at', p.taken_at,
            'latitude', p.latitude,
            'longitude', p.longitude,
            'width', p.width,
            'height', p.height,
            'camera', p.camera
          )
        ) as photos
      FROM duplicate_groups dg
      JOIN photo_duplicates pd ON dg.id = pd.group_id
      JOIN photos p ON pd.photo_id = p.id
      GROUP BY dg.id
    `).all() as any[];

    return groups.map(g => ({
      ...g,
      photos: JSON.parse(g.photos),
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
      ).get(g.group_id) as any;
      if (remaining.count <= 1) {
        this.db.prepare('DELETE FROM duplicate_groups WHERE id = ?').run(g.group_id);
        this.db.prepare('DELETE FROM photo_duplicates WHERE group_id = ?').run(g.group_id);
      }
    }
  }

  updatePhotoLocation(id: string, lat: number, lng: number): void {
    const stmt = this.db.prepare(`
      UPDATE photos SET latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);
    stmt.run(lat, lng, id);
  }

  getAllPhotoPaths(): { id: string; path: string }[] {
    const stmt = this.db.prepare('SELECT id, path FROM photos');
    return stmt.all() as { id: string; path: string }[];
  }

  getPhotosByFolder(folderId: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE folder_id = ?');
    return stmt.all(folderId) as any[];
  }

  getAllPhotoIds(): string[] {
    const rows = this.db.prepare('SELECT id FROM photos').all() as any[];
    return rows.map(r => r.id);
  }

  getPhotoByPath(path: string): any | null {
    const stmt = this.db.prepare('SELECT * FROM photos WHERE path = ?');
    return stmt.get(path) as any | null;
  }

  getPhotosWithLocation(): any[] {
    const stmt = this.db.prepare(
      'SELECT id, path, filename, latitude, longitude, taken_at, camera, width, height, file_size FROM photos WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    return stmt.all() as any[];
  }

  clearDuplicateGroups(): void {
    this.db.prepare('DELETE FROM photo_duplicates').run();
    this.db.prepare('DELETE FROM duplicate_groups').run();
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
}
