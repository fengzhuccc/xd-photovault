import { useState, useEffect } from 'react';
import { AlertTriangle, Check, Trash2, Star, MapPin, Calendar, HardDrive } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';
import type { DuplicateGroup, Photo } from '@/types';

export function DuplicatesPage() {
  const { duplicates, loadDuplicates, stats } = useAppStore();
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates]);

  useEffect(() => {
    const loadThumbnails = async () => {
      const map = new Map<string, string>();
      const allPhotos = duplicates.flatMap(g => g.photos);
      for (const photo of allPhotos) {
        try {
          const thumb = await window.api.thumbnail.get(photo.id, photo.path);
          map.set(photo.id, thumb);
        } catch {
          map.set(photo.id, `https://picsum.photos/seed/${photo.id}/256/256`);
        }
      }
      setThumbnails(map);
    };
    if (duplicates.length > 0) {
      loadThumbnails();
    }
  }, [duplicates]);

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
      alert('请先选择要处理的重复组');
      return;
    }

    if (!confirm(`确定要删除 ${toDelete.length} 张重复照片吗？\n文件将被移动到回收站。`)) {
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
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface DuplicateCardProps {
  group: DuplicateGroup;
  isSelected: boolean;
  onToggle: () => void;
  thumbnails: Map<string, string>;
  formatDate: (date: string | null) => string;
  formatFileSize: (bytes: number) => string;
}

function DuplicateCard({ group, isSelected, onToggle, thumbnails, formatDate, formatFileSize }: DuplicateCardProps) {
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
              <div className="aspect-square relative">
                <img
                  src={thumbnails.get(photo.id) || `https://picsum.photos/seed/${photo.image_seed || photo.id}/256/256`}
                  alt={photo.filename}
                  className="w-full h-full object-cover"
                />
                {isRecommended && (
                  <div className="absolute top-2 left-2 p-1 bg-amber-500 rounded-full">
                    <Star size={12} className="text-zinc-900" />
                  </div>
                )}
              </div>
              <div className="p-2 bg-zinc-800">
                <p className="text-xs text-zinc-300 truncate">{photo.filename}</p>
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
