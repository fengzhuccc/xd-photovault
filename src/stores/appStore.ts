import { create } from 'zustand';
import type { Folder, Photo, PhotoStats, DuplicateGroup, ScanProgress, PhotoFilter, TimelineGroup } from '@/types';

interface AppState {
  folders: Folder[];
  photos: Photo[];
  photosOffset: number;
  photosTotal: number;
  photosHasMore: boolean;
  timeline: TimelineGroup[];
  stats: PhotoStats | null;
  duplicates: DuplicateGroup[];
  duplicatesTotal: number;
  duplicatesHasMore: boolean;
  scanProgress: ScanProgress | null;
  isScanning: boolean;
  scanningFolderId: string | null;
  duplicateProgress: { stage: 'hashing' | 'exact' | 'similar' | 'complete'; current: number; total: number; message: string } | null;
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
  setScanningFolderId: (folderId: string | null) => void;
  setDuplicateProgress: (progress: { stage: 'hashing' | 'exact' | 'similar' | 'complete'; current: number; total: number; message: string } | null) => void;
  
  setCurrentFilter: (filter: PhotoFilter) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveTab: (tab: 'library' | 'browse' | 'duplicates' | 'map') => void;
  
  setThumbnails: (thumbnails: Record<string, string>) => void;
  
  loadFolders: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadPhotos: (filter?: PhotoFilter) => Promise<void>;
  loadPhotosPage: (filter?: PhotoFilter, append?: boolean, limit?: number) => Promise<{ hasMore: boolean; total: number } | undefined>;
  loadPhotosAtOffset: (filter: PhotoFilter | undefined, offset: number, limit?: number) => Promise<{ hasMore: boolean; total: number } | undefined>;
  loadPreviousPhotosPage: (filter?: PhotoFilter, limit?: number) => Promise<{ hasMore: boolean; total: number } | undefined>;
  loadTimeline: (filter?: PhotoFilter) => Promise<void>;
  loadDuplicates: () => Promise<void>;
  loadDuplicatesPage: (append?: boolean) => Promise<{ hasMore: boolean; total: number } | undefined>;
  duplicateReason: 'all' | 'exact' | 'similar';
  setDuplicateReason: (reason: 'all' | 'exact' | 'similar') => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  folders: [],
  photos: [],
  photosOffset: 0,
  photosTotal: 0,
  photosHasMore: true,
  timeline: [],
  stats: null,
  duplicates: [],
  duplicatesTotal: 0,
  duplicatesHasMore: true,
  duplicateReason: 'all',
  scanProgress: null,
  isScanning: false,
  scanningFolderId: null,
  duplicateProgress: null,
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
  setScanningFolderId: (folderId) => set({
    scanningFolderId: folderId,
    isScanning: folderId !== null,
  }),
  setDuplicateProgress: (progress) => set({ duplicateProgress: progress }),

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
    const offset = append ? get().photos.length + get().photosOffset : 0;
    const result = await window.api.photo.getPage({ ...currentFilter, limit, offset });
    const existingIds = new Set(get().photos.map(p => p.id));
    const newPhotos = append
      ? [...get().photos, ...result.photos.filter((p: Photo) => !existingIds.has(p.id))]
      : result.photos;
    set({
      photos: newPhotos,
      photosOffset: append ? get().photosOffset : 0,
      photosTotal: result.total,
      photosHasMore: result.hasMore,
      currentFilter,
    });
    return { hasMore: result.hasMore, total: result.total };
  },

  loadPhotosAtOffset: async (filter, offset, limit = 500) => {
    const currentFilter = filter || get().currentFilter;
    const safeOffset = Math.max(0, offset);
    const result = await window.api.photo.getPage({ ...currentFilter, limit, offset: safeOffset });
    set({
      photos: result.photos,
      photosOffset: safeOffset,
      photosTotal: result.total,
      photosHasMore: result.hasMore,
      currentFilter,
    });
    return { hasMore: result.hasMore, total: result.total };
  },

  loadPreviousPhotosPage: async (filter, limit = 100) => {
    const currentFilter = filter || get().currentFilter;
    const currentOffset = get().photosOffset;
    if (currentOffset <= 0) {
      return { hasMore: get().photosHasMore, total: get().photosTotal };
    }
    const newOffset = Math.max(0, currentOffset - limit);
    const actualLimit = currentOffset - newOffset;
    const result = await window.api.photo.getPage({ ...currentFilter, limit: actualLimit, offset: newOffset });
    const existingIds = new Set(get().photos.map(p => p.id));
    const newPhotos = [...result.photos.filter((p: Photo) => !existingIds.has(p.id)), ...get().photos];
    set({
      photos: newPhotos,
      photosOffset: newOffset,
      photosTotal: result.total,
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
    const reason = get().duplicateReason;
    const result = await window.api.duplicate.getAll(50, 0, reason === 'all' ? undefined : reason);
    set({
      duplicates: result.groups,
      duplicatesTotal: result.total,
      duplicatesHasMore: result.groups.length < result.total,
    });
  },

  loadDuplicatesPage: async (append = false) => {
    const limit = 50;
    const offset = append ? get().duplicates.length : 0;
    const reason = get().duplicateReason;
    const result = await window.api.duplicate.getAll(limit, offset, reason === 'all' ? undefined : reason);
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

  setDuplicateReason: (reason) => {
    set({ duplicateReason: reason });
  },
}));
