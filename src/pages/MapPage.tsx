import { useState, useEffect, useMemo } from 'react';
import { MapPin, Navigation, AlertCircle, X, Calendar } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';
import type { Photo } from '@/types';

export function MapPage() {
  const { photos, stats, loadPhotos, loadStats } = useAppStore();
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [hoveredPhoto, setHoveredPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    loadPhotos({ hasLocation: true });
    loadStats();
  }, [loadPhotos, loadStats]);

  useEffect(() => {
    const loadThumbnails = async () => {
      const map = new Map<string, string>();
      const photosWithLocation = photos.filter(p => p.latitude && p.longitude);
      for (const photo of photosWithLocation.slice(0, 200)) {
        try {
          const thumb = await window.api.thumbnail.get(photo.id, photo.path);
          map.set(photo.id, thumb);
        } catch {
          map.set(photo.id, `https://picsum.photos/seed/${photo.id}/256/256`);
        }
      }
      setThumbnails(map);
    };
    if (photos.length > 0) {
      loadThumbnails();
    }
  }, [photos]);

  const photosWithLocation = useMemo(() => {
    return photos.filter(p => p.latitude !== null && p.longitude !== null);
  }, [photos]);

  const groupedPhotos = useMemo(() => {
    const groups = new Map<string, Photo[]>();
    for (const photo of photosWithLocation) {
      const key = `${photo.latitude?.toFixed(2)},${photo.longitude?.toFixed(2)}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(photo);
    }
    return Array.from(groups.entries()).map(([key, photos]) => ({
      key,
      lat: photos[0].latitude!,
      lng: photos[0].longitude!,
      photos,
      count: photos.length,
    }));
  }, [photosWithLocation]);

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '未知日期';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-1">地图视图</h1>
          <p className="text-sm text-zinc-400">
            {photosWithLocation.length.toLocaleString()} 张照片有位置信息
            {stats && ` · ${stats.withoutLocation.toLocaleString()} 张无位置`}
          </p>
        </div>
      </div>

      <div className="flex-1 flex gap-4 min-h-0">
        <div className="flex-1 bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden relative">
          {photosWithLocation.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-zinc-500">
              <div className="text-center">
                <MapPin size={48} className="mx-auto mb-4 opacity-50" />
                <p>没有带位置信息的照片</p>
                <p className="text-sm mt-1">照片需要有GPS数据才能在地图上显示</p>
              </div>
            </div>
          ) : (
            <SimpleMapView
              groups={groupedPhotos}
              onMarkerClick={(photos) => {
                if (photos.length === 1) {
                  setSelectedPhoto(photos[0]);
                }
              }}
              onMarkerHover={setHoveredPhoto}
            />
          )}

          {hoveredPhoto && (
            <div className="absolute bottom-4 left-4 p-3 bg-zinc-800 rounded-lg border border-zinc-700 shadow-xl">
              <div className="flex items-center gap-3">
                <img
                  src={thumbnails.get(hoveredPhoto.id) || `https://picsum.photos/seed/${hoveredPhoto.id}/256/256`}
                  alt={hoveredPhoto.filename}
                  className="w-16 h-16 object-cover rounded"
                />
                <div>
                  <p className="text-sm text-zinc-200">{hoveredPhoto.filename}</p>
                  <p className="text-xs text-zinc-400">{formatDate(hoveredPhoto.taken_at)}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="w-72 bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden flex flex-col">
          <div className="p-4 border-b border-zinc-800">
            <h3 className="text-sm font-medium text-zinc-300">位置列表</h3>
          </div>
          <div className="flex-1 overflow-auto">
            {groupedPhotos.map(({ key, lat, lng, photos, count }) => (
              <div
                key={key}
                className="p-3 border-b border-zinc-800 hover:bg-zinc-800/50 cursor-pointer transition-colors"
                onClick={() => setSelectedPhoto(photos[0])}
              >
                <div className="flex items-center gap-2 mb-1">
                  <MapPin size={12} className="text-amber-500" />
                  <span className="text-xs text-zinc-400">
                    {lat.toFixed(4)}, {lng.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-200">{count} 张照片</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {selectedPhoto && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8">
          <div className="relative max-w-4xl w-full bg-zinc-900 rounded-xl overflow-hidden">
            <button
              onClick={() => setSelectedPhoto(null)}
              className="absolute top-4 right-4 p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 z-10"
            >
              <X size={20} />
            </button>
            <img
              src={thumbnails.get(selectedPhoto.id) || `https://picsum.photos/seed/${selectedPhoto.id}/800/600`}
              alt={selectedPhoto.filename}
              className="w-full max-h-[70vh] object-contain"
            />
            <div className="p-4 border-t border-zinc-800">
              <h3 className="text-lg font-medium text-zinc-100">{selectedPhoto.filename}</h3>
              <div className="mt-2 flex items-center gap-4 text-sm text-zinc-400">
                <span className="flex items-center gap-1">
                  <Calendar size={14} />
                  {formatDate(selectedPhoto.taken_at)}
                </span>
                <span className="flex items-center gap-1">
                  <MapPin size={14} />
                  {selectedPhoto.latitude?.toFixed(4)}, {selectedPhoto.longitude?.toFixed(4)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface SimpleMapViewProps {
  groups: Array<{
    key: string;
    lat: number;
    lng: number;
    photos: Photo[];
    count: number;
  }>;
  onMarkerClick: (photos: Photo[]) => void;
  onMarkerHover: (photo: Photo | null) => void;
}

function SimpleMapView({ groups, onMarkerClick, onMarkerHover }: SimpleMapViewProps) {
  const [bounds, setBounds] = useState({ minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 });

  useEffect(() => {
    if (groups.length > 0) {
      const lats = groups.map(g => g.lat);
      const lngs = groups.map(g => g.lng);
      const padding = 5;
      setBounds({
        minLat: Math.max(-90, Math.min(...lats) - padding),
        maxLat: Math.min(90, Math.max(...lats) + padding),
        minLng: Math.max(-180, Math.min(...lngs) - padding),
        maxLng: Math.min(180, Math.max(...lngs) + padding),
      });
    }
  }, [groups]);

  const latToY = (lat: number) => {
    const range = bounds.maxLat - bounds.minLat;
    return ((bounds.maxLat - lat) / range) * 100;
  };

  const lngToX = (lng: number) => {
    const range = bounds.maxLng - bounds.minLng;
    return ((lng - bounds.minLng) / range) * 100;
  };

  return (
    <div className="w-full h-full relative bg-zinc-950">
      <div className="absolute inset-0 opacity-20">
        <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#3f3f46" strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>

      {groups.map(({ key, lat, lng, photos, count }) => (
        <div
          key={key}
          className="absolute transform -translate-x-1/2 -translate-y-1/2 cursor-pointer group"
          style={{
            left: `${lngToX(lng)}%`,
            top: `${latToY(lat)}%`,
          }}
          onClick={() => onMarkerClick(photos)}
          onMouseEnter={() => onMarkerHover(photos[0])}
          onMouseLeave={() => onMarkerHover(null)}
        >
          <div
            className={cn(
              'relative flex items-center justify-center rounded-full transition-all',
              'bg-amber-500 text-zinc-900 font-bold text-xs',
              count > 1 ? 'w-8 h-8' : 'w-4 h-4'
            )}
          >
            {count > 1 && count}
          </div>
          <div className="absolute -bottom-1 left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-amber-500" />
        </div>
      ))}

      <div className="absolute bottom-4 right-4 flex items-center gap-2 text-xs text-zinc-500 bg-zinc-900/80 px-3 py-2 rounded-lg">
        <Navigation size={12} />
        <span>简化地图视图</span>
      </div>
    </div>
  );
}
