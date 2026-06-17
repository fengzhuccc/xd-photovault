import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MapPin, X, Image, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { PhotoDetailModal } from '@/components/PhotoDetailModal';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Photo } from '@/types';

// 瓦片源配置
const TILE_PROVIDER = {
  name: '高德地图',
  url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
  subdomains: '12',
};

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
  // eslint-disable-next-line no-loss-of-precision
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

// 计算照片组的重心坐标
function groupCentroid(group: PhotoWithLocation[]): { lat: number; lng: number } {
  const sumLat = group.reduce((sum, p) => sum + p.latitude, 0);
  const sumLng = group.reduce((sum, p) => sum + p.longitude, 0);
  return { lat: sumLat / group.length, lng: sumLng / group.length };
}

// 距离聚合：50m 内的照片归为同一组
function clusterPhotosByDistance(photos: PhotoWithLocation[], radiusMeters: number = 50): PhotoWithLocation[][] {
  if (photos.length === 0) return [];

  // 按纬度排序以便聚合
  const sorted = [...photos].sort((a, b) => a.latitude - b.latitude || a.longitude - b.longitude);
  const groups: PhotoWithLocation[][] = [];
  const assigned = new Set<number>();

  // 50m 约等于 0.00045 度纬度，用作经纬度方向粗筛阈值
  const degreeThreshold = radiusMeters / 111_000;

  for (let i = 0; i < sorted.length; i++) {
    if (assigned.has(i)) continue;
    const group: PhotoWithLocation[] = [sorted[i]];
    assigned.add(i);

    for (let j = i + 1; j < sorted.length; j++) {
      if (assigned.has(j)) continue;
      const latDiff = sorted[j].latitude - sorted[i].latitude;
      const lngDiff = Math.abs(sorted[j].longitude - sorted[i].longitude);
      // 经纬度差过大直接跳过
      if (latDiff > degreeThreshold) break;
      if (lngDiff > degreeThreshold) continue;
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
  const [searchParams] = useSearchParams();
  const highlightPhotoId = searchParams.get('photoId');
  // 当前要高亮的照片 ID，支持 URL 传入和地图内点击切换
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(highlightPhotoId);

  // URL 参数变化时同步高亮状态
  useEffect(() => {
    setSelectedPhotoId(highlightPhotoId);
  }, [highlightPhotoId]);

  const [photosWithLocation, setPhotosWithLocation] = useState<PhotoWithLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [photoCount, setPhotoCount] = useState(0);

  // 底部抽屉状态
  const [drawerPhotos, setDrawerPhotos] = useState<PhotoWithLocation[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLocation, setDrawerLocation] = useState('');
  const [drawerThumbnails, setDrawerThumbnails] = useState<Record<string, string>>({});

  // 详情弹窗
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  // 缩略图缓存：避免重复 I/O
  const thumbnailCacheRef = useRef<Record<string, string>>({});
  const drawerAbortRef = useRef<AbortController | null>(null);

  const loadPhotosWithLocation = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    loadStats();
    loadPhotosWithLocation();
  }, [loadStats, loadPhotosWithLocation]);

  const loadThumbnail = useCallback(async (photo: PhotoWithLocation, signal?: AbortSignal): Promise<string | null> => {
    const cached = thumbnailCacheRef.current[photo.id];
    if (cached) return cached;
    try {
      const thumb = await window.api.thumbnail.get(photo.id, photo.path);
      if (signal?.aborted) return null;
      thumbnailCacheRef.current[photo.id] = thumb;
      return thumb;
    } catch {
      return null;
    }
  }, []);

  const handlePhotoClick = useCallback((photo: PhotoWithLocation) => {
    setSelectedPhotoId(photo.id);
    window.api.photo.getById(photo.id).then(detail => {
      setSelectedPhoto(detail);
    }).catch(e => {
      console.error('Failed to load photo detail:', e);
    });
  }, []);

  // 点击标记组：打开底部抽屉
  const handleMarkerGroupClick = useCallback((photos: PhotoWithLocation[]) => {
    if (photos.length === 1) {
      handlePhotoClick(photos[0]);
      return;
    }
    setSelectedPhotoId(photos[0].id);
    // 取消上次未完成的缩略图加载
    if (drawerAbortRef.current) {
      drawerAbortRef.current.abort();
    }
    const abortController = new AbortController();
    drawerAbortRef.current = abortController;

    setDrawerPhotos(photos);
    setDrawerOpen(true);
    setDrawerThumbnails({});
    // 设置位置描述（使用重心）
    const centroid = groupCentroid(photos);
    setDrawerLocation(`${centroid.lat.toFixed(2)}, ${centroid.lng.toFixed(2)}`);
    // 异步加载缩略图
    photos.forEach(async (photo) => {
      const thumb = await loadThumbnail(photo, abortController.signal);
      if (thumb && !abortController.signal.aborted) {
        setDrawerThumbnails(prev => ({ ...prev, [photo.id]: thumb }));
      }
    });
  }, [handlePhotoClick, loadThumbnail]);

  // 坐标转换（高德地图使用 GCJ02）
  const transformCoord = useCallback((lat: number, lng: number): [number, number] => {
    const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
    return [gcjLat, gcjLng];
  }, []);

  // 清理未完成的缩略图请求
  useEffect(() => {
    return () => {
      drawerAbortRef.current?.abort();
    };
  }, []);

  const closePhotoDetail = useCallback(() => {
    setSelectedPhoto(null);
  }, []);

  return (
    <div className="h-full flex flex-col" style={{ height: 'calc(100vh - 3rem)' }}>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-100 mb-1">地图视图</h1>
        <p className="text-sm text-zinc-400">
          {loading ? '加载中...' : `${photoCount.toLocaleString()} 张照片有位置信息`}
          {stats && stats.withoutLocation > 0 && ` · ${stats.withoutLocation.toLocaleString()} 张无位置`}
        </p>
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
            transformCoord={transformCoord}
            onPhotoClick={handlePhotoClick}
            onMarkerGroupClick={handleMarkerGroupClick}
            hasNoPhotos={photosWithLocation.length === 0}
            highlightPhotoId={selectedPhotoId}
          />
        )}
      </div>

      {/* 底部抽屉：同位置多照片 */}
      <div className={`border-t border-zinc-800 bg-zinc-900/98 backdrop-blur-sm transition-all duration-300 ease-out ${drawerOpen && drawerPhotos.length > 1 ? 'max-h-[240px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden border-t-0'}`}>
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
        <div className="px-4 py-3 overflow-x-auto scrollbar-thin">
          <div className="flex gap-3">
            {drawerPhotos.map((photo) => (
              <button
                key={photo.id}
                onClick={() => handlePhotoClick(photo)}
                className="flex-shrink-0 group"
              >
                <div className="w-24 h-24 rounded-lg overflow-hidden border-2 border-transparent group-hover:border-amber-500 transition-colors">
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
                </div>
                <p className="mt-1 text-xs text-zinc-500 truncate w-24 group-hover:text-zinc-300 transition-colors">{photo.filename}</p>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 照片详情弹窗 */}
      <PhotoDetailModal
        photo={selectedPhoto}
        onClose={closePhotoDetail}
        onUpdate={(updatedPhoto) => {
          setSelectedPhoto(updatedPhoto);
          loadPhotosWithLocation();
        }}
        onDelete={async () => {
          setSelectedPhoto(null);
          await loadPhotosWithLocation();
        }}
      />
    </div>
  );
}

