import { useState, useEffect } from 'react';
import { AlertTriangle, Check, Trash2, Star, MapPin, Calendar, HardDrive, X, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn } from '@/lib/utils';
import type { DuplicateGroup, Photo } from '@/types';

export function DuplicatesPage() {
  const { duplicates, loadDuplicates, stats } = useAppStore();
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [originalImages, setOriginalImages] = useState<Record<string, string>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [currentGroup, setCurrentGroup] = useState<DuplicateGroup | null>(null);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  useEffect(() => {
    const loadThumbnails = async () => {
      const thumbMap: Record<string, string> = {};
      const origMap: Record<string, string> = {};
      const allPhotos = duplicates.flatMap(g => g.photos);
      for (const photo of allPhotos) {
        try {
          const thumb = await window.api.thumbnail.get(photo.id, photo.path);
          thumbMap[photo.id] = thumb;
          origMap[photo.id] = `file:///${photo.path.replace(/\\/g, '/')}`;
        } catch {
          thumbMap[photo.id] = `https://picsum.photos/seed/${photo.id}/256/256`;
          origMap[photo.id] = `https://picsum.photos/seed/${photo.id}/800/600`;
        }
      }
      setThumbnails(thumbMap);
      setOriginalImages(origMap);
    };
    if (duplicates.length > 0) {
      loadThumbnails();
    }
  }, [duplicates]);

  const handleRedetect = async () => {
    if (!await confirm('将重新检测所有照片的重复情况，这可能需要一些时间。确定继续吗？', { variant: 'info', confirmText: '开始检测' })) {
      return;
    }
    setIsDetecting(true);
    try {
      await window.api.duplicate.detect(true);
      await loadDuplicates();
      toast('success', '重复检测完成');
    } catch (error) {
      toast('error', '检测失败：' + error);
    } finally {
      setIsDetecting(false);
    }
  };

  const toggleGroup = (groupId: string) => {
    const newSelected = new Set(selectedGroups);
    if (newSelected.has(groupId)) {
      newSelected.delete(groupId);
    } else {
      newSelected.add(groupId);
    }
    setSelectedGroups(newSelected);
  };

  const selectAll = () => {
    setSelectedGroups(new Set(duplicates.map(g => g.id)));
  };

  const deselectAll = () => {
    setSelectedGroups(new Set());
  };

  const handleDeleteDuplicates = async () => {
    const toDelete: string[] = [];
    for (const group of duplicates) {
      if (selectedGroups.has(group.id)) {
        for (const photo of group.photos) {
          if (photo.id !== group.recommended_photo_id) {
            toDelete.push(photo.id);
          }
        }
      }
    }

    if (toDelete.length === 0) {
      toast('warning', '请先选择要处理的重复组');
      return;
    }

    if (!await confirm(`确定要删除 ${toDelete.length} 张重复照片吗？\n文件将被移动到回收站。`, { variant: 'danger', confirmText: '删除' })) {
      return;
    }

    setIsDeleting(true);
    try {
      await window.api.duplicate.delete(toDelete);
      await loadDuplicates();
      setSelectedGroups(new Set());
    } finally {
      setIsDeleting(false);
    }
  };

  const handlePhotoClick = (photo: Photo, group: DuplicateGroup, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedPhoto(photo);
    setCurrentGroup(group);
  };

  const navigatePhoto = (direction: number) => {
    if (!selectedPhoto || !currentGroup) return;
    const currentIndex = currentGroup.photos.findIndex(p => p.id === selectedPhoto.id);
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < currentGroup.photos.length) {
      setSelectedPhoto(currentGroup.photos[newIndex]);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '未知';
    return new Date(dateStr).toLocaleDateString('zh-CN');
  };

  const formatFileSize = (bytes: number) => {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-1">重复照片</h1>
          <p className="text-sm text-zinc-400">
            发现 {duplicates.length} 组重复，共 {stats?.duplicates || 0} 张重复照片
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRedetect}
            disabled={isDetecting}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors',
              'bg-zinc-800 hover:bg-zinc-700 text-zinc-300',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <RefreshCw size={16} className={isDetecting ? 'animate-spin' : ''} />
            {isDetecting ? '检测中...' : '重新检测'}
          </button>
          <button
            onClick={selectAll}
            className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
          >
            全选
          </button>
          <button
            onClick={deselectAll}
            className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm transition-colors"
          >
            取消全选
          </button>
          <button
            onClick={handleDeleteDuplicates}
            disabled={isDeleting || selectedGroups.size === 0}
            className={cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors',
              'bg-red-500 hover:bg-red-400 text-white',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <Trash2 size={16} />
            删除重复 ({selectedGroups.size})
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {duplicates.length === 0 ? (
          <div className="text-center py-16 text-zinc-500">
            <Check size={48} className="mx-auto mb-4 text-green-500 opacity-50" />
            <p>没有发现重复照片</p>
            <p className="text-sm mt-1">你的照片库很干净！</p>
          </div>
        ) : (
          <div className="space-y-4">
            {duplicates.map((group) => (
              <DuplicateCard
                key={group.id}
                group={group}
                isSelected={selectedGroups.has(group.id)}
                onToggle={() => toggleGroup(group.id)}
                thumbnails={thumbnails}
                formatDate={formatDate}
                formatFileSize={formatFileSize}
                onPhotoClick={handlePhotoClick}
              />
            ))}
          </div>
        )}
      </div>

      {selectedPhoto && currentGroup && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center">
          <button
            onClick={() => { setSelectedPhoto(null); setCurrentGroup(null); }}
            className="absolute top-4 right-4 p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors z-10"
          >
            <X size={20} />
          </button>
          
          <button
            onClick={() => navigatePhoto(-1)}
            className="absolute left-4 p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            <ChevronLeft size={24} />
          </button>
          
          <button
            onClick={() => navigatePhoto(1)}
            className="absolute right-4 p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            <ChevronRight size={24} />
          </button>

          <div className="flex h-full w-full">
            <div className="flex-1 flex items-center justify-center p-4">
              <img
                src={originalImages[selectedPhoto.id] || `file:///${selectedPhoto.path.replace(/\\/g, '/')}`}
                alt={selectedPhoto.filename}
                className="max-w-full max-h-full object-contain"
              />
            </div>
            
            <div className="w-64 bg-zinc-900/95 border-l border-zinc-800 p-4 overflow-auto">
              <h3 className="text-base font-medium text-zinc-100 mb-3 truncate">{selectedPhoto.filename}</h3>
              
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-500 uppercase tracking-wider">文件路径</label>
                  <div className="mt-1.5 p-2 bg-zinc-800 rounded text-xs text-zinc-300 break-all">
                    {selectedPhoto.path}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-500 uppercase tracking-wider">文件信息</label>
                  <div className="mt-1.5 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-400">大小</span>
                      <span className="text-zinc-200">{formatFileSize(selectedPhoto.file_size)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-400">分辨率</span>
                      <span className="text-zinc-200">{selectedPhoto.width} × {selectedPhoto.height}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-500 uppercase tracking-wider">拍摄信息</label>
                  <div className="mt-1.5 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-400">日期</span>
                      <span className={cn(
                        selectedPhoto.taken_at ? 'text-zinc-200' : 'text-zinc-500 italic'
                      )}>
                        {formatDate(selectedPhoto.taken_at)}
                      </span>
                    </div>
                    {selectedPhoto.camera && (
                      <div className="flex justify-between">
                        <span className="text-zinc-400">相机</span>
                        <span className="text-zinc-200">{selectedPhoto.camera}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-500 uppercase tracking-wider">位置</label>
                  <div className="mt-1.5">
                    {selectedPhoto.latitude && selectedPhoto.longitude ? (
                      <div className="flex items-center gap-2 text-sm text-zinc-200">
                        <MapPin size={14} className="text-green-500" />
                        <span>
                          {selectedPhoto.latitude.toFixed(4)}, {selectedPhoto.longitude.toFixed(4)}
                        </span>
                      </div>
                    ) : (
                      <div className="p-2 bg-zinc-800 rounded text-center">
                        <p className="text-xs text-zinc-500">此照片没有GPS信息</p>
                      </div>
                    )}
                  </div>
                </div>

                {selectedPhoto.id === currentGroup.recommended_photo_id && (
                  <div className="p-2 bg-amber-500/10 rounded-lg border border-amber-500/30">
                    <div className="flex items-center gap-2 text-amber-500 text-sm">
                      <Star size={14} />
                      <span>推荐保留</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface DuplicateCardProps {
  group: DuplicateGroup;
  isSelected: boolean;
  onToggle: () => void;
  thumbnails: Record<string, string>;
  formatDate: (date: string | null) => string;
  formatFileSize: (bytes: number) => string;
  onPhotoClick: (photo: Photo, group: DuplicateGroup, e: React.MouseEvent) => void;
}

function DuplicateCard({ group, isSelected, onToggle, thumbnails, formatDate, formatFileSize, onPhotoClick }: DuplicateCardProps) {
  return (
    <div
      className={cn(
        'p-4 rounded-xl border transition-colors cursor-pointer',
        isSelected
          ? 'bg-amber-500/5 border-amber-500/50'
          : 'bg-zinc-900 border-zinc-800 hover:border-zinc-700'
      )}
      onClick={onToggle}
    >
      <div className="flex items-center gap-2 mb-3">
        <div
          className={cn(
            'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors',
            isSelected
              ? 'bg-amber-500 border-amber-500'
              : 'border-zinc-600'
          )}
        >
          {isSelected && <Check size={12} className="text-zinc-900" />}
        </div>
        <span className="text-sm text-zinc-400">
          {group.reason === 'exact' ? '完全相同' : '相似'} · {group.photos.length} 张
        </span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {group.photos.map((photo) => {
          const isRecommended = photo.id === group.recommended_photo_id;
          return (
            <div
              key={photo.id}
              className={cn(
                'flex-shrink-0 w-40 rounded-lg overflow-hidden border-2 transition-colors',
                isRecommended ? 'border-amber-500' : 'border-transparent'
              )}
            >
              <div 
                className="aspect-square relative cursor-pointer hover:opacity-80 transition-opacity group"
                onClick={(e) => onPhotoClick(photo, group, e)}
              >
                <img
                  src={thumbnails[photo.id] || `https://picsum.photos/seed/${photo.image_seed || photo.id}/256/256`}
                  alt={photo.filename}
                  className="w-full h-full object-cover"
                />
                {isRecommended && (
                  <div className="absolute top-2 left-2 p-1 bg-amber-500 rounded-full">
                    <Star size={12} className="text-zinc-900" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-2">
                  <p className="text-xs text-zinc-200 text-center break-all">{photo.path}</p>
                </div>
              </div>
              <div className="p-2 bg-zinc-800">
                <p className="text-xs text-zinc-300 truncate" title={photo.path}>{photo.filename}</p>
                <p className="text-xs text-zinc-500 truncate mt-0.5" title={photo.path}>
                  {photo.path.split(/[\\/]/).slice(-2, -1)[0] || ''}
                </p>
                <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                  <span className="flex items-center gap-1">
                    <HardDrive size={10} />
                    {formatFileSize(photo.file_size)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
                  <span className="flex items-center gap-1">
                    <Calendar size={10} />
                    {formatDate(photo.taken_at)}
                  </span>
                </div>
                {photo.latitude && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-green-500">
                    <MapPin size={10} />
                    有位置
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-xs text-zinc-500">
        <AlertTriangle size={12} className="inline mr-1" />
        推荐保留带星标的照片（有GPS信息或更大的文件）
      </div>
    </div>
  );
}
