import { create } from 'zustand';
import type { Folder, Photo, PhotoStats, DuplicateGroup, ScanProgress, PhotoFilter, TimelineGroup } from '@/types';

interface AppState {
  folders: Folder[];
  photos: Photo[];
  photosTotal: number;
  photosHasMore: boolean;
  timeline: TimelineGroup[];
  stats: PhotoStats | null;
  duplicates: DuplicateGroup[];
  duplicatesTotal: number;
  duplicatesHasMore: boolean;
  scanProgress: ScanProgress | null;
  isScanning: boolean;
  selectedPhoto: Photo | null;
  currentFilter: PhotoFilter;
  sidebarCollapsed: boolean;
  activeTab: 'library' | 'browse' | 'duplicates' | 'map';
  thumbnails: Record<string, string>;
  
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
  
  loadFolders: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadPhotos: (filter?: PhotoFilter) => Promise<void>;
  loadPhotosPage: (filter?: PhotoFilter, append?: boolean, limit?: number) => Promise<{ hasMore: boolean; total: number } | undefined>;
  loadTimeline: (filter?: PhotoFilter) => Promise<void>;
  loadDuplicates: () => Promise<void>;
  loadDuplicatesPage: (append?: boolean) => Promise<{ hasMore: boolean; total: number } | undefined>;
}

export const useAppStore = create<AppState>((set, get) => ({
  folders: [],
  photos: [],
  photosTotal: 0,
  photosHasMore: true,
  timeline: [],
  stats: null,
  duplicates: [],
  duplicatesTotal: 0,
  duplicatesHasMore: true,
  scanProgress: null,
  isScanning: false,
  selectedPhoto: null,
  currentFilter: {},
  sidebarCollapsed: false,
  activeTab: 'library',
  thumbnails: {},

  setFolders: (folders) => set({ folders }),
  addFolder: (folder) => set((state) => ({ folders: [folder, ...state.folders] })),
  removeFolder: (id) => set((state) => {
    const removedPhotoIds = new Set(
      state.photos.filter(p => p.folder_id === id).map(p => p.id)
    );
    const newPhotos = state.photos.filter(p => p.folder_id !== id);
    const newThumbnails: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.thumbnails)) {
      if (!removedPhotoIds.has(k)) newThumbnails[k] = v;
    }
    return {
      folders: state.folders.filter(f => f.id !== id),
      photos: newPhotos,
      thumbnails: newThumbnails,
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
    let thumbnailsChanged = false;
    const newThumbnails: Record<string, string> = {};
    for (const id of Object.keys(oldThumbnails)) {
      if (photoIds.has(id)) {
        newThumbnails[id] = oldThumbnails[id];
      } else {
        thumbnailsChanged = true;
      }
    }
    set({
      photos,
      photosTotal: photos.length,
      photosHasMore: false,
      currentFilter,
      ...(thumbnailsChanged ? { thumbnails: newThumbnails } : {}),
    });
  },

  loadPhotosPage: async (filter, append = false, limit = 100) => {
    const currentFilter = filter || get().currentFilter;
    const offset = append ? get().photos.length : 0;
    const result = await window.api.photo.getPage({ ...currentFilter, limit, offset });
    const existingIds = new Set(get().photos.map(p => p.id));
    const newPhotos = append
      ? [...get().photos, ...result.photos.filter((p: Photo) => !existingIds.has(p.id))]
      : result.photos;
    set({
      photos: newPhotos,
      photosTotal: result.total,
      photosHasMore: result.hasMore,
      currentFilter,
    });
    return { hasMore: result.hasMore, total: result.total };
  },

  loadTimeline: async (filter) => {
    const currentFilter = filter || get().currentFilter;
    const timeline = await window.api.photo.getTimeline(currentFilter);
    set({ timeline, currentFilter });
  },

  loadDuplicates: async () => {
    const result = await window.api.duplicate.getAll(50, 0);
    set({
      duplicates: result.groups,
      duplicatesTotal: result.total,
      duplicatesHasMore: result.groups.length < result.total,
    });
  },

  loadDuplicatesPage: async (append = false) => {
    const limit = 50;
    const offset = append ? get().duplicates.length : 0;
    const result = await window.api.duplicate.getAll(limit, offset);
    const existingIds = new Set(get().duplicates.map(g => g.id));
    const newDuplicates = append
      ? [...get().duplicates, ...result.groups.filter((g: DuplicateGroup) => !existingIds.has(g.id))]
      : result.groups;
    set({
      duplicates: newDuplicates,
      duplicatesTotal: result.total,
      duplicatesHasMore: offset + result.groups.length < result.total,
    });
    return { hasMore: offset + result.groups.length < result.total, total: result.total };
  },
}));
