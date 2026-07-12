import { create } from 'zustand';
import type { Folder, Photo, PhotoStats, DuplicateGroup, ScanProgress, PhotoFilter, TimelineGroup, AiIndexProgress } from '@/types';

export interface BrowseScrollState {
  /** 全局排序下的照片索引 */
  index: number;
  /** 索引在视口中的对齐方式 */
  align?: 'start' | 'center' | 'end';
}

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
  lastScanResult: ScanProgress | null;
  duplicateProgress: { stage: 'hashing' | 'exact' | 'similar' | 'complete'; current: number; total: number; message: string } | null;
  selectedPhoto: Photo | null;
  currentFilter: PhotoFilter;
  sidebarCollapsed: boolean;
  activeTab: 'library' | 'browse' | 'duplicates' | 'map';
  thumbnails: Record<string, string>;
  aiIndexProgress: AiIndexProgress | null;
  aiSearchQuery: string;
  aiSearchResults: Photo[];
  aiSearchSimilarities: Record<string, number>;
  aiSearching: boolean;
  aiGpuEnabled: boolean;
  aiGpuActualProvider: string;
  /** 浏览页切走前保存的滚动位置（全局索引） */
  browseScrollState: BrowseScrollState | null;
  trashCount: number;
  trashTotalSize: number;

  setFolders: (folders: Folder[]) => void;
  addFolder: (folder: Folder) => void;
  removeFolder: (id: string) => void;

  setPhotos: (photos: Photo[]) => void;
  setSelectedPhoto: (photo: Photo | null) => void;
  removePhotos: (ids: string[]) => void;

  setStats: (stats: PhotoStats) => void;
  setDuplicates: (duplicates: DuplicateGroup[]) => void;

  setScanProgress: (progress: ScanProgress | null) => void;
  setIsScanning: (isScanning: boolean) => void;
  setScanningFolderId: (folderId: string | null) => void;
  clearLastScanResult: () => void;
  setDuplicateProgress: (progress: { stage: 'hashing' | 'exact' | 'similar' | 'complete'; current: number; total: number; message: string } | null) => void;

  setCurrentFilter: (filter: PhotoFilter) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setActiveTab: (tab: 'library' | 'browse' | 'duplicates' | 'map') => void;

  setThumbnails: (thumbnails: Record<string, string>) => void;
  setBrowseScrollState: (state: BrowseScrollState | null) => void;

  setAiIndexProgress: (progress: AiIndexProgress | null) => void;
  setAiSearchQuery: (query: string) => void;
  setAiSearchResults: (results: Photo[]) => void;
  setAiSearchSimilarities: (similarities: Record<string, number>) => void;
  setAiSearching: (searching: boolean) => void;
  setAiGpuStatus: (status: { enabled: boolean; actualProvider: string }) => void;
  setAiGpuEnabled: (enabled: boolean) => void;
  loadAiGpuStatus: () => Promise<void>;
  toggleAiGpu: () => Promise<void>;
  startAiIndex: () => Promise<void>;
  pauseAiIndex: () => Promise<void>;
  resumeAiIndex: () => Promise<void>;
  cancelAiIndex: () => Promise<void>;
  aiSearch: (query: string) => Promise<void>;

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

  setTrashCount: (count: number) => void;
  setTrashTotalSize: (size: number) => void;
  loadTrashCount: () => Promise<void>;
  loadTrashStats: () => Promise<void>;
}

