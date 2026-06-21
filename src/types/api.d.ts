import type { PhotoFilter, ScanProgress, AiIndexProgress } from './index';

export interface WindowApi {
  dialog: {
    openFolder: () => Promise<string | null>;
    openDataFolder: () => Promise<string | null>;
    openLogFolder: () => Promise<string | null>;
  };
  config: {
    get: () => Promise<unknown>;
    setDataPath: (path: string | null) => Promise<{ success: boolean; requiresRestart?: boolean }>;
    getDataPath: () => Promise<string>;
    setLogPath: (path: string | null) => Promise<{ success: boolean }>;
    getLogPath: () => Promise<string>;
  };
  folder: {
    add: (path: string) => Promise<unknown>;
    remove: (id: string) => Promise<void>;
    getAll: () => Promise<unknown[]>;
    replaceWithParent: (childFolderIds: string[], parentPath: string) => Promise<unknown>;
  };
  scan: {
    start: (folderId: string, forceRescan?: boolean) => Promise<unknown>;
    isScanning: () => Promise<boolean>;
    onProgress: (callback: (progress: ScanProgress) => void) => () => void;
  };
  photo: {
    getAll: (filter?: PhotoFilter) => Promise<{ id: string }[]>;
    getPage: (filter?: PhotoFilter) => Promise<{ photos: unknown[]; total: number; hasMore: boolean }>;
    getTimeline: (filter?: PhotoFilter) => Promise<unknown[]>;
    getOffsetByMonth: (filter: PhotoFilter, monthKey: string) => Promise<number | null>;
    getById: (id: string) => Promise<unknown | null>;
    getStats: () => Promise<unknown>;
    updateLocation: (id: string, lat: number, lng: number) => Promise<{ success: boolean }>;
    updateDate: (id: string, date: string) => Promise<{ success: boolean }>;
    delete: (photoIds: string[]) => Promise<unknown>;
    getWithLocation: () => Promise<unknown[]>;
    getInBounds: (south: number, west: number, north: number, east: number) => Promise<unknown[]>;
    getClustersInBounds: (south: number, west: number, north: number, east: number, zoom: number) => Promise<unknown[]>;
  };
  mapSetting: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<{ success: boolean }>;
  };
  duplicate: {
    getAll: (limit?: number, offset?: number, reason?: 'exact' | 'similar') => Promise<unknown>;
    detectExact: (fullRebuild?: boolean) => Promise<unknown>;
    detectSimilar: (fullRebuild?: boolean) => Promise<unknown>;
    delete: (photoIds: string[]) => Promise<unknown>;
    onProgress: (callback: (progress: { stage: 'hashing' | 'exact' | 'similar' | 'complete'; current: number; total: number; message: string }) => void) => () => void;
  };
  thumbnail: {
    get: (photoId: string, photoPath: string, size?: 'small' | 'medium') => Promise<string | null>;
    getBatch: (items: { photoId: string; photoPath: string; size?: 'small' | 'medium' }[]) => Promise<Record<string, string>>;
    stats: () => Promise<{ count: number; totalSize: number; smallCount: number; mediumCount: number }>;
    clear: () => Promise<unknown>;
  };
  database: {
    clear: () => Promise<unknown>;
  };
  aiSearch: {
    search: (query: string, limit?: number) => Promise<{ success: boolean; results?: { photo: unknown; similarity: number }[]; error?: string }>;
  };
  aiIndex: {
    start: () => Promise<{ success: boolean; message?: string }>;
    pause: () => Promise<{ success: boolean }>;
    resume: () => Promise<{ success: boolean }>;
    cancel: () => Promise<{ success: boolean }>;
    getStatus: () => Promise<AiIndexProgress>;
    getGpuStatus: () => Promise<{ enabled: boolean; actualProvider: string }>;
    setUseGpu: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
    onProgress: (callback: (progress: AiIndexProgress) => void) => () => void;
  };
  log: {
    getPath: () => Promise<string>;
    read: (lines?: number) => Promise<string>;
    clear: () => Promise<{ success: boolean; error?: string }>;
    openFolder: () => Promise<{ success: boolean }>;
  };
  app: {
    openPath: (path: string) => Promise<{ success: boolean; error?: string }>;
  };
}

declare global {
  interface Window {
    api: WindowApi;
  }
}

export {};