interface LeafletMapProps {
  photos: PhotoWithLocation[];
  totalPhotoCount: number;
  transformCoord: (lat: number, lng: number) => [number, number];
  onPhotoClick: (photo: PhotoWithLocation) => void;
  onMarkerGroupClick: (photos: PhotoWithLocation[]) => void;
  hasNoPhotos: boolean;
  highlightPhotoId?: string | null;
}

// 视口按需加载的照片数量阈值
const VIEWPORT_LOAD_THRESHOLD = 5000;

function LeafletMap({ photos, totalPhotoCount, transformCoord, onPhotoClick, onMarkerGroupClick, hasNoPhotos, highlightPhotoId }: LeafletMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const initializedRef = useRef(false);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const [viewportPhotos, setViewportPhotos] = useState<PhotoWithLocation[]>([]);
  const [viewportLoading, setViewportLoading] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFitRef = useRef(false);
  const highlightFitRef = useRef(false);

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

    const tileLayer = L.tileLayer(TILE_PROVIDER.url, {
      attribution: TILE_PROVIDER.attribution,
      maxZoom: 18,
      subdomains: TILE_PROVIDER.subdomains,
    });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;

    // 使用 LayerGroup 而非 MarkerClusterGroup，避免与自定义距离聚合冲突
    const markerLayer = L.layerGroup().addTo(map);
    markersRef.current = markerLayer;
    mapInstanceRef.current = map;

    // 确保 Leaflet 正确计算容器尺寸
    setTimeout(() => {
      map.invalidateSize();
      initializedRef.current = true;
    }, 200);

    // 视口按需加载：监听 moveend 事件
    if (useViewportLoading) {
      const loadViewport = async () => {
        const bounds = map.getBounds();
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        setViewportLoading(true);
        try {
          const result = await window.api.photo.getInBounds(sw.lat, sw.lng, ne.lat, ne.lng);
          setViewportPhotos(result);
        } catch (e) {
          console.error('Failed to load photos in bounds:', e);
        } finally {
          setViewportLoading(false);
        }
      };

      map.on('moveend', () => {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(loadViewport, 300);
      });

      // 初始加载当前视口
      loadViewport();
    }

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      map.remove();
      mapInstanceRef.current = null;
      markersRef.current = null;
      tileLayerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 实际显示的照片数据
  const displayPhotos = useViewportLoading ? viewportPhotos : photos;

  // 更新标记
  useEffect(() => {
    if (!mapInstanceRef.current || !markersRef.current) return;

    const layerGroup = markersRef.current;
    layerGroup.clearLayers();

    // 距离聚合分组
    const groups = clusterPhotosByDistance(displayPhotos, 50);

    let highlightedMarker: L.Marker | null = null;

    for (const group of groups) {
      const centerPhoto = group[0];
      // 取组内重心作为标记位置
      const centroid = groupCentroid(group);
      const [lat, lng] = transformCoord(centroid.lat, centroid.lng);
      const isHighlighted = !!highlightPhotoId && group.some(p => p.id === highlightPhotoId);

      let icon: L.DivIcon;
      if (group.length === 1) {
        // 单张照片：圆形标记
        icon = L.divIcon({
          html: `<div class="photo-marker">
            <div class="photo-marker-inner ${isHighlighted ? 'highlight' : ''}">
              <svg width="28" height="28" viewBox="0 0 28 28" class="photo-marker-placeholder">
                <circle cx="14" cy="14" r="13" fill="#27272a" stroke="#f59e0b" stroke-width="2"/>
                <circle cx="14" cy="11" r="3.5" fill="#f59e0b"/>
                <path d="M7 22c0-3.9 3.1-7 7-7s7 3.1 7 7" fill="#f59e0b" opacity="0.5"/>
              </svg>
            </div>
          </div>`,
          className: 'photo-marker-icon',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });
      } else {
        // 多张照片：带数字的圆形标记
        icon = L.divIcon({
          html: `<div class="photo-marker-group ${isHighlighted ? 'highlight' : ''}"><span>${group.length}</span></div>`,
          className: 'photo-marker-icon',
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        });
      }

      const marker = L.marker([lat, lng], { icon });

      if (group.length === 1) {
        marker.bindTooltip(centerPhoto.filename, { direction: 'top', offset: [0, -10] });
        marker.on('click', () => onPhotoClick(group[0]));
      } else {
        marker.bindTooltip(`${group.length} 张照片`, { direction: 'top', offset: [0, -10] });
        marker.on('click', () => onMarkerGroupClick(group));
      }

      if (isHighlighted) {
        highlightedMarker = marker;
      }

      layerGroup.addLayer(marker);
    }

    // 首次加载时 fit bounds
    if (!initialFitRef.current && displayPhotos.length > 0) {
      initialFitRef.current = true;
      const allMarkers = layerGroup.getLayers() as L.Marker[];
      if (allMarkers.length > 0) {
        const featureGroup = L.featureGroup(allMarkers);
        mapInstanceRef.current.fitBounds(featureGroup.getBounds().pad(0.1), { maxZoom: 12 });
      }
    }

    // 高亮目标照片：定位并打开 tooltip
    if (highlightedMarker && !highlightFitRef.current) {
      highlightFitRef.current = true;
      const map = mapInstanceRef.current;
      const latLng = highlightedMarker.getLatLng();
      map.flyTo(latLng, 15, { duration: 1 });
      highlightedMarker.openTooltip();
    }
  }, [displayPhotos, transformCoord, onPhotoClick, onMarkerGroupClick, highlightPhotoId]);

  const showEmpty = !hasNoPhotos && displayPhotos.length === 0 && !viewportLoading;

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
      {showEmpty && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/60 pointer-events-none z-[999]">
          <div className="text-center text-zinc-500">
            <MapPin size={40} className="mx-auto mb-3 opacity-50" />
            <p>当前视口没有照片</p>
            <p className="text-sm mt-1">移动或缩放地图查看更多位置</p>
          </div>
        </div>
      )}
      {viewportLoading && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/80 text-xs text-zinc-400 z-[1001]">
          <Loader2 size={14} className="animate-spin" />
          <span>加载视口照片...</span>
        </div>
      )}
    </div>
  );
}