// AI 搜索请求令牌，用于取消过期请求
let aiSearchToken = 0;

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
  lastScanResult: null,
  duplicateProgress: null,
  selectedPhoto: null,
  currentFilter: {},
  sidebarCollapsed: false,
  activeTab: 'library',
  thumbnails: {},
  aiIndexProgress: null,
  aiSearchQuery: '',
  aiSearchResults: [],
  aiSearchSimilarities: {},
  aiSearching: false,
  aiGpuEnabled: false,
  aiGpuActualProvider: 'cpu',
  browseScrollState: null,
  trashCount: 0,
  trashTotalSize: 0,

  setTrashCount: (count) => set({ trashCount: count }),
  setTrashTotalSize: (size) => set({ trashTotalSize: size }),
  loadTrashCount: async () => {
    try {
      const count = await window.api.trash.getCount();
      set({ trashCount: count });
    } catch (e) {
      console.error('[Trash] 加载回收站数量失败:', e);
    }
  },
  loadTrashStats: async () => {
    try {
      const stats = await window.api.trash.getStats();
      set({ trashCount: stats.count, trashTotalSize: stats.totalSize });
    } catch (e) {
      console.error('[Trash] 加载回收站统计失败:', e);
    }
  },

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
  removePhotos: (ids) => set((state) => {
    const idSet = new Set(ids);
    const newPhotos = state.photos.filter(p => !idSet.has(p.id));
    const newThumbnails: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.thumbnails)) {
      if (!idSet.has(k)) newThumbnails[k] = v;
    }
    const newAiSearchResults = state.aiSearchResults.filter(p => !idSet.has(p.id));
    const newAiSearchSimilarities: Record<string, number> = {};
    for (const [k, v] of Object.entries(state.aiSearchSimilarities)) {
      if (!idSet.has(k)) newAiSearchSimilarities[k] = v;
    }
    return {
      photos: newPhotos,
      thumbnails: newThumbnails,
      aiSearchResults: newAiSearchResults,
      aiSearchSimilarities: newAiSearchSimilarities,
    };
  }),

  setStats: (stats) => set({ stats }),
  setDuplicates: (duplicates) => set({ duplicates }),

  setScanProgress: (progress) => set({ scanProgress: progress }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setScanningFolderId: (folderId) => set({
    scanningFolderId: folderId,
    isScanning: folderId !== null,
  }),
  clearLastScanResult: () => set({ lastScanResult: null }),
  setDuplicateProgress: (progress) => set({ duplicateProgress: progress }),

  setCurrentFilter: (filter) => set({ currentFilter: filter }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  setThumbnails: (thumbnails) => set({ thumbnails }),
  setBrowseScrollState: (state) => set({ browseScrollState: state }),

  setAiIndexProgress: (progress) => set({ aiIndexProgress: progress }),
  setAiSearchQuery: (query) => set({ aiSearchQuery: query }),
  setAiSearchResults: (results) => set({ aiSearchResults: results }),
  setAiSearchSimilarities: (similarities) => set({ aiSearchSimilarities: similarities }),
  setAiSearching: (searching) => set({ aiSearching: searching }),
  setAiGpuStatus: (status) => set({
    aiGpuEnabled: status.enabled,
    aiGpuActualProvider: status.actualProvider,
  }),
  setAiGpuEnabled: (enabled) => set({ aiGpuEnabled: enabled }),
  loadAiGpuStatus: async () => {
    try {
      const status = await window.api.aiIndex.getGpuStatus();
      get().setAiGpuStatus(status);
    } catch (e) {
      console.error('[AI] 加载 GPU 状态失败:', e);
    }
  },
  toggleAiGpu: async () => {
    const next = !get().aiGpuEnabled;
    try {
      const result = await window.api.aiIndex.setUseGpu(next);
      if (result.success) {
        set({ aiGpuEnabled: next, aiGpuActualProvider: 'cpu' });
      } else {
        console.error('[AI] 切换 GPU 加速失败:', result.error);
      }
    } catch (e) {
      console.error('[AI] 切换 GPU 加速失败:', e);
    }
  },

  startAiIndex: async () => {
    await window.api.aiIndex.start();
  },
  pauseAiIndex: async () => {
    await window.api.aiIndex.pause();
  },
  resumeAiIndex: async () => {
    await window.api.aiIndex.resume();
  },
  cancelAiIndex: async () => {
    await window.api.aiIndex.cancel();
  },

  aiSearch: async (query) => {
    if (!query.trim()) {
      set({ aiSearchResults: [], aiSearchSimilarities: {}, aiSearchQuery: '', aiSearching: false });
      return;
    }
    // H-17: 使用请求令牌，防止快速连续搜索时过期结果覆盖最新结果
    aiSearchToken++;
    const token = aiSearchToken;
    set({ aiSearching: true, aiSearchQuery: query });
    try {
      const response = await window.api.aiSearch.search(query.trim(), 100);
      if (token !== aiSearchToken) return; // 过期请求，忽略
      if (response.success && response.results) {
        const photos = response.results.map((r: { photo: Photo; similarity: number }) => r.photo);
        const similarities: Record<string, number> = {};
        for (const r of response.results as { photo: Photo; similarity: number }[]) {
          similarities[r.photo.id] = r.similarity;
        }
        set({ aiSearchResults: photos, aiSearchSimilarities: similarities, aiSearching: false });
      } else {
        set({ aiSearchResults: [], aiSearchSimilarities: {}, aiSearching: false });
      }
    } catch {
      if (token !== aiSearchToken) return;
      set({ aiSearchResults: [], aiSearchSimilarities: {}, aiSearching: false });
    }
  },

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
      // photosHasMore 表示"向下是否还有更多"，向上加载不改变此状态，
      // 但用服务端最新结果更新，避免数据变化导致状态过期
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

// 监听 AI 索引进度
if (typeof window !== 'undefined' && window.api?.aiIndex?.onProgress) {
  window.api.aiIndex.onProgress((progress) => {
    useAppStore.setState({ aiIndexProgress: progress });
  });
}

// 全局监听扫描进度：即使离开照片库页面也能正确更新扫描状态和统计数据
if (typeof window !== 'undefined' && window.api?.scan?.onProgress) {
  window.api.scan.onProgress((progress) => {
    useAppStore.setState({ scanProgress: progress });
    if (progress.status === 'complete' || progress.status === 'idle') {
      useAppStore.setState({ scanningFolderId: null, isScanning: false });
    }
    if (progress.status === 'complete') {
      useAppStore.setState({ lastScanResult: progress });
      const { loadPhotosPage, loadTimeline, loadFolders, loadStats } = useAppStore.getState();
      loadPhotosPage({}).catch((e) => console.error('[ScanProgress] 刷新照片失败:', e));
      loadTimeline({}).catch((e) => console.error('[ScanProgress] 刷新时间线失败:', e));
      loadFolders().catch((e) => console.error('[ScanProgress] 刷新文件夹失败:', e));
      loadStats().catch((e) => console.error('[ScanProgress] 刷新统计失败:', e));
    }
  });
}
