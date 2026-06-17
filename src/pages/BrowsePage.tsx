import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import { Filter, Grid3X3, MapPin, Camera, Trash2, CheckCircle2, Circle, Loader2 } from 'lucide-react';
import { VirtuosoGrid } from 'react-virtuoso';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn } from '@/lib/utils';
import { PhotoDetailModal } from '@/components/PhotoDetailModal';
import type { Photo } from '@/types';

export function BrowsePage() {
  const { 
    photos, 
    photosTotal,
    photosHasMore,
    stats,
    loadPhotosPage,
    loadStats, 
    currentFilter, 
    setCurrentFilter,
    thumbnails,
    setThumbnails,
    setOriginalImages,
  } = useAppStore();
  const get = useAppStore.getState;
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const loadVersionRef = useRef(0);
  const prevPhotoIdsRef = useRef<string>('');

  useEffect(() => {
    loadPhotosPage({});
    loadStats();
  }, [loadPhotosPage, loadStats]);

  useEffect(() => {
    // 计算 photos ID 摘要，用于检测 photos 是否真正变化
    const photoIds = photos.map(p => p.id).join(',');
    if (photoIds === prevPhotoIdsRef.current) return;
    prevPhotoIdsRef.current = photoIds;

    const currentVersion = ++loadVersionRef.current;

    const loadThumbnails = async () => {
      // 从 store 获取最新 thumbnails，而非闭包中的旧值
      const currentThumbnails = get().thumbnails;
      const photosToLoad = photos.filter(p => !(p.id in currentThumbnails)).slice(0, 100);
      if (photosToLoad.length === 0) return;

      const CONCURRENT = 3;
      const queue = [...photosToLoad];
      const activeTasks: Promise<void>[] = [];

      const processOne = async (): Promise<void> => {
        const photo = queue.shift();
        if (!photo) return;
        if (loadVersionRef.current !== currentVersion) return;

        try {
          const thumb = await window.api.thumbnail.get(photo.id, photo.path);
          if (loadVersionRef.current !== currentVersion) return;
          setThumbnails({ ...get().thumbnails, [photo.id]: thumb });
          setOriginalImages({ ...get().originalImages, [photo.id]: `file:///${photo.path.replace(/\\/g, '/')}` });
        } catch {
          if (loadVersionRef.current !== currentVersion) return;
          setThumbnails({ ...get().thumbnails, [photo.id]: `https://picsum.photos/seed/${photo.image_seed || photo.id}/400/400` });
          setOriginalImages({ ...get().originalImages, [photo.id]: `https://picsum.photos/seed/${photo.image_seed || photo.id}/1200/800` });
        }

        await processOne();
      };

      for (let i = 0; i < Math.min(CONCURRENT, queue.length); i++) {
        activeTasks.push(processOne());
      }

      await Promise.all(activeTasks);
    };

    loadThumbnails();
  }, [photos]);

  const navigatePhoto = useCallback((photo: Photo) => {
    setSelectedPhoto(photo);
  }, []);

  const handleSelectPhoto = (photo: Photo) => {
    setSelectedPhoto(photo);
  };

  const loadMore = useCallback(async () => {
    if (loadingMore || !photosHasMore) return;
    setLoadingMore(true);
    try {
      await loadPhotosPage(currentFilter, true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, photosHasMore, loadPhotosPage, currentFilter]);

  const handleFilterChange = (key: string, value: any) => {
    const newFilter = { ...currentFilter, [key]: value };
    setCurrentFilter(newFilter);
    loadPhotosPage(newFilter);
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
      const newOriginalImages = { ...get().originalImages };
      delete newOriginalImages[photo.id];
      setOriginalImages(newOriginalImages);

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

  const toggleSelect = (photoId: string, e?: React.MouseEvent) => {
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
  };

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
      const newOriginalImages = { ...get().originalImages };
      for (const id of selectedIds) {
        delete newThumbnails[id];
        delete newOriginalImages[id];
      }
      setThumbnails(newThumbnails);
      setOriginalImages(newOriginalImages);
      setSelectedIds(new Set());
      setSelectMode(false);
      loadPhotosPage(currentFilter);
      loadStats();
    } catch (error) {
      toast('error', '删除失败：' + error);
    }
  };

  const groupedPhotos = useMemo(() => {
    const groups: { key: string; label: string; photos: Photo[] }[] = [];
    const groupMap = new Map<string, Photo[]>();

    for (const photo of photos) {
      let key: string;
      let label: string;

      if (photo.taken_at) {
        const date = new Date(photo.taken_at);
        const year = date.getFullYear();
        const month = date.getMonth();
        key = `${year}-${month}`;
        label = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' });
      } else {
        key = 'unknown';
        label = '未知时间';
      }

      if (!groupMap.has(key)) {
        groupMap.set(key, []);
        groups.push({ key, label, photos: [] });
      }
      groupMap.get(key)!.push(photo);
    }

    for (const group of groups) {
      group.photos = groupMap.get(group.key) || [];
    }

    return groups;
  }, [photos]);

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
              data={photos}
              endReached={loadMore}
              overscan={200}
              components={{
                List: React.forwardRef(({ style, children, ...props }: any, ref) => (
                  <div
                    ref={ref}
                    style={style}
                    {...props}
                    className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-1 p-1"
                  >
                    {children}
                  </div>
                )),
                Item: ({ children }) => <div>{children}</div>,
                Footer: () => loadingMore ? (
                  <div className="col-span-full flex justify-center py-4">
                    <Loader2 className="w-6 h-6 text-amber-500 animate-spin" />
                  </div>
                ) : null,
              }}
              itemContent={(index, photo) => {
                const isSelected = selectedIds.has(photo.id);
                return (
                  <div
                    onClick={() => {
                      if (selectMode) {
                        toggleSelect(photo.id);
                      } else {
                        handleSelectPhoto(photo);
                      }
                    }}
                    className={cn(
                      'aspect-square cursor-pointer group relative overflow-hidden rounded-lg bg-zinc-800',
                      selectMode && isSelected && 'ring-2 ring-amber-500 ring-offset-1 ring-offset-zinc-950'
                    )}
                  >
                    {thumbnails[photo.id] ? (
                      <img
                        src={thumbnails[photo.id]}
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
          {groupedPhotos.map((group, index) => (
            <button
              key={group.key}
              className={cn(
                'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                index === 0
                  ? 'bg-amber-500/10 text-amber-500'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="truncate">{group.label}</span>
                <span className="text-xs text-zinc-600">{group.photos.length}</span>
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
