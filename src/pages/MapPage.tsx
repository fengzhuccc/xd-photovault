import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { MapPin, X, Calendar, Camera, Image } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

// Fix leaflet default icon issue
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface PhotoWithLocation {
  id: string;
  path: string;
  filename: string;
  latitude: number;
  longitude: number;
  taken_at: string | null;
  camera: string | null;
  width: number | null;
  height: number | null;
  file_size: number | null;
}

export function MapPage() {
  const { stats, loadStats } = useAppStore();
  const [photosWithLocation, setPhotosWithLocation] = useState<PhotoWithLocation[]>([]);
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoWithLocation | null>(null);
  const [selectedThumbnail, setSelectedThumbnail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [photoCount, setPhotoCount] = useState(0);

  useEffect(() => {
    loadStats();
    loadPhotosWithLocation();
  }, [loadStats]);

  const loadPhotosWithLocation = async () => {
    try {
      setLoading(true);
      const photos = await window.api.photo.getWithLocation();
      setPhotosWithLocation(photos);
      setPhotoCount(photos.length);
    } catch (error) {
      console.error('Failed to load photos with location:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadThumbnail = async (photo: PhotoWithLocation) => {
    try {
      const thumb = await window.api.thumbnail.get(photo.id, photo.path);
      setSelectedThumbnail(thumb);
    } catch {
      setSelectedThumbnail(null);
    }
  };

  const handlePhotoClick = useCallback((photo: PhotoWithLocation) => {
    setSelectedPhoto(photo);
    loadThumbnail(photo);
  }, []);

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '未知日期';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-1">地图视图</h1>
          <p className="text-sm text-zinc-400">
            {loading ? '加载中...' : `${photoCount.toLocaleString()} 张照片有位置信息`}
            {stats && stats.withoutLocation > 0 && ` · ${stats.withoutLocation.toLocaleString()} 张无位置`}
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-zinc-800 relative">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
            <div className="text-center text-zinc-500">
              <div className="animate-spin w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto mb-3"></div>
              <p>加载地图数据...</p>
            </div>
          </div>
        ) : photosWithLocation.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
            <div className="text-center text-zinc-500">
              <MapPin size={48} className="mx-auto mb-4 opacity-50" />
              <p>没有带位置信息的照片</p>
              <p className="text-sm mt-1">照片需要有GPS数据才能在地图上显示</p>
            </div>
          </div>
        ) : (
          <LeafletMap
            photos={photosWithLocation}
            onPhotoClick={handlePhotoClick}
          />
        )}
      </div>

      {/* 照片详情弹窗 */}
      {selectedPhoto && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8" onClick={() => setSelectedPhoto(null)}>
          <div className="relative max-w-2xl w-full bg-zinc-900 rounded-xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setSelectedPhoto(null)}
              className="absolute top-3 right-3 p-2 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 z-10"
            >
              <X size={18} />
            </button>
            {selectedThumbnail ? (
              <img
                src={selectedThumbnail}
                alt={selectedPhoto.filename}
                className="w-full max-h-[60vh] object-contain bg-zinc-950"
              />
            ) : (
              <div className="w-full h-60 flex items-center justify-center bg-zinc-950">
                <Image size={48} className="text-zinc-700" />
              </div>
            )}
            <div className="p-4 border-t border-zinc-800">
              <h3 className="text-base font-medium text-zinc-100 mb-2">{selectedPhoto.filename}</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-400">
                {selectedPhoto.taken_at && (
                  <span className="flex items-center gap-1">
                    <Calendar size={14} />
                    {formatDate(selectedPhoto.taken_at)}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <MapPin size={14} />
                  {selectedPhoto.latitude.toFixed(4)}, {selectedPhoto.longitude.toFixed(4)}
                </span>
                {selectedPhoto.camera && (
                  <span className="flex items-center gap-1">
                    <Camera size={14} />
                    {selectedPhoto.camera}
                  </span>
                )}
                {selectedPhoto.file_size && (
                  <span>{formatFileSize(selectedPhoto.file_size)}</span>
                )}
                {selectedPhoto.width && selectedPhoto.height && (
                  <span>{selectedPhoto.width} x {selectedPhoto.height}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface LeafletMapProps {
  photos: PhotoWithLocation[];
  onPhotoClick: (photo: PhotoWithLocation) => void;
}

function LeafletMap({ photos, onPhotoClick }: LeafletMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.MarkerClusterGroup | null>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    const map = L.map(mapRef.current, {
      center: [30, 110],
      zoom: 4,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);

    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 50,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      iconCreateFunction: function (cluster) {
        const count = cluster.getChildCount();
        let size = 'small';
        let dim = 40;
        if (count > 100) {
          size = 'large';
          dim = 56;
        } else if (count > 10) {
          size = 'medium';
          dim = 48;
        }
        return L.divIcon({
          html: `<div><span>${count}</span></div>`,
          className: `marker-cluster marker-cluster-${size}`,
          iconSize: L.point(dim, dim),
        });
      },
    });

    clusterGroup.addTo(map);
    markersRef.current = clusterGroup;
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markersRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapInstanceRef.current || !markersRef.current) return;

    const clusterGroup = markersRef.current;
    clusterGroup.clearLayers();

    const markers: L.Marker[] = [];

    for (const photo of photos) {
      const marker = L.marker([photo.latitude, photo.longitude]);
      marker.bindTooltip(photo.filename, { direction: 'top', offset: [0, -10] });
      marker.on('click', () => onPhotoClick(photo));
      markers.push(marker);
    }

    clusterGroup.addLayers(markers);

    // Fit bounds to show all markers
    if (photos.length > 0) {
      const group = L.featureGroup(markers);
      const bounds = group.getBounds().pad(0.1);
      mapInstanceRef.current.fitBounds(bounds, { maxZoom: 12 });
    }
  }, [photos, onPhotoClick]);

  return <div ref={mapRef} className="w-full h-full" />;
}
