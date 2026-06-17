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
  ret += (150.0 * Math.sin(lng / 12.0 * Math.PI) + 300 * Math.sin(lng / 30.0 * Math.PI)) * 2.0 / 3.0;
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

interface PhotoCluster {
  cluster_lat: number;
  cluster_lng: number;
  count: number;
  representative_id: string;
  path: string;
  filename: string;
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

// 与后端保持一致的网格精度计算
function clusterPrecision(zoom: number): number {
  return Math.max(90 / Math.pow(2, zoom), 0.0001);
}

export function MapPage() {
  const { stats, loadStats } = useAppStore();
  const [searchParams] = useSearchParams();
  const highlightPhotoId = searchParams.get('photoId');

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

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const loadThumbnail = useCallback(async (photo: { id: string; path: string }, signal?: AbortSignal): Promise<string | null> => {
    const cached = thumbnailCacheRef.current[photo.id];
    if (cached) return cached;
    try {
      const thumb = await window.api.thumbnail.get(photo.id, photo.path, 'small');
      if (signal?.aborted) return null;
      thumbnailCacheRef.current[photo.id] = thumb;
      return thumb;
    } catch {
      return null;
    }
  }, []);

  const handlePhotoClick = useCallback((photoId: string) => {
    window.api.photo.getById(photoId).then(detail => {
      setSelectedPhoto(detail);
    }).catch(e => {
      console.error('Failed to load photo detail:', e);
    });
  }, []);

  // 点击聚合簇：单张直接打开详情，多张打开抽屉
  const handleClusterClick = useCallback(async (cluster: PhotoCluster, zoom: number) => {
    if (cluster.count === 1) {
      handlePhotoClick(cluster.representative_id);
      return;
    }

    // 取消上次未完成的缩略图加载
    if (drawerAbortRef.current) {
      drawerAbortRef.current.abort();
    }
    const abortController = new AbortController();
    drawerAbortRef.current = abortController;

    const precision = clusterPrecision(zoom);
    const south = cluster.cluster_lat - precision / 2;
    const north = cluster.cluster_lat + precision / 2;
    const west = cluster.cluster_lng - precision / 2;
    const east = cluster.cluster_lng + precision / 2;

    setDrawerOpen(true);
    setDrawerThumbnails({});
    setDrawerLocation(`${cluster.cluster_lat.toFixed(4)}, ${cluster.cluster_lng.toFixed(4)}`);

    try {
      const photos = await window.api.photo.getInBounds(south, west, north, east);
      if (abortController.signal.aborted) return;
      setDrawerPhotos(photos);
      // 异步加载缩略图
      photos.forEach(async (photo) => {
        const thumb = await loadThumbnail(photo, abortController.signal);
        if (thumb && !abortController.signal.aborted) {
          setDrawerThumbnails(prev => ({ ...prev, [photo.id]: thumb }));
        }
      });
    } catch (e) {
      console.error('Failed to load cluster photos:', e);
      setDrawerOpen(false);
    }
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

  const hasLocationPhotos = (stats?.withLocation ?? 0) > 0;

  return (
    <div className="h-full flex flex-col" style={{ height: 'calc(100vh - 3rem)' }}>
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-100 mb-1">地图视图</h1>
        <p className="text-sm text-zinc-400">
          {stats ? `${stats.withLocation.toLocaleString()} 张照片有位置信息` : '加载中...'}
          {stats && stats.withoutLocation > 0 && ` · ${stats.withoutLocation.toLocaleString()} 张无位置`}
        </p>
      </div>

      <div className="flex-1 min-h-0 rounded-xl overflow-hidden border border-zinc-800 relative" style={{ minHeight: '400px' }}>
        <LeafletMap
          hasNoPhotos={!hasLocationPhotos}
          transformCoord={transformCoord}
          onPhotoClick={handlePhotoClick}
          onClusterClick={handleClusterClick}
          highlightPhotoId={highlightPhotoId}
        />
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
                onClick={() => handlePhotoClick(photo.id)}
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
        }}
        onDelete={async () => {
          setSelectedPhoto(null);
          await loadStats();
        }}
      />
    </div>
  );
}

interface LeafletMapProps {
  hasNoPhotos: boolean;
  transformCoord: (lat: number, lng: number) => [number, number];
  onPhotoClick: (photoId: string) => void;
  onClusterClick: (cluster: PhotoCluster, zoom: number) => void;
  highlightPhotoId?: string | null;
}

const MIN_CLUSTER_ZOOM = 16;

function LeafletMap({ hasNoPhotos, transformCoord, onPhotoClick, onClusterClick, highlightPhotoId }: LeafletMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const [clusters, setClusters] = useState<PhotoCluster[]>([]);
  const [viewportLoading, setViewportLoading] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialFitRef = useRef(false);
  const highlightFitRef = useRef(false);

  // 加载当前视口聚合簇
  const loadViewport = useCallback(async () => {
    const map = mapInstanceRef.current;
    if (!map) return;

    const bounds = map.getBounds();
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const zoom = map.getZoom();

    setViewportLoading(true);
    try {
      // 高缩放时直接显示单张照片，低缩放时显示聚合簇
      if (zoom >= MIN_CLUSTER_ZOOM) {
        const photos = await window.api.photo.getInBounds(sw.lat, sw.lng, ne.lat, ne.lng);
        // 把单张照片包装成 count=1 的簇格式，统一渲染
        setClusters(photos.map(p => ({
          cluster_lat: p.latitude,
          cluster_lng: p.longitude,
          count: 1,
          representative_id: p.id,
          path: p.path,
          filename: p.filename,
        })));
      } else {
        const result = await window.api.photo.getClustersInBounds(sw.lat, sw.lng, ne.lat, ne.lng, zoom);
        setClusters(result);
      }
    } catch (e) {
      console.error('Failed to load viewport photos:', e);
    } finally {
      setViewportLoading(false);
    }
  }, []);

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

    const markerLayer = L.layerGroup().addTo(map);
    markersRef.current = markerLayer;
    mapInstanceRef.current = map;

    // 确保 Leaflet 正确计算容器尺寸
    setTimeout(() => {
      map.invalidateSize();
    }, 200);

    const scheduleLoad = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(loadViewport, 300);
    };

