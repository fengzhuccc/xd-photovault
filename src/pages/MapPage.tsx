import { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, X, Calendar, Camera, Image } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

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
  amap: {
    name: '高德地图',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
    needKey: false,
    needCoordTransform: true,
    subdomains: '12',
  },
  amap_dark: {
    name: '高德暗色',
    url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
    attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>',
    needKey: false,
    needCoordTransform: true,
    subdomains: '12',
  },
  tianditu: {
    name: '天地图',
    url: 'https://t{s}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk={apiKey}',
    attribution: '&copy; <a href="https://www.tianditu.gov.cn/">天地图</a>',
    needKey: true,
    needCoordTransform: true,
    keyApplyUrl: 'https://console.tianditu.gov.cn/api/key',
    subdomains: '01234567',
  },
};

const DEFAULT_TILE_PROVIDER = 'amap';

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
  const [mapApiKey, setMapApiKey] = useState('');

  // 底部抽屉状态
  const [drawerPhotos, setDrawerPhotos] = useState<PhotoWithLocation[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLocation, setDrawerLocation] = useState('');
  const [drawerThumbnails, setDrawerThumbnails] = useState<Record<string, string>>({});

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
        const savedKey = await window.api.mapSetting.get('apiKey');
        if (savedKey) {
          setMapApiKey(savedKey.trim());
        }
        const saved = await window.api.mapSetting.get('tileProvider');
        if (saved && TILE_PROVIDERS[saved]) {
          // 如果需要 Key 但没配置，回退到默认源
          if (TILE_PROVIDERS[saved].needKey && !savedKey?.trim()) {
            setTileProvider(DEFAULT_TILE_PROVIDER);
          } else {
            setTileProvider(saved);
          }
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
        <div className="flex items-center gap-2">
          <select
            value={tileProvider}
            onChange={async (e) => {
              const val = e.target.value;
              const provider = TILE_PROVIDERS[val];
              if (provider?.needKey && !mapApiKey) {
                alert(`${provider.name} 需要 API Key，请先在设置页面配置`);
                return;
              }
              setTileProvider(val);
              try { await window.api.mapSetting.set('tileProvider', val); } catch {}
            }}
            className="bg-zinc-800 border border-zinc-700 text-zinc-300 text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-amber-500"
          >
            {Object.entries(TILE_PROVIDERS).map(([key, p]) => (
              <option key={key} value={key}>{p.name}</option>
            ))}
          </select>
          {TILE_PROVIDERS[tileProvider]?.needCoordTransform && (
            <span className="text-xs text-amber-500/70 bg-amber-500/10 px-2 py-1 rounded">坐标已偏移</span>
          )}
          {TILE_PROVIDERS[tileProvider]?.needKey && !mapApiKey && (
            <span className="text-xs text-red-400 bg-red-500/10 px-2 py-1 rounded">未配置 API Key</span>
          )}
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
            mapApiKey={mapApiKey}
            transformCoord={transformCoord}
            onPhotoClick={handlePhotoClick}
            onMarkerGroupClick={handleMarkerGroupClick}
            hasNoPhotos={photosWithLocation.length === 0}
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
      {selectedPhoto && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-8" style={{ zIndex: 10000 }} onClick={() => setSelectedPhoto(null)}>
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
  mapApiKey: string;
  transformCoord: (lat: number, lng: number) => [number, number];
  onPhotoClick: (photo: PhotoWithLocation) => void;
  onMarkerGroupClick: (photos: PhotoWithLocation[]) => void;
  hasNoPhotos: boolean;
}

// 视口按需加载的照片数量阈值
const VIEWPORT_LOAD_THRESHOLD = 5000;

function LeafletMap({ photos, totalPhotoCount, tileProvider, mapApiKey, transformCoord, onPhotoClick, onMarkerGroupClick, hasNoPhotos }: LeafletMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const initializedRef = useRef(false);
  const markersRef = useRef<L.LayerGroup | null>(null);
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
    const tileUrl = provider.url.replace('{apiKey}', mapApiKey);
    const tileLayer = L.tileLayer(tileUrl, {
      attribution: provider.attribution,
      maxZoom: 18,
      subdomains: provider.subdomains || 'abc',
    });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;

    // 使用 LayerGroup 而非 MarkerClusterGroup，避免与自定义距离聚合冲突
    const markerLayer = L.layerGroup().addTo(map);
    markersRef.current = markerLayer as any;
    mapInstanceRef.current = map;

    // 确保 Leaflet 正确计算容器尺寸
    setTimeout(() => {
      map.invalidateSize();
      initializedRef.current = true;
    }, 200);

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
    if (!initializedRef.current || !mapInstanceRef.current || !tileLayerRef.current) return;

    const provider = TILE_PROVIDERS[tileProvider] || TILE_PROVIDERS[DEFAULT_TILE_PROVIDER];
    const tileUrl = provider.url.replace('{apiKey}', mapApiKey);
    const newTileLayer = L.tileLayer(tileUrl, {
      attribution: provider.attribution,
      maxZoom: 18,
      subdomains: provider.subdomains || 'abc',
    });

    mapInstanceRef.current.removeLayer(tileLayerRef.current);
    newTileLayer.addTo(mapInstanceRef.current);
    tileLayerRef.current = newTileLayer;

    // 强制重绘：延迟 invalidateSize + 触发一次微小移动
    setTimeout(() => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.invalidateSize();
        const c = mapInstanceRef.current.getCenter();
        mapInstanceRef.current.setView(c, mapInstanceRef.current.getZoom(), { animate: false });
      }
    }, 150);
  }, [tileProvider, mapApiKey]);

  // 实际显示的照片数据
  const displayPhotos = useViewportLoading ? viewportPhotos : photos;

  // 更新标记
  useEffect(() => {
    if (!mapInstanceRef.current || !markersRef.current) return;

    const layerGroup = markersRef.current;
    layerGroup.clearLayers();

    // 距离聚合分组
    const groups = clusterPhotosByDistance(displayPhotos, 50);

    for (const group of groups) {
      // 取组内第一张照片的坐标作为标记位置
      const centerPhoto = group[0];
      const [lat, lng] = transformCoord(centerPhoto.latitude, centerPhoto.longitude);

      let icon: L.DivIcon;
      if (group.length === 1) {
        // 单张照片：圆形标记
        icon = L.divIcon({
          html: `<div class="photo-marker">
            <div class="photo-marker-inner">
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
          html: `<div class="photo-marker-group"><span>${group.length}</span></div>`,
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

      layerGroup.addLayer(marker);
    }

    // 首次加载时 fit bounds
    if (!initialFitRef.current && displayPhotos.length > 0) {
      initialFitRef.current = true;
      const allMarkers = Object.values((layerGroup as any)._layers || {});
      if (allMarkers.length > 0) {
        const featureGroup = L.featureGroup(allMarkers as L.Marker[]);
        mapInstanceRef.current.fitBounds(featureGroup.getBounds().pad(0.1), { maxZoom: 12 });
      }
    }
  }, [displayPhotos, transformCoord, onPhotoClick, onMarkerGroupClick]);

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
