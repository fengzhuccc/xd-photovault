import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { app } from 'electron';
import log from 'electron-log';

export interface AppConfig {
  dataPath: string | null;
  logPath: string | null;
}

const DEFAULT_CONFIG: AppConfig = {
  dataPath: null,
  logPath: null,
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
      log.error('Failed to load config:', error);
    }
    return { ...DEFAULT_CONFIG };
  }

  private saveConfig(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      log.error('Failed to save config:', error);
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
      const devPath = join(__dirname, '..', 'data');
      if (!existsSync(devPath)) {
        mkdirSync(devPath, { recursive: true });
      }
      return devPath;
    }
    
    const userDataPath = app.getPath('userData');
    const defaultPath = join(userDataPath, 'data');
    if (!existsSync(defaultPath)) {
      mkdirSync(defaultPath, { recursive: true });
    }
    return defaultPath;
  }

  setDataPath(path: string | null): void {
    this.config.dataPath = path;
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