    map.on('moveend', scheduleLoad);
    map.on('zoomend', scheduleLoad);

    // 初始加载
    scheduleLoad();

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      map.remove();
      mapInstanceRef.current = null;
      markersRef.current = null;
      tileLayerRef.current = null;
    };
  }, [loadViewport]);

  // 更新标记
  useEffect(() => {
    if (!mapInstanceRef.current || !markersRef.current) return;

    const layerGroup = markersRef.current;
    layerGroup.clearLayers();

    let highlightedMarker: L.Marker | null = null;

    for (const cluster of clusters) {
      const [lat, lng] = transformCoord(cluster.cluster_lat, cluster.cluster_lng);
      const isHighlighted = cluster.representative_id === highlightPhotoId;

      let icon: L.DivIcon;
      if (cluster.count === 1) {
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
        icon = L.divIcon({
          html: `<div class="photo-marker-group ${isHighlighted ? 'highlight' : ''}"><span>${cluster.count}</span></div>`,
          className: 'photo-marker-icon',
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        });
      }

      const marker = L.marker([lat, lng], { icon });

      if (cluster.count === 1) {
        marker.bindTooltip(cluster.filename, { direction: 'top', offset: [0, -10] });
        marker.on('click', () => onPhotoClick(cluster.representative_id));
      } else {
        marker.bindTooltip(`${cluster.count} 张照片`, { direction: 'top', offset: [0, -10] });
        marker.on('click', () => onClusterClick(cluster, mapInstanceRef.current!.getZoom()));
      }

      if (isHighlighted) {
        highlightedMarker = marker;
      }

      layerGroup.addLayer(marker);
    }

    // 首次加载时 fit bounds
    if (!initialFitRef.current && clusters.length > 0) {
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
  }, [clusters, transformCoord, onPhotoClick, onClusterClick, highlightPhotoId]);

  const showEmpty = !hasNoPhotos && clusters.length === 0 && !viewportLoading;

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
