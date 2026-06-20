import { contextBridge, ipcRenderer } from 'electron';

export const api = {
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openDataFolder: () => ipcRenderer.invoke('dialog:openDataFolder'),
    openLogFolder: () => ipcRenderer.invoke('dialog:openLogFolder'),
  },
  
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    setDataPath: (path: string | null) => ipcRenderer.invoke('config:setDataPath', path),
    getDataPath: () => ipcRenderer.invoke('config:getDataPath'),
    setLogPath: (path: string | null) => ipcRenderer.invoke('config:setLogPath', path),
    getLogPath: () => ipcRenderer.invoke('config:getLogPath'),
  },
  
  folder: {
    add: (path: string) => ipcRenderer.invoke('folder:add', path),
    remove: (id: string) => ipcRenderer.invoke('folder:remove', id),
    getAll: () => ipcRenderer.invoke('folder:getAll'),
    replaceWithParent: (childFolderIds: string[], parentPath: string) => ipcRenderer.invoke('folder:replaceWithParent', childFolderIds, parentPath),
  },
  
  scan: {
    start: (folderId: string, forceRescan?: boolean) => ipcRenderer.invoke('scan:start', folderId, forceRescan),
    isScanning: () => ipcRenderer.invoke('scan:isScanning'),
    onProgress: (callback: (progress: ScanProgress) => void) => {
      const listener = (_event: unknown, progress: ScanProgress) => callback(progress);
      ipcRenderer.on('scan:progress', listener);
      return () => ipcRenderer.removeListener('scan:progress', listener);
    },
  },
  
  photo: {
    getAll: (filter?: PhotoFilter) => ipcRenderer.invoke('photo:getAll', filter),
    getPage: (filter?: PhotoFilter) => ipcRenderer.invoke('photo:getPage', filter),
    getTimeline: (filter?: PhotoFilter) => ipcRenderer.invoke('photo:getTimeline', filter),
    getOffsetByMonth: (filter: PhotoFilter, monthKey: string) => ipcRenderer.invoke('photo:getOffsetByMonth', filter, monthKey),
    getById: (id: string) => ipcRenderer.invoke('photo:getById', id),
    getStats: () => ipcRenderer.invoke('photo:getStats'),
    updateLocation: (id: string, lat: number, lng: number) => 
      ipcRenderer.invoke('photo:updateLocation', id, lat, lng),
    updateDate: (id: string, date: string) =>
      ipcRenderer.invoke('photo:updateDate', id, date),
    delete: (photoIds: string[]) => ipcRenderer.invoke('photo:delete', photoIds),
    getWithLocation: () => ipcRenderer.invoke('photo:getWithLocation'),
    getInBounds: (south: number, west: number, north: number, east: number) =>
      ipcRenderer.invoke('photo:getInBounds', south, west, north, east),
    getClustersInBounds: (south: number, west: number, north: number, east: number, zoom: number) =>
      ipcRenderer.invoke('photo:getClustersInBounds', south, west, north, east, zoom),
  },

  mapSetting: {
    get: (key: string) => ipcRenderer.invoke('map:getSetting', key),
    set: (key: string, value: string) => ipcRenderer.invoke('map:setSetting', key, value),
  },
  
  duplicate: {
    getAll: (limit?: number, offset?: number, reason?: 'exact' | 'similar') => ipcRenderer.invoke('duplicate:getAll', limit, offset, reason),
    detect: (fullRebuild?: boolean) => ipcRenderer.invoke('duplicate:detect', fullRebuild),
    detectExact: (fullRebuild?: boolean) => ipcRenderer.invoke('duplicate:detectExact', fullRebuild),
    detectSimilar: (fullRebuild?: boolean) => ipcRenderer.invoke('duplicate:detectSimilar', fullRebuild),
    delete: (photoIds: string[]) => ipcRenderer.invoke('duplicate:delete', photoIds),
    onProgress: (callback: (progress: { stage: 'hashing' | 'exact' | 'similar' | 'complete'; current: number; total: number; message: string }) => void) => {
      const listener = (_event: unknown, progress: { stage: 'hashing' | 'exact' | 'similar' | 'complete'; current: number; total: number; message: string }) => callback(progress);
      ipcRenderer.on('duplicate:progress', listener);
      return () => { ipcRenderer.removeListener('duplicate:progress', listener); };
    },
  },
  
  thumbnail: {
    get: (photoId: string, photoPath: string, size?: 'small' | 'medium') => 
      ipcRenderer.invoke('thumbnail:get', photoId, photoPath, size),
    getBatch: (items: { photoId: string; photoPath: string; size?: 'small' | 'medium' }[]) =>
      ipcRenderer.invoke('thumbnail:getBatch', items),
    stats: () => ipcRenderer.invoke('thumbnail:stats') as Promise<{ count: number; totalSize: number; smallCount: number; mediumCount: number }>,
    clear: () => ipcRenderer.invoke('thumbnail:clear'),
  },

  database: {
    clear: () => ipcRenderer.invoke('database:clear'),
  },

  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    read: (lines?: number) => ipcRenderer.invoke('log:read', lines),
    clear: () => ipcRenderer.invoke('log:clear'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
  },

  app: {
    openPath: (path: string) => ipcRenderer.invoke('app:openPath', path),
  },
};

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

export interface PhotoFilter {
  folderId?: string;
  dateStart?: string;
  dateEnd?: string;
  hasLocation?: boolean;
  camera?: string;
  mediaType?: 'all' | 'image' | 'video';
  limit?: number;
  offset?: number;
}

export interface Folder {
  id: string;
  path: string;
  added_at: string;
  last_scanned: string | null;
  photo_count: number;
}

export interface Photo {
  id: string;
  folder_id: string;
  path: string;
  filename: string;
  file_size: number;
  taken_at: string | null;
  latitude: number | null;
  longitude: number | null;
  width: number;
  height: number;
  camera: string | null;
  thumbnail: string | null;
}

export interface PhotoDetail extends Photo {
  file_hash: string;
  perceptual_hash: string;
  aperture: string | null;
  shutter_speed: string | null;
  iso: number | null;
  focal_length: string | null;
}

export interface DuplicateGroup {
  id: string;
  reason: 'exact' | 'similar';
  recommended_photo_id: string;
  photos: Photo[];
}

export interface PhotoStats {
  total: number;
  withLocation: number;
  withoutLocation: number;
  duplicates: number;
  folders: number;
  cameras: { camera: string; count: number }[];
}

contextBridge.exposeInMainWorld('api', api);
