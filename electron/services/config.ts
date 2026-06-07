import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { app } from 'electron';

export interface AppConfig {
  dataPath: string | null;
}

const DEFAULT_CONFIG: AppConfig = {
  dataPath: null,
};

export class ConfigService {
  private configPath: string;
  private config: AppConfig;

  constructor() {
    const userDataPath = app.getPath('userData');
    this.configPath = join(userDataPath, 'config.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): AppConfig {
    try {
      if (existsSync(this.configPath)) {
        const content = readFileSync(this.configPath, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
    return { ...DEFAULT_CONFIG };
  }

  private saveConfig(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save config:', error);
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

  getConfig(): AppConfig {
    return { ...this.config };
  }
}
