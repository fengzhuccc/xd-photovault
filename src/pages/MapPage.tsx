import { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, X, Calendar, Camera, Image, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

// 瓦片源配置
const TILE_PROVIDERS: Record<string, {
  name: string;
  url: string;
  attribution: string;
  needKey: boolean;
  needCoordTransform: boolean;
  keyApplyUrl?: string;
  subdomains?: string;
}> = {
  carto_dark: {
    name: 'CartoDB Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
    needKey: false,
    needCoordTransform: false,
    subdomains: 'abcd',
  },
  stadia_dark: {
    name: 'Stadia Dark',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>',
    needKey: true,
    needCoordTransform: false,
  },
  osm: {
    name: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    needKey: false,
    needCoordTransform: false,
  },
};

const DEFAULT_TILE_PROVIDER = 'carto_dark';

// WGS84 -> GCJ02 坐标转换
function transformLat(lng: number, lat: number): number {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lat * Math.PI) + 40.0 * Math.sin(lat / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(lat / 12.0 * Math.PI) + 320 * Math.sin(lat * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(lng: number, lat: number): number {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * Math.PI) + 20.0 * Math.sin(2.0 * lng * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lng * Math.PI) + 40.0 * Math.sin(lng / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(lng / 12.0 * Math.PI) + 300.0 * Math.sin(lng / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

// Haversine 距离计算（米）
function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

// 距离聚合：50m 内的照片归为同一组
function clusterPhotosByDistance(photos: PhotoWithLocation[], radiusMeters: number = 50): PhotoWithLocation[][] {
  if (photos.length === 0) return [];

  // 按纬度排序以便聚合
  const sorted = [...photos].sort((a, b) => a.latitude - b.latitude || a.longitude - b.longitude);
  const groups: PhotoWithLocation[][] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    if (assigned.has(i)) continue;
    const group: PhotoWithLocation[] = [sorted[i]];
    assigned.add(i);

    for (let j = i + 1; j < sorted.length; j++) {
      if (assigned.has(j)) continue;
      // 纬度差过大直接跳过（优化）
      if ((sorted[j].latitude - sorted[i].latitude) > 0.01) break;
      if (haversineDistance(sorted[i].latitude, sorted[i].longitude, sorted[j].latitude, sorted[j].longitude) <= radiusMeters) {
        group.push(sorted[j]);
        assigned.add(j);
      }
    }
    groups.push(group);
  }
  return groups;
}

export function MapPage() {
  const { stats, loadStats } = useAppStore();
  const [photosWithLocation, setPhotosWithLocation] = useState<PhotoWithLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [photoCount, setPhotoCount] = useState(0);
  const [tileProvider, setTileProvider] = useState(DEFAULT_TILE_PROVIDER);

  // 底部抽屉状态
  const [drawerPhotos, setDrawerPhotos] = useState<PhotoWithLocation[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLocation, setDrawerLocation] = useState('');
  const [drawerThumbnails, setDrawerThumbnails] = useState<Record<string, string>>({});
  const [drawerScrollIndex, setDrawerScrollIndex] = useState(0);

  // 详情弹窗
  const [selectedPhoto, setSelectedPhoto] = useState<PhotoWithLocation | null>(null);
  const [selectedThumbnail, setSelectedThumbnail] = useState<string | null>(null);

  useEffect(() => {
    loadStats();
    loadPhotosWithLocation();
  }, [loadStats]);

  // 每次组件挂载时读取最新地图配置
  useEffect(() => {
    const loadMapConfig = async () => {
      try {
        const saved = await window.api.mapSetting.get('tileProvider');
        if (saved && TILE_PROVIDERS[saved]) {
          setTileProvider(saved);
        }
      } catch { /* 使用默认值 */ }
    };
    loadMapConfig();
  }, []);

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

  // 点击标记组：打开底部抽屉
  const handleMarkerGroupClick = useCallback((photos: PhotoWithLocation[]) => {
    if (photos.length === 1) {
      handlePhotoClick(photos[0]);
      return;
    }
    setDrawerPhotos(photos);
    setDrawerOpen(true);
    setDrawerScrollIndex(0);
    setDrawerThumbnails({});
    // 设置位置描述
    const p = photos[0];
    setDrawerLocation(`${p.latitude.toFixed(2)}, ${p.longitude.toFixed(2)}`);
    // 异步加载缩略图
    photos.forEach(async (photo) => {
      try {
        const thumb = await window.api.thumbnail.get(photo.id, photo.path);
        setDrawerThumbnails(prev => ({ ...prev, [photo.id]: thumb }));
      } catch { /* skip */ }
    });
  }, [handlePhotoClick]);

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

  // 坐标转换（根据当前瓦片源）
  const transformCoord = useCallback((lat: number, lng: number): [number, number] => {
    const provider = TILE_PROVIDERS[tileProvider];
    if (provider?.needCoordTransform) {
      return wgs84ToGcj02(lng, lat).reverse() as [number, number];
    }
    return [lat, lng];
  }, [tileProvider]);

  return (
    <div className="h-full flex flex-col" style={{ height: 'calc(100vh - 3rem)' }}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 mb-1">地图视图</h1>
          <p className="text-sm text-zinc-400">
            {loading ? '加载中...' : `${photoCount.toLocaleString()} 张照片有位置信息`}
            {stats && stats.withoutLocation > 0 && ` · ${stats.withoutLocation.toLocaleString()} 张无位置`}
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-zinc-800 relative" style={{ minHeight: '400px' }}>
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900">
            <div className="text-center text-zinc-500">
              <div className="animate-spin w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full mx-auto mb-3"></div>
              <p>加载地图数据...</p>
            </div>
          </div>
        ) : (
          <LeafletMap
            photos={photosWithLocation}
            totalPhotoCount={photoCount}
            tileProvider={tileProvider}
            transformCoord={transformCoord}
            onPhotoClick={handlePhotoClick}
            onMarkerGroupClick={handleMarkerGroupClick}
            hasNoPhotos={photosWithLocation.length === 0}
          />
        )}
      </div>

      {/* 底部抽屉：同位置多照片 */}
      {drawerOpen && drawerPhotos.length > 1 && (
        <div className="border-t border-zinc-800 bg-zinc-900/95 backdrop-blur-sm">
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <MapPin size={14} />
              <span>{drawerLocation}</span>
              <span className="text-zinc-600">·</span>
              <span>{drawerPhotos.length} 张照片</span>
            </div>
            <button
              onClick={() => setDrawerOpen(false)}
              className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
          <div className="relative">
            <div className="flex gap-2 px-4 py-3 overflow-x-auto scrollbar-thin">
              {drawerPhotos.map((photo, idx) => (
                <button
                  key={photo.id}
                  onClick={() => handlePhotoClick(photo)}
                  className="flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 border-transparent hover:border-amber-500 transition-colors"
                >
                  {drawerThumbnails[photo.id] ? (
                    <img
                      src={drawerThumbnails[photo.id]}
                      alt={photo.filename}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
                      <Image size={20} className="text-zinc-600" />
                    </div>
                  )}
                </button>
              ))}
            </div>
            {drawerScrollIndex > 0 && (
              <button
                className="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded-full bg-zinc-800/90 text-zinc-400 hover:text-zinc-200"
                onClick={() => setDrawerScrollIndex(Math.max(0, drawerScrollIndex - 5))}
              >
                <ChevronLeft size={16} />
              </button>
            )}
          </div>
        </div>
      )}

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
  totalPhotoCount: number;
  tileProvider: string;
  transformCoord: (lat: number, lng: number) => [number, number];
  onPhotoClick: (photo: PhotoWithLocation) => void;
  onMarkerGroupClick: (photos: PhotoWithLocation[]) => void;
  hasNoPhotos: boolean;
}

// 视口按需加载的照片数量阈值
const VIEWPORT_LOAD_THRESHOLD = 5000;

function LeafletMap({ photos, totalPhotoCount, tileProvider, transformCoord, onPhotoClick, onMarkerGroupClick, hasNoPhotos }: LeafletMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const markersRef = useRef<L.MarkerClusterGroup | null>(null);
  const [viewportPhotos, setViewportPhotos] = useState<PhotoWithLocation[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFitRef = useRef(false);

  // 是否启用视口按需加载
  const useViewportLoading = totalPhotoCount > VIEWPORT_LOAD_THRESHOLD;

  // 初始化地图
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    const map = L.map(mapRef.current, {
      center: [30, 110],
      zoom: 4,
      zoomControl: true,
    });

    const provider = TILE_PROVIDERS[tileProvider] || TILE_PROVIDERS[DEFAULT_TILE_PROVIDER];
    const tileLayer = L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: 18,
      subdomains: provider.subdomains,
    });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;

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

    // 确保 Leaflet 正确计算容器尺寸
    setTimeout(() => map.invalidateSize(), 100);

    // 视口按需加载：监听 moveend 事件
    if (useViewportLoading) {
      map.on('moveend', () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(async () => {
          const bounds = map.getBounds();
          const sw = bounds.getSouthWest();
          const ne = bounds.getNorthEast();
          try {
            const result = await window.api.photo.getInBounds(sw.lat, sw.lng, ne.lat, ne.lng);
            setViewportPhotos(result);
          } catch (e) {
            console.error('Failed to load photos in bounds:', e);
          }
        }, 300);
      });

      // 初始加载当前视口
      const bounds = map.getBounds();
      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      window.api.photo.getInBounds(sw.lat, sw.lng, ne.lat, ne.lng).then(result => {
        setViewportPhotos(result);
      }).catch(e => console.error('Failed to load initial viewport:', e));
    }

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      map.remove();
      mapInstanceRef.current = null;
      markersRef.current = null;
      tileLayerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换瓦片源
  useEffect(() => {
    if (!mapInstanceRef.current || !tileLayerRef.current) return;

    const provider = TILE_PROVIDERS[tileProvider] || TILE_PROVIDERS[DEFAULT_TILE_PROVIDER];
    const newTileLayer = L.tileLayer(provider.url, {
      attribution: provider.attribution,
      maxZoom: 18,
      subdomains: provider.subdomains,
    });

    mapInstanceRef.current.removeLayer(tileLayerRef.current);
    newTileLayer.addTo(mapInstanceRef.current);
    tileLayerRef.current = newTileLayer;
  }, [tileProvider]);

  // 实际显示的照片数据
  const displayPhotos = useViewportLoading ? viewportPhotos : photos;

  // 更新标记
  useEffect(() => {
    if (!mapInstanceRef.current || !markersRef.current) return;

    const clusterGroup = markersRef.current;
    clusterGroup.clearLayers();

    // 距离聚合分组
    const groups = clusterPhotosByDistance(displayPhotos, 50);
    const markers: L.Marker[] = [];

    for (const group of groups) {
      // 取组内第一张照片的坐标作为标记位置
      const centerPhoto = group[0];
      const [lat, lng] = transformCoord(centerPhoto.latitude, centerPhoto.longitude);

      let icon: L.DivIcon;
      if (group.length === 1) {
        // 单张照片：圆形缩略图标记
        icon = L.divIcon({
          html: `<div class="photo-marker">
            <div class="photo-marker-inner">
              <svg width="32" height="32" viewBox="0 0 32 32" class="photo-marker-placeholder">
                <circle cx="16" cy="16" r="15" fill="#27272a" stroke="#f59e0b" stroke-width="2"/>
                <circle cx="16" cy="12" r="4" fill="#f59e0b"/>
                <path d="M8 24c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="#f59e0b" opacity="0.5"/>
              </svg>
            </div>
          </div>`,
          className: '',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
      } else {
        // 多张照片：带数字的圆形标记
        icon = L.divIcon({
          html: `<div class="photo-marker-group"><span>${group.length}</span></div>`,
          className: '',
          iconSize: [36, 36],
          iconAnchor: [18, 18],
        });
      }

      const marker = L.marker([lat, lng], { icon });
      marker.bindTooltip(centerPhoto.filename, { direction: 'top', offset: [0, -10] });

      if (group.length === 1) {
        marker.on('click', () => onPhotoClick(group[0]));
      } else {
        marker.on('click', () => onMarkerGroupClick(group));
      }

      markers.push(marker);
    }

    clusterGroup.addLayers(markers);

    // 首次加载时 fit bounds（仅非视口加载模式，或视口加载模式首次有数据时）
    if (!initialFitRef.current && displayPhotos.length > 0 && !useViewportLoading) {
      initialFitRef.current = true;
      const group = L.featureGroup(markers);
      const bounds = group.getBounds().pad(0.1);
      mapInstanceRef.current.fitBounds(bounds, { maxZoom: 12 });
    }
  }, [displayPhotos, transformCoord, onPhotoClick, onMarkerGroupClick, useViewportLoading]);

  return (
    <div className="w-full h-full relative">
      <div ref={mapRef} className="w-full h-full" />
      {hasNoPhotos && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 pointer-events-none z-[1000]">
          <div className="text-center text-zinc-500">
            <MapPin size={48} className="mx-auto mb-4 opacity-50" />
            <p>没有带位置信息的照片</p>
            <p className="text-sm mt-1">照片需要有GPS数据才能在地图上显示</p>
          </div>
        </div>
      )}
    </div>
  );
}
