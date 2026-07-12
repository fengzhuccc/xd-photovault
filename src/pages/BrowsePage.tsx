import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Filter, Grid3X3, MapPin, Camera, Trash2, CheckCircle2, Circle, Loader2, Play, Image, Film, Search, X, FolderOpen, MapPinned } from 'lucide-react';
import { MapPickerModal } from '@/components/MapPickerModal';
import Empty from '@/components/Empty';
import { VirtuosoGrid, type VirtuosoGridHandle } from 'react-virtuoso';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn, isTypingTarget } from '@/lib/utils';
import { useFormatDate } from '@/lib/useFormatDate';
import { confirmFirstTrashMove } from '@/lib/trashPrompt';
import { PhotoDetailModal } from '@/components/PhotoDetailModal';
import type { Photo } from '@/types';

interface PhotoGridItemProps {
  photo: Photo;
  thumbnail?: string;
  similarity?: number;
  isSelected: boolean;
  selectMode: boolean;
  onSelect: (photo: Photo) => void;
  onToggleSelect: (photoId: string, e?: React.MouseEvent) => void;
  formatDate: (date: string | Date | null | undefined, fallback?: string, options?: Intl.DateTimeFormatOptions) => string;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const PhotoGridItem = React.memo(function PhotoGridItem({
  photo,
  thumbnail,
  similarity,
  isSelected,
  selectMode,
  onSelect,
  onToggleSelect,
  formatDate,
}: PhotoGridItemProps) {
  const { t } = useTranslation();
  const isVideo = photo.media_type === 'video';
  const showSimilarity = similarity !== undefined && !selectMode;

  const handleClick = () => {
    if (selectMode) {
      onToggleSelect(photo.id);
    } else {
      onSelect(photo);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={cn(
        'aspect-square cursor-pointer group relative overflow-hidden rounded-lg bg-zinc-800',
        selectMode && isSelected && 'ring-2 ring-amber-500 ring-offset-1 ring-offset-zinc-950'
      )}
    >
      {thumbnail ? (
        <img
          src={thumbnail}
          alt={photo.filename}
          className={cn(
            'w-full h-full object-cover transition-transform duration-200',
            !selectMode && 'group-hover:scale-105',
            selectMode && isSelected && 'opacity-80'
          )}
          loading="lazy"
        />
      ) : (
        <div className="w-full h-full skeleton flex items-center justify-center">
          <div className="w-8 h-8 rounded bg-zinc-700/50" />
        </div>
      )}
      {showSimilarity && (
        <div className="absolute top-2 left-2 z-10 px-1.5 py-0.5 rounded bg-amber-500/90 text-xs text-black font-semibold pointer-events-none shadow-sm">
          {(similarity * 100).toFixed(1)}%
        </div>
      )}
      {isVideo && !selectMode && (
        <>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/40 rounded-full p-3 backdrop-blur-sm">
              <Play size={24} className="text-white fill-white" />
            </div>
          </div>
          {photo.duration !== null && photo.duration > 0 && (
            <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-xs text-white font-medium pointer-events-none">
              {formatDuration(photo.duration)}
            </div>
          )}
        </>
      )}
      {selectMode && (
        <div className="absolute top-2 right-2 z-10">
          {isSelected ? (
            <CheckCircle2 size={24} className="text-amber-500 drop-shadow-lg" />
          ) : (
            <Circle size={24} className="text-white/60 drop-shadow-lg" />
          )}
        </div>
      )}
      {!selectMode && (
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="absolute bottom-0 left-0 right-0 p-2">
            <p className="text-xs text-white truncate">{photo.filename}</p>
            <p className="text-xs text-zinc-200">{formatDate(photo.taken_at, t('common.unknownDate'), { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          </div>
        </div>
      )}
    </div>
  );
});

const GridList = React.forwardRef<HTMLDivElement, any>(({ style, children, ...props }, ref) => (
  <div
    ref={ref}
    style={style}
    {...props}
    className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-1 p-1"
  >
    {children}
  </div>
));

const GridItem = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

export function BrowsePage() {
  const {
    photos,
    photosOffset,
    photosTotal,
    photosHasMore,
    timeline,
    stats,
    loadPhotosPage,
    loadPhotosAtOffset,
    loadPreviousPhotosPage,
    loadTimeline,
    loadStats,
    loadTrashCount,
    currentFilter,
    setCurrentFilter,
    thumbnails,
    setThumbnails,
    aiSearchQuery,
    aiSearchResults,
    aiSearchSimilarities,
    aiSearching,
    setAiSearchQuery,
    setAiSearchResults,
    setAiSearchSimilarities,
    setAiSearching,
    aiSearch,
    browseScrollState,
    setBrowseScrollState,
  } = useAppStore();
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const get = useAppStore.getState;
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTimelineKey, setActiveTimelineKey] = useState<string | null>(null);
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });
  const [searchInput, setSearchInput] = useState('');
  const prevPhotoIdsRef = useRef<string>('');
  const virtuosoRef = useRef<VirtuosoGridHandle>(null);

  // 搜索输入框与 store 中的 aiSearchQuery 保持同步，
  // 避免从其他页面返回时输入框为空但仍在 AI 搜索模式。
  useEffect(() => {
    setSearchInput(aiSearchQuery);
  }, [aiSearchQuery]);
  const mediumUpgradeVersionRef = useRef(0);
  const upgradedIdsRef = useRef<Set<string>>(new Set());
  const scrollRestoreIndexRef = useRef<number | null>(null);
  const isRestoringScrollRef = useRef(false);
  // 标记正在加载缩略图的 photoId，防止多个 effect 实例重复请求同一批
  const thumbnailInFlightRef = useRef<Set<string>>(new Set());
  // 持有 displayPhotos 的最新引用，供 handleRangeChanged 使用，避免依赖 displayPhotos 导致频繁重建
  const displayPhotosRef = useRef<Photo[]>([]);

  const isAiSearchMode = aiSearchQuery.trim().length > 0;
  const displayPhotos = useMemo(() => {
    return isAiSearchMode ? aiSearchResults : photos;
  }, [isAiSearchMode, aiSearchResults, photos]);
  displayPhotosRef.current = displayPhotos;

  // 页面挂载时，如果有保存的滚动状态，先尝试使用现有数据恢复；否则走正常的首次加载
  useEffect(() => {
    // AI 搜索模式不恢复滚动状态（搜索结果是临时列表）
    if (!browseScrollState || isAiSearchMode) {
      loadPhotosPage({});
      loadTimeline({});
      loadStats();
      return;
    }

    // 已经有数据且覆盖了目标索引：直接标记恢复
    if (photos.length > 0) {
      const localIndex = browseScrollState.index - photosOffset;
      if (localIndex >= 0 && localIndex < photos.length) {
        isRestoringScrollRef.current = true;
        return;
      }
    }

    // 没有数据或不在当前窗口：加载目标窗口
    const windowSize = 1500;
    const loadOffset = Math.max(0, browseScrollState.index - 500);
    setLoadingMore(true);
    loadPhotosAtOffset(currentFilter, loadOffset, windowSize).finally(() => {
      setLoadingMore(false);
      isRestoringScrollRef.current = true;
    });
    loadTimeline({});
    loadStats();
  }, []);

  // 当列表数据变化且需要恢复时，执行滚动恢复
  useEffect(() => {
    if (!isRestoringScrollRef.current || !browseScrollState || !virtuosoRef.current) return;

    const localIndex = browseScrollState.index - photosOffset;
    if (localIndex >= 0 && localIndex < photos.length) {
      virtuosoRef.current.scrollToIndex({
        index: localIndex,
        align: browseScrollState.align ?? 'start',
        behavior: 'auto',
      });
      isRestoringScrollRef.current = false;
    }
  }, [photos, photosOffset, browseScrollState]);

  // 页面卸载前保存当前滚动位置
  useEffect(() => {
    return () => {
      if (isAiSearchMode) return;
      // 优先用可视区域起始位置，若起始位置无效则用上一次保存的
      const { startIndex } = visibleRange;
      // 校验索引基于浏览列表（photos）而非 displayPhotos，避免 AI 搜索结果污染
      if (startIndex >= 0 && startIndex < photos.length) {
        const globalIndex = photosOffset + startIndex;
        setBrowseScrollState({ index: globalIndex, align: 'start' });
      }
    };
  }, [isAiSearchMode, photosOffset, visibleRange, photos.length, setBrowseScrollState]);

  // 进入/退出 AI 搜索模式时重置 visibleRange，避免搜索结果的索引污染浏览页滚动位置
  useEffect(() => {
    setVisibleRange({ startIndex: 0, endIndex: 0 });
  }, [isAiSearchMode]);

  useEffect(() => {
    // 计算 displayPhotos ID 摘要，用于检测显示列表是否真正变化
    const photoIds = displayPhotos.map(p => p.id).join(',');
    if (photoIds === prevPhotoIdsRef.current) return;
    prevPhotoIdsRef.current = photoIds;

    // 照片列表更换后，清理 upgradedIdsRef 中已不在当前列表的 ID，
    // 避免新列表中同 ID 照片（缩略图缓存已清除）不会重新触发 medium 升级
    const currentIdSet = new Set(displayPhotos.map(p => p.id));
    for (const id of upgradedIdsRef.current) {
      if (!currentIdSet.has(id)) upgradedIdsRef.current.delete(id);
    }

    // 缩略图加载：分批加载缺失的缩略图。
    // 不使用 version 中断机制——即使 photos 在加载过程中变化，已发出的请求返回后
    // 仍应把缩略图写入 store（photoId 对应的缩略图不会因为列表变化而失效）。
    // 用 inFlightRef 防止多个 effect 实例重复请求同一批 photoId。
    const loadThumbnails = async () => {
      while (true) {
        const currentThumbnails = get().thumbnails;
        const photosToLoad = displayPhotos
          .filter(p => !(p.id in currentThumbnails) && !thumbnailInFlightRef.current.has(p.id))
          .slice(0, 100);
        if (photosToLoad.length === 0) return;

        // 标记这批为 in-flight，防止其他 effect 实例重复请求
        photosToLoad.forEach(p => thumbnailInFlightRef.current.add(p.id));

        const items = photosToLoad.map(p => ({ photoId: p.id, photoPath: p.path, size: 'small' as const }));
        try {
          const batch = await window.api.thumbnail.getBatch(items);
          // 无论 photos 是否变化，都写入 store（缩略图按 photoId 索引，始终有效）
          setThumbnails({ ...get().thumbnails, ...batch });
        } catch {
          // 缩略图加载失败时不设置 fallback，让 PhotoGridItem 显示骨架屏，
          // 避免 file:/// 直接加载原图对 RAW 格式显示破损图标或大图卡顿
        } finally {
          photosToLoad.forEach(p => thumbnailInFlightRef.current.delete(p.id));
        }
      }
    };

    loadThumbnails();
  }, [displayPhotos, get, setThumbnails]);

  // 可视区域缩略图升级为 medium（512px），提升浏览清晰度
  useEffect(() => {
    if (displayPhotos.length === 0) return;

    const timer = setTimeout(() => {
      const currentVersion = ++mediumUpgradeVersionRef.current;
      const { startIndex, endIndex } = visibleRange;
      if (startIndex < 0 || endIndex < startIndex) return;

      const visiblePhotos = displayPhotos.slice(startIndex, endIndex + 1);
      const currentThumbnails = get().thumbnails;
      const photosToUpgrade = visiblePhotos.filter(p => {
        if (upgradedIdsRef.current.has(p.id)) return false;
        const url = currentThumbnails[p.id];
        // 已经是 medium 则跳过
        if (url && url.includes('_medium.webp')) return false;
        return true;
      });

      if (photosToUpgrade.length === 0) return;
      photosToUpgrade.forEach(p => upgradedIdsRef.current.add(p.id));

      const items = photosToUpgrade.map(p => ({
        photoId: p.id,
        photoPath: p.path,
        size: 'medium' as const,
      }));

      window.api.thumbnail.getBatch(items).then(batch => {
        if (currentVersion !== mediumUpgradeVersionRef.current) return;
        setThumbnails({ ...get().thumbnails, ...batch });
      }).catch(() => {
        // 升级失败时保持 small 缩略图，不影响浏览
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [displayPhotos, visibleRange, get, setThumbnails]);

  // 向上加载更早照片后，恢复视口位置，避免 prepending 导致滚动跳动
  useEffect(() => {
    if (scrollRestoreIndexRef.current === null || !virtuosoRef.current) return;
    const localIndex = scrollRestoreIndexRef.current - photosOffset;
    scrollRestoreIndexRef.current = null;
    if (localIndex >= 0 && localIndex < photos.length) {
      virtuosoRef.current.scrollToIndex({ index: localIndex, behavior: 'auto' });
    }
  }, [photos, photosOffset]);

  const navigatePhoto = useCallback((photo: Photo) => {
    setSelectedPhoto(photo);
  }, []);

  const handleSelectPhoto = useCallback((photo: Photo) => {
    setSelectedPhoto(photo);
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !photosHasMore) return;
    setLoadingMore(true);
    try {
      await loadPhotosPage(currentFilter, true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, photosHasMore, loadPhotosPage, currentFilter]);

  const loadPrevious = useCallback(async () => {
    if (loadingMore || photosOffset <= 0) return;
    setLoadingMore(true);
    try {
      const previousOffset = photosOffset;
      await loadPreviousPhotosPage(currentFilter);
      // 加载完成后需要把视口恢复到之前的第一项位置，避免 prepending 导致滚动跳动
      scrollRestoreIndexRef.current = previousOffset;
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, photosOffset, loadPreviousPhotosPage, currentFilter]);

  const handleAtTopChange = useCallback((atTop: boolean) => {
    if (atTop) {
      loadPrevious();
    }
  }, [loadPrevious]);

  const handleFilterChange = (key: string, value: any) => {
    const newFilter = { ...currentFilter, [key]: value };
    setCurrentFilter(newFilter);
    loadPhotosPage(newFilter);
    loadTimeline(newFilter);
    setBrowseScrollState(null);
  };

  const clearAiSearch = useCallback(() => {
    setSearchInput('');
    setAiSearchQuery('');
    setAiSearchResults([]);
    setAiSearchSimilarities({});
    setAiSearching(false);
    // 清空搜索后确保浏览列表已加载，避免从搜索模式切回时空白
    if (photos.length === 0) {
      loadPhotosPage(currentFilter);
      loadTimeline(currentFilter);
      loadStats();
    }
  }, [loadPhotosPage, loadTimeline, loadStats, photos.length, currentFilter, setAiSearchQuery, setAiSearchResults, setAiSearchSimilarities, setAiSearching]);

  const handleUpdatePhoto = (updatedPhoto: Photo) => {
    setSelectedPhoto(updatedPhoto);
    useAppStore.setState({
      photos: useAppStore.getState().photos.map(p =>
        p.id === updatedPhoto.id ? updatedPhoto : p
      ),
    });
  };

  const handlePhotoDeleted = (photo: Photo) => {
    // 后端删除已由 PhotoDetailModal.handleDelete 完成，此处只同步前端状态
    const currentIndex = displayPhotos.findIndex(p => p.id === photo.id);
    const newThumbnails = { ...get().thumbnails };
    delete newThumbnails[photo.id];
    setThumbnails(newThumbnails);

    if (displayPhotos.length > 1 && currentIndex < displayPhotos.length - 1) {
      setSelectedPhoto(displayPhotos[currentIndex + 1]);
    } else if (displayPhotos.length > 1 && currentIndex > 0) {
      setSelectedPhoto(displayPhotos[currentIndex - 1]);
    } else {
      setSelectedPhoto(null);
    }

    // AI 搜索模式下同步更新 aiSearchResults，避免已删除照片仍显示在网格中
    if (isAiSearchMode) {
      const nextSimilarities = { ...aiSearchSimilarities };
      delete nextSimilarities[photo.id];
      useAppStore.setState({
        aiSearchResults: aiSearchResults.filter(p => p.id !== photo.id),
        aiSearchSimilarities: nextSimilarities,
        photosTotal: Math.max(0, photosTotal - 1),
      });
    } else {
      const nextPhotos = photos.filter(p => p.id !== photo.id);
      // M-25: 同步递减 photosOffset，避免后续 loadMore 跳过照片
      const deletedBeforeOrInView = photos.findIndex(p => p.id === photo.id);
      const offsetAdjust = deletedBeforeOrInView >= 0 ? 1 : 0;
      useAppStore.setState({
        photos: nextPhotos,
        photosTotal: Math.max(0, photosTotal - 1),
        photosOffset: Math.max(0, useAppStore.getState().photosOffset - offsetAdjust),
      });
      if (nextPhotos.length === 0) {
        loadPhotosPage(currentFilter);
      }
    }
    loadStats();
  };

  const toggleSelect = useCallback((photoId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(photoId)) {
        next.delete(photoId);
      } else {
        next.add(photoId);
      }
      return next;
    });
  }, []);

  const selectAll = () => {
    setSelectedIds(new Set(displayPhotos.map(p => p.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const handleBatchDelete = async () => {
    const count = selectedIds.size;
    if (count === 0) return;
    if (!await confirm(t('browse.toast.confirmMoveToTrash', { count }), { variant: 'danger', confirmText: t('photoDetail.confirm.moveToTrashBtn') })) {
      return;
    }
    if (!await confirmFirstTrashMove()) {
      return;
    }
    try {
      await window.api.photo.delete(Array.from(selectedIds));
      // 清除已删除照片的缩略图缓存
      const newThumbnails = { ...get().thumbnails };
      for (const id of selectedIds) {
        delete newThumbnails[id];
      }
      setThumbnails(newThumbnails);
      setSelectedIds(new Set());
      setSelectMode(false);
      // AI 搜索模式下同步更新 aiSearchResults，浏览模式更新 photos
      if (isAiSearchMode) {
        const nextSimilarities = { ...aiSearchSimilarities };
        for (const id of selectedIds) {
          delete nextSimilarities[id];
        }
        useAppStore.setState({
          aiSearchResults: aiSearchResults.filter(p => !selectedIds.has(p.id)),
          aiSearchSimilarities: nextSimilarities,
          photosTotal: Math.max(0, photosTotal - count),
        });
      } else {
        const nextPhotos = photos.filter(p => !selectedIds.has(p.id));
        useAppStore.setState({
          photos: nextPhotos,
          photosTotal: Math.max(0, photosTotal - count),
        });
        if (nextPhotos.length === 0) {
          loadPhotosPage(currentFilter);
        }
      }
      loadStats();
      loadTrashCount();
    } catch (error) {
      toast('error', t('browse.toast.moveToTrashFailed') + error);
    }
  };

  const handleBatchUpdateLocation = async (lat: number, lng: number) => {
    const count = selectedIds.size;
    if (count === 0) return;
    try {
      const result = await window.api.photo.updateLocationBatch(Array.from(selectedIds), lat, lng);
      toast('success', t('browse.toast.batchLocationSuccess', { count: result.updated }));
      setSelectedIds(new Set());
      setSelectMode(false);
      setShowMapPicker(false);
      // 刷新相关数据
      loadPhotosPage(currentFilter);
      loadTimeline(currentFilter);
      loadStats();
    } catch (error) {
      toast('error', t('browse.toast.batchLocationFailed') + error);
    }
  };

  // 浏览页快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (selectedPhoto) return; // 详情弹窗打开时由其自身处理快捷键
      if (isTypingTarget(e.target)) return;

      const isMod = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        if (selectMode) {
          e.preventDefault();
          exitSelectMode();
        } else if (isAiSearchMode) {
          e.preventDefault();
          clearAiSearch();
        } else if (showFilters) {
          e.preventDefault();
          setShowFilters(false);
        }
        return;
      }

      if (isMod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setShowFilters(prev => !prev);
        return;
      }

      if (isMod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        if (!selectMode) {
          setSelectMode(true);
        }
        selectAll();
        return;
      }

      if (e.key === 'Delete' && selectMode && selectedIds.size > 0) {
        e.preventDefault();
        handleBatchDelete();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPhoto, selectMode, showFilters, selectedIds.size, handleBatchDelete, isAiSearchMode, clearAiSearch]);

  const getPhotoMonthKey = useCallback((photo: Photo) => {
    if (!photo.taken_at) return 'unknown';
    const date = new Date(photo.taken_at);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${date.getFullYear()}-${month}`;
  }, []);

  const scrollToGroup = useCallback(async (key: string) => {
    setActiveTimelineKey(key);

    // 先查目标月份在当前排序下的 offset，避免一页页盲加载
    const targetOffset = await window.api.photo.getOffsetByMonth(currentFilter, key);
    if (targetOffset === null) {
      return;
    }

    const windowSize = 1500;
    const buffer = 500;
    // 让目标月份落在加载窗口内偏中间的位置，留出向上/向下滚动的空间
    const loadOffset = Math.max(0, targetOffset - buffer);

    // 读取最新 store 状态，避免闭包过期
    const stateBeforeLoad = get();
    const currentPhotosOffset = stateBeforeLoad.photosOffset;
    const currentPhotos = stateBeforeLoad.photos;

    // 如果目标已经在当前加载窗口内，直接滚动；否则直接加载目标窗口
    const inCurrentWindow = targetOffset >= currentPhotosOffset && targetOffset < currentPhotosOffset + currentPhotos.length;
    if (!inCurrentWindow) {
      setLoadingMore(true);
      try {
        await loadPhotosAtOffset(currentFilter, loadOffset, windowSize);
      } finally {
        setLoadingMore(false);
      }
    }

    // await 后重新读取最新状态，避免闭包过期导致索引计算错误
    const stateAfterLoad = get();
    const latestPhotosOffset = inCurrentWindow ? currentPhotosOffset : stateAfterLoad.photosOffset;
    const latestPhotos = inCurrentWindow ? currentPhotos : stateAfterLoad.photos;
    const localIndex = targetOffset - latestPhotosOffset;
    const index = Math.max(0, Math.min(localIndex, latestPhotos.length - 1));
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index, behavior: 'auto' });
    }
  }, [currentFilter, loadPhotosAtOffset, get]);

  const handleRangeChanged = useCallback(({ startIndex, endIndex }: { startIndex: number; endIndex: number }) => {
    setVisibleRange({ startIndex, endIndex });
    // 用可视区域中间位置的照片所属月份作为高亮，比起始位置更贴合用户当前在看的内容
    const centerIndex = Math.floor((startIndex + endIndex) / 2);
    const photo = displayPhotosRef.current[centerIndex];
    if (photo) {
      setActiveTimelineKey(getPhotoMonthKey(photo));
    }
  }, [getPhotoMonthKey]);

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t('browse.pageTitle')}</h1>
            <p className="page-subtitle">
              {isAiSearchMode
                ? t('browse.subtitleAiSearch', { count: aiSearchResults.length.toLocaleString() })
                : t('browse.subtitleAll', { count: photosTotal.toLocaleString() })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    aiSearch(searchInput);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    clearAiSearch();
                  }
                }}
                placeholder={t('browse.searchPlaceholder')}
                className="input w-64 pl-9 pr-8"
              />
              {(searchInput || isAiSearchMode) && (
                <button
                  onClick={clearAiSearch}
                  className="icon-btn absolute right-1 top-1/2 -translate-y-1/2"
                  title={t('browse.clearSearch')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {isAiSearchMode && (
              <button
                onClick={clearAiSearch}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                {t('browse.backToAll')}
              </button>
            )}
            {aiSearching && (
              <Loader2 size={18} className="text-amber-500 animate-spin" />
            )}
            <button
              onClick={() => {
                if (selectMode) {
                  exitSelectMode();
                } else {
                  setSelectMode(true);
                }
              }}
              className={cn(
                selectMode ? 'btn-secondary-active' : 'btn-secondary'
              )}
            >
              <CheckCircle2 size={16} />
              {selectMode ? t('common.cancelSelection') : t('common.multiSelect')}
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={cn(
                showFilters ? 'btn-secondary-active' : 'btn-secondary'
              )}
            >
              <Filter size={16} />
              {t('browse.filter')}
            </button>
          </div>
        </div>

        {showFilters && (
          <div className="card card-section mb-6">
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <MapPin size={14} className="text-zinc-500" />
                <select
                  value={currentFilter.hasLocation === undefined ? '' : currentFilter.hasLocation ? 'true' : 'false'}
                  onChange={(e) => handleFilterChange('hasLocation', e.target.value === '' ? undefined : e.target.value === 'true')}
                  className="input py-1.5"
                >
                  <option value="">{t('browse.filters.all')}</option>
                  <option value="true">{t('browse.filters.withLocation')}</option>
                  <option value="false">{t('browse.filters.noLocation')}</option>
                </select>
              </div>
              {stats?.cameras && stats.cameras.length > 0 && (
                <div className="flex items-center gap-2">
                  <Camera size={14} className="text-zinc-500" />
                  <select
                    value={currentFilter.camera || ''}
                    onChange={(e) => handleFilterChange('camera', e.target.value || undefined)}
                    className="input py-1.5"
                  >
                    <option value="">{t('browse.filters.allCameras')}</option>
                    {stats.cameras.map(({ camera }) => (
                      <option key={camera} value={camera}>{camera}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex items-center gap-2">
                {currentFilter.mediaType === 'video' ? (
                  <Film size={14} className="text-zinc-700" />
                ) : (
                  <Image size={14} className="text-zinc-500" />
                )}
                <select
                  value={currentFilter.mediaType || 'all'}
                  onChange={(e) => handleFilterChange('mediaType', e.target.value === 'all' ? undefined : e.target.value)}
                  className="input py-1.5"
                >
                  <option value="all">{t('browse.filters.all')}</option>
                  <option value="image">{t('browse.filters.image')}</option>
                  <option value="video">{t('browse.filters.video')}</option>
                </select>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {displayPhotos.length === 0 ? (
            <Empty
              icon={isAiSearchMode ? Search : FolderOpen}
              title={isAiSearchMode ? t('browse.empty.aiTitle') : t('browse.empty.browseTitle')}
              description={
                isAiSearchMode
                  ? t('browse.empty.aiDescription')
                  : t('browse.empty.browseDescription')
              }
            />
          ) : (
            <VirtuosoGrid
              ref={virtuosoRef}
              data={displayPhotos}
              endReached={isAiSearchMode ? undefined : loadMore}
              atTopStateChange={isAiSearchMode ? undefined : handleAtTopChange}
              overscan={200}
              rangeChanged={handleRangeChanged}
              components={{
                List: GridList,
                Item: GridItem,
                Footer: () => loadingMore ? (
                  <div className="col-span-full flex items-center justify-center gap-2 py-4 text-sm text-zinc-400">
                    <Loader2 size={18} className="text-amber-500 animate-spin" />
                    {t('browse.loadingMore')}
                  </div>
                ) : null,
              }}
              itemContent={(index, photo) => {
                return (
                  <PhotoGridItem
                    photo={photo}
                    thumbnail={thumbnails[photo.id]}
                    similarity={isAiSearchMode ? aiSearchSimilarities[photo.id] : undefined}
                    isSelected={selectedIds.has(photo.id)}
                    selectMode={selectMode}
                    onSelect={handleSelectPhoto}
                    onToggleSelect={toggleSelect}
                    formatDate={formatDate}
                  />
                );
              }}
            />
          )}
        </div>

        {/* 多选模式浮动操作栏 */}
        {selectMode && (
          <div className="sticky bottom-0 left-0 right-0 bg-zinc-900/95 backdrop-blur-sm border-t border-zinc-800 px-4 py-3 flex items-center justify-between z-20">
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-300">
                {t('browse.selected', { count: selectedIds.size })}
              </span>
              <button
                onClick={selectAll}
                className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
              >
                {t('common.selectAll')}
              </button>
              {selectedIds.size > 0 && (
                <button
                  onClick={clearSelection}
                  className="text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
                >
                  {t('common.deselectAll')}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exitSelectMode}
                className="btn-secondary"
              >
                {t('common.done')}
              </button>
              <button
                onClick={() => setShowMapPicker(true)}
                disabled={selectedIds.size === 0}
                className={cn(
                  'btn',
                  selectedIds.size > 0
                    ? 'btn-secondary-active'
                    : 'btn-secondary cursor-not-allowed'
                )}
              >
                <MapPinned size={16} />
                {t('browse.modifyLocation', { count: selectedIds.size })}
              </button>
              <button
                onClick={handleBatchDelete}
                disabled={selectedIds.size === 0}
                className={cn(
                  'btn',
                  selectedIds.size > 0
                    ? 'btn-danger'
                    : 'btn-secondary cursor-not-allowed'
                )}
              >
                <Trash2 size={16} />
                {t('browse.moveToTrash', { count: selectedIds.size })}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="w-48 border-l border-zinc-800 hidden lg:block flex-shrink-0">
        <div className="sticky top-0 h-screen p-4 overflow-auto">
          <h3 className="info-label mb-3">{t('browse.timeline')}</h3>
          <div className="space-y-1">
          {timeline.map((group) => (
            <button
              key={group.key}
              onClick={() => scrollToGroup(group.key)}
              className={cn(
                'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                activeTimelineKey === group.key
                  ? 'bg-amber-500/10 text-amber-500'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="truncate">{group.label}</span>
                <span className="text-xs text-zinc-500">{group.count}</span>
              </div>
            </button>
          ))}
        </div>
        </div>
      </div>

      <PhotoDetailModal
        photo={selectedPhoto}
        photos={displayPhotos}
        onClose={() => setSelectedPhoto(null)}
        onNavigate={navigatePhoto}
        onUpdate={handleUpdatePhoto}
        onDelete={handlePhotoDeleted}
      />

      <MapPickerModal
        isOpen={showMapPicker}
        onClose={() => setShowMapPicker(false)}
        onConfirm={handleBatchUpdateLocation}
      />
    </div>
  );
}

export default BrowsePage;
