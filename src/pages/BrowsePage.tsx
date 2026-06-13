import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Filter, Grid3X3, Calendar, MapPin, Camera, X, ChevronLeft, ChevronRight, Clock, Pencil, Check, MapPinned, Trash2, CheckCircle2, Circle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';
import type { Photo, PhotoDetail } from '@/types';

export function BrowsePage() {
  const navigate = useNavigate();
  const { 
    photos, 
    stats, 
    loadPhotos, 
    loadStats, 
    currentFilter, 
    setCurrentFilter,
    thumbnails,
    originalImages,
    setThumbnails,
    setOriginalImages,
  } = useAppStore();
  const get = useAppStore.getState;
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [photoDetail, setPhotoDetail] = useState<PhotoDetail | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [editingLocation, setEditingLocation] = useState(false);
  const [editDateValue, setEditDateValue] = useState('');
  const [editLatValue, setEditLatValue] = useState('');
  const [editLngValue, setEditLngValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const loadingRef = useRef(false);

  useEffect(() => {
    loadPhotos({});
    loadStats();
  }, [loadPhotos, loadStats]);

  useEffect(() => {
    const loadThumbnails = async () => {
      if (loadingRef.current) return;
      
      const photosToLoad = photos.filter(p => !(p.id in thumbnails)).slice(0, 100);
      if (photosToLoad.length === 0) return;
      
      loadingRef.current = true;
      
      // 每次只并发3个请求，避免阻塞主进程
      const CONCURRENT = 3;
      const queue = [...photosToLoad];
      const activeTasks: Promise<void>[] = [];
      
      const processOne = async (): Promise<void> => {
        const photo = queue.shift();
        if (!photo) return;
        
        try {
          const thumb = await window.api.thumbnail.get(photo.id, photo.path);
          // 每生成一张就更新状态，让用户看到进度
          setThumbnails({ ...get().thumbnails, [photo.id]: thumb });
          setOriginalImages({ ...get().originalImages, [photo.id]: `file:///${photo.path.replace(/\\/g, '/')}` });
        } catch {
          setThumbnails({ ...get().thumbnails, [photo.id]: `https://picsum.photos/seed/${photo.image_seed || photo.id}/400/400` });
          setOriginalImages({ ...get().originalImages, [photo.id]: `https://picsum.photos/seed/${photo.image_seed || photo.id}/1200/800` });
        }
        
        // 处理完一个后继续处理队列中的下一个
        await processOne();
      };
      
      // 启动并发任务
      for (let i = 0; i < Math.min(CONCURRENT, queue.length); i++) {
        activeTasks.push(processOne());
      }
      
      await Promise.all(activeTasks);
      loadingRef.current = false;
    };
    
    if (photos.length > 0) {
      loadThumbnails();
    }
  }, [photos]);

  useEffect(() => {
    if (selectedPhoto?.taken_at) {
      const date = new Date(selectedPhoto.taken_at);
      setEditDateValue(date.toISOString().slice(0, 16));
    }
    if (selectedPhoto?.latitude && selectedPhoto?.longitude) {
      setEditLatValue(selectedPhoto.latitude.toString());
      setEditLngValue(selectedPhoto.longitude.toString());
    }
  }, [selectedPhoto]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedPhoto) return;
      if (e.key === 'Escape') {
        if (editingDate || editingLocation) {
          setEditingDate(false);
          setEditingLocation(false);
        } else {
          setSelectedPhoto(null);
          setPhotoDetail(null);
        }
      } else if (e.key === 'Delete' && !editingDate && !editingLocation) {
        handleDeletePhoto();
      } else if (e.key === 'ArrowLeft' && !editingDate && !editingLocation) {
        navigatePhoto(-1);
      } else if (e.key === 'ArrowRight' && !editingDate && !editingLocation) {
        navigatePhoto(1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedPhoto, editingDate, editingLocation]);

  const navigatePhoto = useCallback((direction: number) => {
    if (!selectedPhoto) return;
    const currentIndex = photos.findIndex(p => p.id === selectedPhoto.id);
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < photos.length) {
      handleSelectPhoto(photos[newIndex]);
    }
  }, [selectedPhoto, photos]);

  const handleSelectPhoto = async (photo: Photo) => {
    setEditingDate(false);
    setEditingLocation(false);
    setSelectedPhoto(photo);
    const detail = await window.api.photo.getById(photo.id);
    setPhotoDetail(detail);
  };

  const handleFilterChange = (key: string, value: any) => {
    const newFilter = { ...currentFilter, [key]: value };
    setCurrentFilter(newFilter);
    loadPhotos(newFilter);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '未知日期';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const handleSaveDate = async () => {
    if (!selectedPhoto || !editDateValue) return;
    setIsSaving(true);
    try {
      const newDate = new Date(editDateValue).toISOString();
      const updatedPhoto = { ...selectedPhoto, taken_at: newDate };
      setSelectedPhoto(updatedPhoto);
      setEditingDate(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveLocation = async () => {
    if (!selectedPhoto) return;
    const lat = parseFloat(editLatValue);
    const lng = parseFloat(editLngValue);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      alert('请输入有效的经纬度坐标');
      return;
    }
    setIsSaving(true);
    try {
      await window.api.photo.updateLocation(selectedPhoto.id, lat, lng);
      const updatedPhoto = { ...selectedPhoto, latitude: lat, longitude: lng };
      setSelectedPhoto(updatedPhoto);
      setEditingLocation(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeletePhoto = async () => {
    if (!selectedPhoto) return;
    if (!confirm(`确定要删除这张照片吗？\n\n${selectedPhoto.filename}\n\n照片将移到系统回收站，可从回收站恢复。`)) {
      return;
    }
    try {
      await window.api.photo.delete([selectedPhoto.id]);
      const currentIndex = photos.findIndex(p => p.id === selectedPhoto.id);
      if (photos.length > 1 && currentIndex < photos.length - 1) {
        handleSelectPhoto(photos[currentIndex + 1]);
      } else if (photos.length > 1 && currentIndex > 0) {
        handleSelectPhoto(photos[currentIndex - 1]);
      } else {
        setSelectedPhoto(null);
        setPhotoDetail(null);
      }
      const newThumbnails = { ...get().thumbnails };
      delete newThumbnails[selectedPhoto.id];
      setThumbnails(newThumbnails);
      const newOriginalImages = { ...get().originalImages };
      delete newOriginalImages[selectedPhoto.id];
      setOriginalImages(newOriginalImages);
      loadPhotos(currentFilter);
      loadStats();
    } catch (error) {
      alert('删除失败：' + error);
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
    if (!confirm(`确定要删除选中的 ${count} 张照片吗？\n\n照片将移到系统回收站，可从回收站恢复。`)) {
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
      loadPhotos(currentFilter);
      loadStats();
    } catch (error) {
      alert('删除失败：' + error);
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

  const scrollToGroup = (key: string) => {
    const element = document.getElementById(`group-${key}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-zinc-100 mb-1">浏览照片</h1>
            <p className="text-sm text-zinc-400">
              共 {stats?.total.toLocaleString() || 0} 张照片
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
            <div className="space-y-6">
              {groupedPhotos.map((group) => (
                <div key={group.key} id={`group-${group.key}`}>
                  <div className="flex items-center gap-3 mb-3 sticky top-0 z-10 bg-zinc-950/90 backdrop-blur-sm py-2">
                    <div className="flex items-center gap-2 text-amber-500">
                      <Clock size={16} />
                      <span className="font-medium">{group.label}</span>
                    </div>
                    <span className="text-sm text-zinc-500">{group.photos.length} 张</span>
                    <div className="flex-1 h-px bg-zinc-800" />
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-1">
                    {group.photos.map((photo) => {
                      const isSelected = selectedIds.has(photo.id);
                      return (
                        <div
                          key={photo.id}
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
                          <img
                            src={thumbnails[photo.id] || `https://picsum.photos/seed/${photo.image_seed || photo.id}/400/400`}
                            alt={photo.filename}
                            className={cn(
                              'w-full h-full object-cover transition-transform duration-200',
                              !selectMode && 'group-hover:scale-105',
                              selectMode && isSelected && 'opacity-80'
                            )}
                            loading="lazy"
                          />
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
                    })}
                  </div>
                </div>
              ))}
            </div>
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
              onClick={() => scrollToGroup(group.key)}
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

      {selectedPhoto && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center">
          <button
            onClick={() => { setSelectedPhoto(null); setPhotoDetail(null); setEditingDate(false); setEditingLocation(false); }}
            className="absolute top-4 right-4 p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors z-10"
          >
            <X size={20} />
          </button>
          
          <button
            onClick={handleDeletePhoto}
            className="absolute top-4 right-14 p-2 rounded-lg bg-zinc-800 hover:bg-red-500/20 text-zinc-300 hover:text-red-400 transition-colors z-10"
            title="删除照片"
          >
            <Trash2 size={20} />
          </button>
          
          {!editingDate && !editingLocation && (
            <>
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
            </>
          )}

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
                  <label className="text-xs text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                    拍摄信息
                    <button
                      onClick={() => {
                        setEditingDate(!editingDate);
                        if (!editingDate && selectedPhoto.taken_at) {
                          const date = new Date(selectedPhoto.taken_at);
                          setEditDateValue(date.toISOString().slice(0, 16));
                        }
                      }}
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
                            className="flex-1 px-2 py-1 rounded bg-zinc-800 text-zinc-400 text-sm hover:bg-zinc-700 transition-colors"
                          >
                            取消
                          </button>
                          <button
                            onClick={handleSaveDate}
                            disabled={isSaving}
                            className="flex-1 px-2 py-1 rounded bg-amber-500 text-zinc-900 text-sm font-medium hover:bg-amber-400 transition-colors disabled:opacity-50"
                          >
                            {isSaving ? '保存中...' : '保存'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-between items-center">
                        <span className="text-zinc-400">日期</span>
                        <span className={cn(
                          selectedPhoto.taken_at ? 'text-zinc-200' : 'text-zinc-500 italic'
                        )}>
                          {formatDate(selectedPhoto.taken_at)}
                        </span>
                      </div>
                    )}
                    {selectedPhoto.camera && (
                      <div className="flex justify-between">
                        <span className="text-zinc-400">相机</span>
                        <span className="text-zinc-200">{selectedPhoto.camera}</span>
                      </div>
                    )}
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
                    {photoDetail?.iso && (
                      <div className="flex justify-between">
                        <span className="text-zinc-400">ISO</span>
                        <span className="text-zinc-200">{photoDetail.iso}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                    位置
                    <button
                      onClick={() => {
                        setEditingLocation(!editingLocation);
                        if (!editingLocation) {
                          setEditLatValue(selectedPhoto.latitude?.toString() || '');
                          setEditLngValue(selectedPhoto.longitude?.toString() || '');
                        }
                      }}
                      className="text-amber-500 hover:text-amber-400 transition-colors"
                    >
                      <Pencil size={12} />
                    </button>
                  </label>
                  <div className="mt-1.5">
                    {editingLocation ? (
                      <div className="space-y-1.5">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-zinc-500 w-8">纬度</span>
                            <input
                              type="number"
                              value={editLatValue}
                              onChange={(e) => setEditLatValue(e.target.value)}
                              placeholder="-90 到 90"
                              min="-90"
                              max="90"
                              step="0.0001"
                              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-sm"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-zinc-500 w-8">经度</span>
                            <input
                              type="number"
                              value={editLngValue}
                              onChange={(e) => setEditLngValue(e.target.value)}
                              placeholder="-180 到 180"
                              min="-180"
                              max="180"
                              step="0.0001"
                              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-200 text-sm"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => setEditingLocation(false)}
                            className="flex-1 px-2 py-1 rounded bg-zinc-800 text-zinc-400 text-sm hover:bg-zinc-700 transition-colors"
                          >
                            取消
                          </button>
                          <button
                            onClick={handleSaveLocation}
                            disabled={isSaving}
                            className="flex-1 px-2 py-1 rounded bg-amber-500 text-zinc-900 text-sm font-medium hover:bg-amber-400 transition-colors disabled:opacity-50"
                          >
                            {isSaving ? '保存中...' : '保存'}
                          </button>
                        </div>
                      </div>
                    ) : selectedPhoto.latitude && selectedPhoto.longitude ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-sm text-zinc-200">
                          <MapPin size={14} className="text-green-500" />
                          <span>
                            {selectedPhoto.latitude.toFixed(4)}, {selectedPhoto.longitude.toFixed(4)}
                          </span>
                        </div>
                        <button
                          onClick={() => navigate('/map')}
                          className="flex items-center gap-1 text-xs text-amber-500 hover:text-amber-400 transition-colors"
                        >
                          <MapPinned size={12} />
                          在地图上查看
                        </button>
                      </div>
                    ) : (
                      <div className="p-2 bg-zinc-800 rounded text-center">
                        <p className="text-xs text-zinc-500">此照片没有GPS信息</p>
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
        </div>
      )}
    </div>
  );
}
