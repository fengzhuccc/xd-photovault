import { contextBridge, ipcRenderer } from 'electron';

export const api = {
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
    openDataFolder: () => ipcRenderer.invoke('dialog:openDataFolder'),
  },
  
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    setDataPath: (path: string | null) => ipcRenderer.invoke('config:setDataPath', path),
    getDataPath: () => ipcRenderer.invoke('config:getDataPath'),
  },
  
  folder: {
    add: (path: string) => ipcRenderer.invoke('folder:add', path),
    remove: (id: string) => ipcRenderer.invoke('folder:remove', id),
    getAll: () => ipcRenderer.invoke('folder:getAll'),
  },
  
  scan: {
    start: (folderId: string) => ipcRenderer.invoke('scan:start', folderId),
    onProgress: (callback: (progress: ScanProgress) => void) => {
      const listener = (_event: unknown, progress: ScanProgress) => callback(progress);
      ipcRenderer.on('scan:progress', listener);
      return () => ipcRenderer.removeListener('scan:progress', listener);
    },
  },
  
  photo: {
    getAll: (filter?: PhotoFilter) => ipcRenderer.invoke('photo:getAll', filter),
    getById: (id: string) => ipcRenderer.invoke('photo:getById', id),
    getStats: () => ipcRenderer.invoke('photo:getStats'),
    updateLocation: (id: string, lat: number, lng: number) => 
      ipcRenderer.invoke('photo:updateLocation', id, lat, lng),
  },
  
  duplicate: {
    getAll: () => ipcRenderer.invoke('duplicate:getAll'),
    delete: (photoIds: string[]) => ipcRenderer.invoke('duplicate:delete', photoIds),
  },
  
  thumbnail: {
    get: (photoId: string, photoPath: string) => 
      ipcRenderer.invoke('thumbnail:get', photoId, photoPath),
    clear: () => ipcRenderer.invoke('thumbnail:clear'),
  },
};

export interface ScanProgress {
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'hashing' | 'complete' | 'idle';
}

export interface PhotoFilter {
  folderId?: string;
  dateStart?: string;
  dateEnd?: string;
  hasLocation?: boolean;
  camera?: string;
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
