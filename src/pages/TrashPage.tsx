import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash2, RotateCcw, AlertTriangle, Loader2, CheckCircle2, Circle, FolderOpen, ImageOff } from 'lucide-react';
import Empty from '@/components/Empty';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn } from '@/lib/utils';
import type { Photo } from '@/types';

interface PhotoGridItemProps {
  photo: Photo;
  thumbnail?: string;
  isSelected: boolean;
  selectMode: boolean;
  onToggleSelect: (photoId: string, e?: React.MouseEvent) => void;
  formatDate: (date: string | null) => string;
}

const PhotoGridItem = function PhotoGridItem({
  photo,
  thumbnail,
  isSelected,
  selectMode,
  onToggleSelect,
  formatDate,
}: PhotoGridItemProps) {
  const [imageError, setImageError] = useState(false);
  const hasThumbnail = thumbnail && !imageError;

  return (
    <div
      onClick={() => selectMode && onToggleSelect(photo.id)}
      className={cn(
        'aspect-square cursor-pointer group relative overflow-hidden rounded-lg bg-zinc-800',
        selectMode && isSelected && 'ring-2 ring-amber-500 ring-offset-1 ring-offset-zinc-950'
      )}
    >
      {hasThumbnail ? (
        <img
          src={thumbnail}
          alt={photo.filename}
          className={cn(
            'w-full h-full object-cover transition-transform duration-200',
            !selectMode && 'group-hover:scale-105',
            selectMode && isSelected && 'opacity-80'
          )}
          loading="lazy"
          onError={() => setImageError(true)}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-zinc-800 text-zinc-500">
          <ImageOff size={24} className="mb-2 opacity-60" />
          <span className="text-xs text-center px-2 truncate w-full">{photo.filename}</span>
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
            <p className="text-xs text-zinc-200">{formatDate(photo.taken_at)}</p>
          </div>
        </div>
      )}
    </div>
  );
};

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function TrashPage() {
  const { loadTrashStats, trashCount, trashTotalSize } = useAppStore();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEmptying, setIsEmptying] = useState(false);
  const thumbnailInFlightRef = useRef<Set<string>>(new Set());
  const photosRef = useRef<Photo[]>(photos);
  const thumbnailsRef = useRef<Record<string, string>>(thumbnails);
  photosRef.current = photos;
  thumbnailsRef.current = thumbnails;

  const loadPhotos = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await window.api.trash.list();
      setPhotos(list as Photo[]);
    } catch (error) {
      toast('error', '加载回收站失败：' + error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPhotos();
    loadTrashStats();
  }, [loadPhotos, loadTrashStats]);

  useEffect(() => {
    const cancelledRef = { current: false };
    const loadThumbnails = async () => {
      while (!cancelledRef.current) {
        const currentPhotos = photosRef.current;
        const currentThumbnails = thumbnailsRef.current;
        const photosToLoad = currentPhotos
          .filter(p => !(p.id in currentThumbnails) && !thumbnailInFlightRef.current.has(p.id))
          .slice(0, 100);
        if (photosToLoad.length === 0) return;
        photosToLoad.forEach(p => thumbnailInFlightRef.current.add(p.id));
        const items = photosToLoad.map(p => ({ photoId: p.id, photoPath: p.trash_path || p.path, size: 'small' as const }));
        try {
          const batch = await window.api.thumbnail.getBatch(items);
          if (!cancelledRef.current) {
            setThumbnails(prev => ({ ...prev, ...batch }));
          }
        } catch (e) {
          if (!cancelledRef.current) {
            console.warn('[Trash] 缩略图加载失败:', e);
          }
        } finally {
          photosToLoad.forEach(p => thumbnailInFlightRef.current.delete(p.id));
        }
      }
    };
    if (photos.length > 0) {
      loadThumbnails();
    }
    return () => { cancelledRef.current = true; };
  }, [photos, thumbnails]);

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

  const selectAll = () => setSelectedIds(new Set(photos.map(p => p.id)));
  const clearSelection = () => setSelectedIds(new Set());
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const handleRestore = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setIsRestoring(true);
    try {
      const results = await window.api.trash.restore(ids);
      const successIds = results.filter(r => r.success).map(r => r.id);
      const failed = results.filter(r => !r.success);
      if (successIds.length > 0) {
        setPhotos(prev => prev.filter(p => !successIds.includes(p.id)));
        setSelectedIds(prev => {
          const next = new Set(prev);
          for (const id of successIds) next.delete(id);
          return next;
        });
        toast('success', `已还原 ${successIds.length} 张照片`);
      }
      if (failed.length > 0) {
        toast('error', `${failed.length} 张照片还原失败：${failed[0].error}`);
      }
      await loadTrashStats();
    } catch (error) {
      toast('error', '还原失败：' + error);
    } finally {
      setIsRestoring(false);
    }
  };

  const handlePermanentDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!await confirm(`确定要永久删除选中的 ${ids.length} 张照片吗？\n\n删除后将移动到系统回收站，可在系统回收站中还原。`, { variant: 'danger', confirmText: '永久删除' })) {
      return;
    }
    setIsDeleting(true);
    try {
      const results = await window.api.trash.permanentDelete(ids);
      const successIds = results.filter(r => r.success).map(r => r.id);
      const failed = results.filter(r => !r.success);
      if (successIds.length > 0) {
        setPhotos(prev => prev.filter(p => !successIds.includes(p.id)));
        setSelectedIds(prev => {
          const next = new Set(prev);
          for (const id of successIds) next.delete(id);
          return next;
        });
        toast('success', `已删除 ${successIds.length} 张照片`);
      }
      if (failed.length > 0) {
        toast('error', `${failed.length} 张照片删除失败：${failed[0].error}`);
      }
      await loadTrashStats();
    } catch (error) {
      toast('error', '删除失败：' + error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleEmptyTrash = async () => {
    if (!await confirm('确定要清空回收站吗？\n\n所有照片将被移动到系统回收站，可在系统回收站中还原。', { variant: 'danger', confirmText: '清空回收站' })) {
      return;
    }
    setIsEmptying(true);
    try {
      const results = await window.api.trash.empty();
      const successCount = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success);
      setPhotos([]);
      setSelectedIds(new Set());
      toast('success', `已清空回收站，${successCount} 张照片已移动到系统回收站`);
      if (failed.length > 0) {
        toast('error', `${failed.length} 张照片处理失败`);
      }
      await loadTrashStats();
    } catch (error) {
      toast('error', '清空回收站失败：' + error);
    } finally {
      setIsEmptying(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '未知日期';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="page-header">
        <div>
          <h1 className="page-title">回收站</h1>
          <p className="page-subtitle">
            共 {trashCount.toLocaleString()} 张照片，占用 {formatBytes(trashTotalSize)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {photos.length > 0 && (
            <button
              onClick={handleEmptyTrash}
              disabled={isEmptying}
              className="btn-danger"
            >
              {isEmptying ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Trash2 size={16} />
              )}
              {isEmptying ? '清空中...' : '清空回收站'}
            </button>
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
            {selectMode ? '取消选择' : '多选'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-zinc-400">
            <Loader2 size={32} className="animate-spin text-amber-500" />
          </div>
        ) : photos.length === 0 ? (
          <Empty
            icon={FolderOpen}
            title="回收站是空的"
            description="删除的照片会暂时放在这里，清空后才会进入系统回收站。"
          />
        ) : (
          <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-1 p-1">
            {photos.map(photo => (
              <PhotoGridItem
                key={photo.id}
                photo={photo}
                thumbnail={thumbnails[photo.id]}
                isSelected={selectedIds.has(photo.id)}
                selectMode={selectMode}
                onToggleSelect={toggleSelect}
                formatDate={formatDate}
              />
            ))}
          </div>
        )}
      </div>

      {selectMode && photos.length > 0 && (
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
              className="btn-secondary"
            >
              完成
            </button>
            <button
              onClick={handleRestore}
              disabled={selectedIds.size === 0 || isRestoring}
              className={cn(
                'btn',
                selectedIds.size > 0
                  ? 'btn-secondary-active'
                  : 'btn-secondary cursor-not-allowed'
              )}
            >
              {isRestoring ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <RotateCcw size={16} />
              )}
              还原{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
            </button>
            <button
              onClick={handlePermanentDelete}
              disabled={selectedIds.size === 0 || isDeleting}
              className={cn(
                'btn',
                selectedIds.size > 0
                  ? 'btn-danger'
                  : 'btn-secondary cursor-not-allowed'
              )}
            >
              {isDeleting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <AlertTriangle size={16} />
              )}
              彻底删除{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default TrashPage;
