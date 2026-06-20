import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import { Filter, Grid3X3, MapPin, Camera, Trash2, CheckCircle2, Circle, Loader2, Play } from 'lucide-react';
import { VirtuosoGrid, type VirtuosoGridHandle } from 'react-virtuoso';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn } from '@/lib/utils';
import { PhotoDetailModal } from '@/components/PhotoDetailModal';
import type { Photo } from '@/types';

interface PhotoGridItemProps {
  photo: Photo;
  thumbnail?: string;
  isSelected: boolean;
  selectMode: boolean;
  onSelect: (photo: Photo) => void;
  onToggleSelect: (photoId: string, e?: React.MouseEvent) => void;
  formatDate: (date: string | null) => string;
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
  isSelected,
  selectMode,
  onSelect,
  onToggleSelect,
  formatDate,
}: PhotoGridItemProps) {
  const isVideo = photo.media_type === 'video';

  const handleClick = () => {
    if (selectMode) {
      onToggleSelect(photo.id);
    } else if (isVideo) {
      window.api.app.openPath(photo.path).catch(() => {
        // 打开失败时静默处理，避免弹窗打断浏览
      });
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
        <div className="w-full h-full bg-zinc-800 animate-pulse flex items-center justify-center">
          <div className="w-8 h-8 rounded bg-zinc-700/50" />
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
            <div className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white font-medium pointer-events-none">
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
            <p className="text-xs text-zinc-400">{formatDate(photo.taken_at)}</p>
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
    currentFilter, 
    setCurrentFilter,
    thumbnails,
    setThumbnails,
  } = useAppStore();
  const get = useAppStore.getState;
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTimelineKey, setActiveTimelineKey] = useState<string | null>(null);
  const [visibleRange, setVisibleRange] = useState({ startIndex: 0, endIndex: 0 });
  const loadVersionRef = useRef(0);
  const prevPhotoIdsRef = useRef<string>('');
  const virtuosoRef = useRef<VirtuosoGridHandle>(null);
  const mediumUpgradeVersionRef = useRef(0);
  const upgradedIdsRef = useRef<Set<string>>(new Set());
  const scrollRestoreIndexRef = useRef<number | null>(null);

  useEffect(() => {
    loadPhotosPage({});
    loadTimeline({});
    loadStats();
  }, [loadPhotosPage, loadTimeline, loadStats]);

  useEffect(() => {
    // 计算 photos ID 摘要，用于检测 photos 是否真正变化
    const photoIds = photos.map(p => p.id).join(',');
    if (photoIds === prevPhotoIdsRef.current) return;
    prevPhotoIdsRef.current = photoIds;

    const currentVersion = ++loadVersionRef.current;

    const loadThumbnails = async () => {
      // 分批加载当前照片列表中所有缺失的缩略图，避免时间线跳转后只加载前 100 张
      while (true) {
        // 从 store 获取最新 thumbnails，而非闭包中的旧值
        const currentThumbnails = get().thumbnails;
        const photosToLoad = photos.filter(p => !(p.id in currentThumbnails)).slice(0, 100);
        if (photosToLoad.length === 0) return;

        const items = photosToLoad.map(p => ({ photoId: p.id, photoPath: p.path, size: 'small' as const }));
        try {
          const batch = await window.api.thumbnail.getBatch(items);
          if (loadVersionRef.current !== currentVersion) return;
          setThumbnails({ ...get().thumbnails, ...batch });
        } catch {
          if (loadVersionRef.current !== currentVersion) return;
          const fallback: Record<string, string> = {};
          for (const photo of photosToLoad) {
            fallback[photo.id] = `file:///${photo.path.replace(/\\/g, '/')}`;
          }
          setThumbnails({ ...get().thumbnails, ...fallback });
        }
      }
    };

    loadThumbnails();
  }, [photos, get, setThumbnails]);

  // 可视区域缩略图升级为 medium（512px），提升浏览清晰度
  useEffect(() => {
    if (photos.length === 0) return;

    const timer = setTimeout(() => {
      const currentVersion = ++mediumUpgradeVersionRef.current;
      const { startIndex, endIndex } = visibleRange;
      if (startIndex < 0 || endIndex < startIndex) return;

      const visiblePhotos = photos.slice(startIndex, endIndex + 1);
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
  }, [photos, visibleRange, get, setThumbnails]);

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
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '未知日期';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const handleUpdatePhoto = (updatedPhoto: Photo) => {
    setSelectedPhoto(updatedPhoto);
    useAppStore.setState({
      photos: useAppStore.getState().photos.map(p =>
        p.id === updatedPhoto.id ? updatedPhoto : p
      ),
    });
  };

  const handleDeletePhoto = async (photo: Photo) => {
    try {
      const currentIndex = photos.findIndex(p => p.id === photo.id);
      const newThumbnails = { ...get().thumbnails };
      delete newThumbnails[photo.id];
      setThumbnails(newThumbnails);

      if (photos.length > 1 && currentIndex < photos.length - 1) {
        setSelectedPhoto(photos[currentIndex + 1]);
      } else if (photos.length > 1 && currentIndex > 0) {
        setSelectedPhoto(photos[currentIndex - 1]);
      } else {
        setSelectedPhoto(null);
      }

      loadPhotosPage(currentFilter);
      loadStats();
    } catch (error) {
      toast('error', '删除失败：' + error);
    }
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
    setSelectedIds(new Set(photos.map(p => p.id)));
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
    if (!await confirm(`确定要删除选中的 ${count} 张照片吗？\n\n照片将移到系统回收站，可从回收站恢复。`, { variant: 'danger', confirmText: '删除' })) {
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
      loadPhotosPage(currentFilter);
      loadStats();
    } catch (error) {
      toast('error', '删除失败：' + error);
    }
  };

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

    // 如果目标已经在当前加载窗口内，直接滚动；否则直接加载目标窗口
    const inCurrentWindow = targetOffset >= photosOffset && targetOffset < photosOffset + photos.length;
    if (!inCurrentWindow) {
      setLoadingMore(true);
      try {
        await loadPhotosAtOffset(currentFilter, loadOffset, windowSize);
      } finally {
        setLoadingMore(false);
      }
    }

    const localIndex = targetOffset - (inCurrentWindow ? photosOffset : loadOffset);
    const index = Math.max(0, Math.min(localIndex, photos.length - 1));
    if (virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index, behavior: 'auto' });
    }
  }, [photos, photosOffset, photosHasMore, currentFilter, loadPhotosPage, loadPhotosAtOffset, getPhotoMonthKey]);

  const handleRangeChanged = useCallback(({ startIndex, endIndex }: { startIndex: number; endIndex: number }) => {
    setVisibleRange({ startIndex, endIndex });
    // 用可视区域中间位置的照片所属月份作为高亮，比起始位置更贴合用户当前在看的内容
    const centerIndex = Math.floor((startIndex + endIndex) / 2);
    const photo = photos[centerIndex];
    if (photo) {
      setActiveTimelineKey(getPhotoMonthKey(photo));
    }
  }, [photos, getPhotoMonthKey]);

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-zinc-100 mb-1">浏览照片</h1>
            <p className="text-sm text-zinc-400">
              共 {photosTotal.toLocaleString()} 张照片
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                if (selectMode) {
                  exitSelectMode();
                } else {
                  setSelectMode(true);
                }
              }}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg transition-colors',
                selectMode ? 'bg-amber-500/10 text-amber-500' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              )}
            >
              <CheckCircle2 size={16} />
              {selectMode ? '取消选择' : '多选'}
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg transition-colors',
                showFilters ? 'bg-amber-500/10 text-amber-500' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
              )}
            >
              <Filter size={16} />
              筛选
            </button>
          </div>
        </div>

        {showFilters && (
          <div className="mb-6 p-4 bg-zinc-900 rounded-xl border border-zinc-800">
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <MapPin size={14} className="text-zinc-500" />
                <select
                  value={currentFilter.hasLocation === undefined ? '' : currentFilter.hasLocation ? 'true' : 'false'}
                  onChange={(e) => handleFilterChange('hasLocation', e.target.value === '' ? undefined : e.target.value === 'true')}
                  className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300"
                >
                  <option value="">全部</option>
                  <option value="true">有位置</option>
                  <option value="false">无位置</option>
                </select>
              </div>
              {stats?.cameras && stats.cameras.length > 0 && (
                <div className="flex items-center gap-2">
                  <Camera size={14} className="text-zinc-500" />
                  <select
                    value={currentFilter.camera || ''}
                    onChange={(e) => handleFilterChange('camera', e.target.value || undefined)}
                    className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-300"
                  >
                    <option value="">全部相机</option>
                    {stats.cameras.map(({ camera }) => (
                      <option key={camera} value={camera}>{camera}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {photos.length === 0 ? (
            <div className="text-center py-16 text-zinc-500">
              <Grid3X3 size={48} className="mx-auto mb-4 opacity-50" />
              <p>没有找到照片</p>
              <p className="text-sm mt-1">请先在照片库中添加并扫描文件夹</p>
            </div>
          ) : (
            <VirtuosoGrid
              ref={virtuosoRef}
              data={photos}
              endReached={loadMore}
              atTopStateChange={handleAtTopChange}
              overscan={200}
              rangeChanged={handleRangeChanged}
              components={{
                List: GridList,
                Item: GridItem,
                Footer: () => loadingMore ? (
                  <div className="col-span-full flex justify-center py-4">
                    <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
                  </div>
                ) : null,
              }}
              itemContent={(index, photo) => {
                return (
                  <PhotoGridItem
                    photo={photo}
                    thumbnail={thumbnails[photo.id]}
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
                已选择 <span className="text-amber-500 font-medium">{selectedIds.size}</span> 张
              </span>
              <button
                onClick={selectAll}
                className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
              >
                全选
              </button>
              {selectedIds.size > 0 && (
                <button
                  onClick={clearSelection}
                  className="text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
                >
                  取消选择
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={exitSelectMode}
                className="px-4 py-2 rounded-lg text-sm bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                完成
              </button>
              <button
                onClick={handleBatchDelete}
                disabled={selectedIds.size === 0}
                className={cn(
                  'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                  selectedIds.size > 0
                    ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20'
                    : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                )}
              >
                <Trash2 size={16} />
                删除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="w-48 border-l border-zinc-800 hidden lg:block flex-shrink-0">
        <div className="sticky top-0 h-screen p-4 overflow-auto">
          <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">时间线</h3>
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
                <span className="text-xs text-zinc-600">{group.count}</span>
              </div>
            </button>
          ))}
        </div>
        </div>
      </div>

      <PhotoDetailModal
        photo={selectedPhoto}
        photos={photos}
        onClose={() => setSelectedPhoto(null)}
        onNavigate={navigatePhoto}
        onUpdate={handleUpdatePhoto}
        onDelete={handleDeletePhoto}
      />
    </div>
  );
}
