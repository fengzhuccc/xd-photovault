import { create } from 'zustand';
import type { Folder, Photo, PhotoStats, DuplicateGroup, ScanProgress, PhotoFilter } from '@/types';

interface AppState {
  folders: Folder[];
  photos: Photo[];
  stats: PhotoStats | null;
  duplicates: DuplicateGroup[];
  scanProgress: ScanProgress | null;
  isScanning: boolean;
  selectedPhoto: Photo | null;
  currentFilter: PhotoFilter;
  sidebarCollapsed: boolean;
  activeTab: 'library' | 'browse' | 'duplicates' | 'map';
  thumbnails: Record<string, string>;
  originalImages: Record<string, string>;
  
  setFolders: (folders: Folder[]) => void;
  addFolder: (folder: Folder) => void;
  removeFolder: (id: string) => void;
  
  setPhotos: (photos: Photo[]) => void;
  setSelectedPhoto: (photo: Photo | null) => void;
  
  setStats: (stats: PhotoStats) => void;
  setDuplicates: (duplicates: DuplicateGroup[]) => void;
  
  setScanProgress: (progress: ScanProgress | null) => void;
  setIsScanning: (isScanning: boolean) => void;
  
  setCurrentFilter: (filter: PhotoFilter) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveTab: (tab: 'library' | 'browse' | 'duplicates' | 'map') => void;
  
  setThumbnails: (thumbnails: Record<string, string>) => void;
  setOriginalImages: (originalImages: Record<string, string>) => void;
  
  loadFolders: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadPhotos: (filter?: PhotoFilter) => Promise<void>;
  loadDuplicates: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  folders: [],
  photos: [],
  stats: null,
  duplicates: [],
  scanProgress: null,
  isScanning: false,
  selectedPhoto: null,
  currentFilter: {},
  sidebarCollapsed: false,
  activeTab: 'library',
  thumbnails: {},
  originalImages: {},

  setFolders: (folders) => set({ folders }),
  addFolder: (folder) => set((state) => ({ folders: [folder, ...state.folders] })),
  removeFolder: (id) => set((state) => {
    const removedPhotoIds = new Set(
      state.photos.filter(p => p.folder_id === id).map(p => p.id)
    );
    const newPhotos = state.photos.filter(p => p.folder_id !== id);
    const newThumbnails: Record<string, string> = {};
    const newOriginalImages: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.thumbnails)) {
      if (!removedPhotoIds.has(k)) newThumbnails[k] = v;
    }
    for (const [k, v] of Object.entries(state.originalImages)) {
      if (!removedPhotoIds.has(k)) newOriginalImages[k] = v;
    }
    return {
      folders: state.folders.filter(f => f.id !== id),
      photos: newPhotos,
      thumbnails: newThumbnails,
      originalImages: newOriginalImages,
    };
  }),

  setPhotos: (photos) => set({ photos }),
  setSelectedPhoto: (photo) => set({ selectedPhoto: photo }),

  setStats: (stats) => set({ stats }),
  setDuplicates: (duplicates) => set({ duplicates }),

  setScanProgress: (progress) => set({ scanProgress: progress }),
  setIsScanning: (isScanning) => set({ isScanning }),

  setCurrentFilter: (filter) => set({ currentFilter: filter }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  setThumbnails: (thumbnails) => set({ thumbnails }),
  setOriginalImages: (originalImages) => set({ originalImages }),

  loadFolders: async () => {
    const folders = await window.api.folder.getAll();
    set({ folders });
  },

  loadStats: async () => {
    const stats = await window.api.photo.getStats();
    set({ stats });
  },

  loadPhotos: async (filter) => {
    const currentFilter = filter || get().currentFilter;
    const photos = await window.api.photo.getAll(currentFilter);
    // 清理不在当前照片列表中的缩略图缓存
    const photoIds = new Set(photos.map(p => p.id));
    const oldThumbnails = get().thumbnails;
    const oldOriginalImages = get().originalImages;
    let thumbnailsChanged = false;
    let originalsChanged = false;
    const newThumbnails: Record<string, string> = {};
    const newOriginalImages: Record<string, string> = {};
    for (const id of Object.keys(oldThumbnails)) {
      if (photoIds.has(id)) {
        newThumbnails[id] = oldThumbnails[id];
      } else {
        thumbnailsChanged = true;
      }
    }
    for (const id of Object.keys(oldOriginalImages)) {
      if (photoIds.has(id)) {
        newOriginalImages[id] = oldOriginalImages[id];
      } else {
        originalsChanged = true;
      }
    }
    set({
      photos,
      currentFilter,
      ...(thumbnailsChanged ? { thumbnails: newThumbnails } : {}),
      ...(originalsChanged ? { originalImages: newOriginalImages } : {}),
    });
  },

  loadDuplicates: async () => {
    const duplicates = await window.api.duplicate.getAll();
    set({ duplicates });
  },
}));
