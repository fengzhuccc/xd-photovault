import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, MapPin, X, ChevronLeft, ChevronRight, Pencil, MapPinned, Trash2, Loader2 } from 'lucide-react';
import { MapPickerModal } from '@/components/MapPickerModal';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn } from '@/lib/utils';
import type { Photo, PhotoDetail } from '@/types';

interface PhotoDetailModalProps {
  photo: Photo | null;
  photos?: Photo[];
  onClose: () => void;
  onNavigate?: (photo: Photo) => void;
  onDelete?: (photo: Photo) => Promise<void> | void;
  onUpdate?: (photo: Photo) => void;
}

export function PhotoDetailModal({
  photo,
  photos = [],
  onClose,
  onNavigate,
  onDelete,
  onUpdate,
}: PhotoDetailModalProps) {
  const navigate = useNavigate();
  const [photoDetail, setPhotoDetail] = useState<PhotoDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [editDateValue, setEditDateValue] = useState('');
  const [editLatValue, setEditLatValue] = useState('');
  const [editLngValue, setEditLngValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [videoError, setVideoError] = useState(false);
  const [showMapPicker, setShowMapPicker] = useState(false);

  const showNavigation = !!onNavigate && photos.length > 0;
  const isVideo = photo?.media_type === 'video';
  const mediaUrl = photo ? `file:///${photo.path.replace(/\\/g, '/')}` : '';

  // 加载照片详情
  useEffect(() => {
    if (!photo) {
      setPhotoDetail(null);
      return;
    }
    // H-16: 添加取消标志，防止快速切换照片时过期请求覆盖当前显示
    let cancelled = false;
    setLoadingDetail(true);
    setImageError(false);
    setVideoError(false);
    window.api.photo.getById(photo.id).then(detail => {
      if (!cancelled) setPhotoDetail(detail);
    }).catch(e => {
      if (!cancelled) {
        console.error('Failed to load photo detail:', e);
        setPhotoDetail(null);
      }
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false);
    });
    return () => { cancelled = true; };
  }, [photo]);

  // 同步编辑框初始值
  useEffect(() => {
    if (!photo) return;
    if (photo.taken_at) {
      const date = new Date(photo.taken_at);
      setEditDateValue(date.toISOString().slice(0, 16));
    } else {
      setEditDateValue('');
    }
    if (photo.latitude != null && photo.longitude != null) {
      setEditLatValue(photo.latitude.toString());
      setEditLngValue(photo.longitude.toString());
    } else {
      setEditLatValue('');
      setEditLngValue('');
    }
  }, [photo]);

  // 键盘事件
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showMapPicker) return;
      if (!photo) return;
      if (e.key === 'Escape') {
        if (editingDate || editingLocation) {
          setEditingDate(false);
          setEditingLocation(false);
        } else {
          onClose();
        }
      } else if (e.key === 'Delete' && !editingDate && !editingLocation) {
        handleDelete();
      } else if (e.key === 'ArrowLeft' && !editingDate && !editingLocation && showNavigation) {
        navigateByDirection(-1);
      } else if (e.key === 'ArrowRight' && !editingDate && !editingLocation && showNavigation) {
        navigateByDirection(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo, editingDate, editingLocation, showNavigation, photos, showMapPicker]);

  const navigateByDirection = useCallback((direction: number) => {
    if (!photo || !onNavigate) return;
    const currentIndex = photos.findIndex(p => p.id === photo.id);
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < photos.length) {
      onNavigate(photos[newIndex]);
    }
  }, [photo, photos, onNavigate]);

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '未知日期';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const formatFileSize = (bytes: number | null) => {
    if (bytes == null) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDuration = (seconds: number | null) => {
    if (seconds === null || seconds <= 0) return '-';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSaveDate = async () => {
    if (!photo || !editDateValue) return;
    setIsSaving(true);
    try {
      const newDate = new Date(editDateValue).toISOString();
      await window.api.photo.updateDate(photo.id, newDate);
      const updatedPhoto = { ...photo, taken_at: newDate } as Photo;
      onUpdate?.(updatedPhoto);
      setEditingDate(false);
    } catch (e) {
      toast('error', '保存日期失败：' + String(e));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveLocation = async () => {
    if (!photo) return;
    const lat = parseFloat(editLatValue);
    const lng = parseFloat(editLngValue);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast('warning', '请输入有效的经纬度坐标');
      return;
    }
    setIsSaving(true);
    try {
      await window.api.photo.updateLocation(photo.id, lat, lng);
      const updatedPhoto = { ...photo, latitude: lat, longitude: lng } as Photo;
      onUpdate?.(updatedPhoto);
      setEditingLocation(false);
    } catch (e) {
      toast('error', '保存位置失败：' + String(e));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!photo) return;
    if (!await confirm(`确定要删除这张照片吗？\n\n${photo.filename}\n\n照片将移到系统回收站，可从回收站恢复。`, { variant: 'danger', confirmText: '删除' })) {
      return;
    }
    try {
      await window.api.photo.delete([photo.id]);
      await onDelete?.(photo);
      onClose();
    } catch (error) {
      toast('error', '删除失败：' + error);
    }
  };

  if (!photo) return null;

  return (
    <div className="fixed inset-0 z-[10000] bg-black/90 flex items-center justify-center">
      {showNavigation && !editingDate && !editingLocation && (
        <>
          <button
            onClick={() => navigateByDirection(-1)}
            className="absolute left-4 p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            <ChevronLeft size={24} />
          </button>

          <button
            onClick={() => navigateByDirection(1)}
            className="absolute right-4 p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
          >
            <ChevronRight size={24} />
          </button>
        </>
      )}

      <div className="flex h-full w-full">
        <div className="flex-1 flex items-center justify-center p-4">
          {isVideo ? (
            videoError ? (
              <div className="flex flex-col items-center justify-center text-zinc-500">
                <Loader2 size={48} className="mb-3 opacity-50" />
                <p>无法加载视频</p>
              </div>
            ) : (
              <video
                src={mediaUrl}
                controls
                autoPlay
                className="max-w-full max-h-full"
                onError={() => setVideoError(true)}
              />
            )
          ) : imageError ? (
            <div className="flex flex-col items-center justify-center text-zinc-500">
              <Loader2 size={48} className="mb-3 opacity-50" />
              <p>无法加载图片</p>
            </div>
          ) : (
            <img
              src={mediaUrl}
              alt={photo.filename}
              className="max-w-full max-h-full object-contain"
              onError={() => setImageError(true)}
            />
          )}
        </div>

        <div className="w-64 bg-zinc-900/95 border-l border-zinc-800 flex flex-col">
          <div className="p-4 border-b border-zinc-800 flex items-start gap-2">
            <h3 className="flex-1 text-base font-medium text-zinc-100 break-all leading-snug" title={photo.filename}>
              {photo.filename}
            </h3>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={handleDelete}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-red-500/20 text-zinc-300 hover:text-red-400 transition-colors"
                title="删除照片"
              >
                <Trash2 size={18} />
              </button>
              <button
                onClick={onClose}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                title="关闭"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          <div className="flex-1 p-4 overflow-auto space-y-3">
            <div>
              <label className="text-xs text-zinc-400 uppercase tracking-wider">文件信息</label>
              <div className="mt-1.5 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-400">大小</span>
                  <span className="text-zinc-200">{formatFileSize(photo.file_size)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">分辨率</span>
                  <span className="text-zinc-200">{photo.width && photo.height ? `${photo.width} × ${photo.height}` : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">类型</span>
                  <span className="text-zinc-200">{isVideo ? '视频' : '图片'}</span>
                </div>
                {isVideo && (
                  <div className="flex justify-between">
                    <span className="text-zinc-400">时长</span>
                    <span className="text-zinc-200">{formatDuration(photo.duration)}</span>
                  </div>
                )}
              </div>
            </div>

            <div>
              <label className="text-xs text-zinc-400 uppercase tracking-wider flex items-center justify-between">
                拍摄信息
                <button
                  onClick={() => setEditingDate(!editingDate)}
                  className="text-amber-500 hover:text-amber-400 transition-colors"
                >
                  <Pencil size={12} />
                </button>
              </label>
              <div className="mt-1.5 space-y-1 text-sm">
                {editingDate ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Calendar size={14} className="text-zinc-500" />
                      <input
                        type="datetime-local"
                        value={editDateValue}
                        onChange={(e) => setEditDateValue(e.target.value)}
                        className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-sm"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditingDate(false)}
                        className="flex-1 btn-secondary"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveDate}
                        disabled={isSaving}
                        className="flex-1 btn-primary"
                      >
                        {isSaving ? '保存中...' : '保存'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-400">日期</span>
                    <span className={cn(
                      photo.taken_at ? 'text-zinc-200' : 'text-zinc-500 italic'
                    )}>
                      {formatDate(photo.taken_at)}
                    </span>
                  </div>
                )}
                {photo.camera && (
                  <div className="flex justify-between">
                    <span className="text-zinc-400">相机</span>
                    <span className="text-zinc-200">{photo.camera}</span>
                  </div>
                )}
                {loadingDetail ? (
                  <div className="flex items-center gap-2 text-zinc-500 py-1">
                    <Loader2 size={14} className="animate-spin" />
                    <span>加载 EXIF...</span>
                  </div>
                ) : (
                  <>
                    {photoDetail?.aperture && (
                      <div className="flex justify-between">
                        <span className="text-zinc-400">光圈</span>
                        <span className="text-zinc-200">{photoDetail.aperture}</span>
                      </div>
                    )}
                    {photoDetail?.shutter_speed && (
                      <div className="flex justify-between">
                        <span className="text-zinc-400">快门</span>
                        <span className="text-zinc-200">{photoDetail.shutter_speed}</span>
                      </div>
                    )}
                    {photoDetail?.iso != null && (
                      <div className="flex justify-between">
                        <span className="text-zinc-400">ISO</span>
                        <span className="text-zinc-200">{photoDetail.iso}</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div>
              <label className="text-xs text-zinc-400 uppercase tracking-wider flex items-center justify-between">
                位置
                <button
                  onClick={() => setEditingLocation(!editingLocation)}
                  className="text-amber-500 hover:text-amber-400 transition-colors"
                >
                  <Pencil size={12} />
                </button>
              </label>
              <div className="mt-1.5">
                {editingLocation ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400 w-8">纬度</span>
                      <input
                        type="number"
                        value={editLatValue}
                        onChange={(e) => setEditLatValue(e.target.value)}
                        placeholder="-90 到 90"
                        min="-90"
                        max="90"
                        step="0.0001"
                        className="flex-1 input"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-400 w-8">经度</span>
                      <input
                        type="number"
                        value={editLngValue}
                        onChange={(e) => setEditLngValue(e.target.value)}
                        placeholder="-180 到 180"
                        min="-180"
                        max="180"
                        step="0.0001"
                        className="flex-1 input"
                      />
                    </div>
                    <button
                      onClick={() => setShowMapPicker(true)}
                      className="w-full btn-secondary"
                    >
                      <MapPinned size={14} />
                      在地图上选择
                    </button>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditingLocation(false)}
                        className="flex-1 btn-secondary"
                      >
                        取消
                      </button>
                      <button
                        onClick={handleSaveLocation}
                        disabled={isSaving}
                        className="flex-1 btn-primary"
                      >
                        {isSaving ? '保存中...' : '保存'}
                      </button>
                    </div>
                  </div>
                ) : photo.latitude != null && photo.longitude != null ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm text-zinc-200">
                      <MapPin size={14} className="text-green-500" />
                      <span>
                        {photo.latitude.toFixed(4)}, {photo.longitude.toFixed(4)}
                      </span>
                    </div>
                    <button
                      onClick={() => navigate(`/map?photoId=${encodeURIComponent(photo.id)}`)}
                      className="flex items-center gap-1 text-xs text-amber-500 hover:text-amber-400 transition-colors"
                    >
                      <MapPinned size={12} />
                      在地图上查看
                    </button>
                  </div>
                ) : (
                  <div className="p-2 bg-zinc-800 rounded text-center">
                    <p className="text-xs text-zinc-400">此照片没有GPS信息</p>
                    <button
                      onClick={() => setEditingLocation(true)}
                      className="mt-1 text-xs text-amber-500 hover:text-amber-400 transition-colors"
                    >
                      点击添加位置
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <MapPickerModal
        isOpen={showMapPicker}
        initialLat={editLatValue ? parseFloat(editLatValue) : null}
        initialLng={editLngValue ? parseFloat(editLngValue) : null}
        onClose={() => setShowMapPicker(false)}
        onConfirm={(lat, lng) => {
          setEditLatValue(lat.toString());
          setEditLngValue(lng.toString());
        }}
      />
    </div>
  );
}
