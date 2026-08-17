import { join } from 'path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { app } from 'electron';
import log from 'electron-log';

export interface AppConfig {
  dataPath: string | null;
  logPath: string | null;
  language: string | null;
}

const DEFAULT_CONFIG: AppConfig = {
  dataPath: null,
  logPath: null,
  language: null,
};

export class ConfigService {
  private configPath: string;
  private config: AppConfig;
  private db: { getSetting: (key: string) => string | null; setSetting: (key: string, value: string) => void; removeSetting: (key: string) => void } | null = null;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.configPath = join(userDataPath, 'config.json');
    this.config = this.loadConfig();
  }

  setDatabase(db: { getSetting: (key: string) => string | null; setSetting: (key: string, value: string) => void; removeSetting: (key: string) => void }): void {
    this.db = db;
    // 迁移 config.json 中的 logPath 到数据库
    if (this.config.logPath && !db.getSetting('logPath')) {
      db.setSetting('logPath', this.config.logPath);
      this.config.logPath = null;
      this.saveConfig();
    }
  }

  private loadConfig(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const content = readFileSync(this.configPath, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
      }
    } catch (error) {
      // 配置损坏（如写入中途断电留下的截断 JSON）：备份残留文件并告警，
      // 避免静默回退默认配置导致 dataPath "丢失"、用户数据看起来全部消失
      log.error('Failed to load config (file may be corrupted):', error);
      this.backupCorruptedConfig();
    }
    return { ...DEFAULT_CONFIG };
  }

  /** 备份损坏的配置文件，便于用户手动找回 dataPath */
  private backupCorruptedConfig(): void {
    try {
      if (existsSync(this.configPath)) {
        const backupPath = `${this.configPath}.corrupted-${Date.now()}`;
        copyFileSync(this.configPath, backupPath);
        log.error(`Corrupted config backed up to: ${backupPath}`);
      }
    } catch {
      // 备份失败不影响启动
    }
  }

  private saveConfig(): void {
    // 原子写：先写临时文件再 rename，避免写入中途崩溃/断电留下截断的 JSON
    const tmpPath = `${this.configPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.config, null, 2), 'utf-8');
      renameSync(tmpPath, this.configPath);
    } catch (error) {
      log.error('Failed to save config:', error);
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
      } catch {
        // 清理失败忽略
      }
    }
  }

  getDataPath(): string {
    if (this.config.dataPath) {
      if (!existsSync(this.config.dataPath)) {
        mkdirSync(this.config.dataPath, { recursive: true });
      }
      return this.config.dataPath;
    }
    
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    if (isDev) {
      const devPath = join(__dirname, '..', 'xd-photovault-data');
      if (!existsSync(devPath)) {
        mkdirSync(devPath, { recursive: true });
      }
      return devPath;
    }

    const userDataPath = app.getPath('userData');
    const defaultPath = join(userDataPath, 'xd-photovault-data');
    if (!existsSync(defaultPath)) {
      mkdirSync(defaultPath, { recursive: true });
    }
    return defaultPath;
  }

  setDataPath(path: string | null): void {
    this.config.dataPath = path;
    this.saveConfig();
  }

  getLanguage(): string | null {
    return this.config.language;
  }

  setLanguage(lang: string | null): void {
    this.config.language = lang;
    this.saveConfig();
  }

  getLogPath(): string | null {
    if (this.db) {
      return this.db.getSetting('logPath');
    }
    return this.config.logPath;
  }

  setLogPath(path: string | null): void {
    if (path && !existsSync(path)) {
      mkdirSync(path, { recursive: true });
    }
    if (this.db) {
      if (path) {
        this.db.setSetting('logPath', path);
      } else {
        this.db.removeSetting('logPath');
      }
    }
    // 同步更新 config.json（向后兼容）
    this.config.logPath = path;
    this.saveConfig();
  }

  getConfig(): AppConfig {
    return { ...this.config };
  }
}
