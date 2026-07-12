import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, MapPin } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface MapPickerModalProps {
  isOpen: boolean;
  initialLat?: number | null;
  initialLng?: number | null;
  onClose: () => void;
  onConfirm: (lat: number, lng: number) => void;
}

// 默认中心：北京
const DEFAULT_CENTER: [number, number] = [39.9042, 116.4074];

export function MapPickerModal({
  isOpen,
  initialLat,
  initialLng,
  onClose,
  onConfirm,
}: MapPickerModalProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const { t } = useTranslation();

  const [latValue, setLatValue] = useState('');
  const [lngValue, setLngValue] = useState('');

  // 根据初始坐标初始化输入框
  useEffect(() => {
    if (isOpen) {
      setLatValue(initialLat != null ? initialLat.toString() : '');
      setLngValue(initialLng != null ? initialLng.toString() : '');
    }
  }, [isOpen, initialLat, initialLng]);

  // 创建/销毁地图
  useEffect(() => {
    if (!isOpen || !mapContainerRef.current) return;

    const container = mapContainerRef.current;

    const lat = initialLat ?? DEFAULT_CENTER[0];
    const lng = initialLng ?? DEFAULT_CENTER[1];

    const map = L.map(container, {
      center: [lat, lng],
      zoom: initialLat != null && initialLng != null ? 15 : 10,
      zoomControl: true,
      attributionControl: true,
    });

    // 使用 CartoDB dark matter 瓦片，WGS84 坐标，和暗色主题更协调
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    const icon = L.divIcon({
      className: 'picker-marker-icon',
      html: `<div style="
        width: 24px;
        height: 24px;
        border-radius: 50% 50% 50% 0;
        background: #f59e0b;
        border: 3px solid #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
        transform: rotate(-45deg);
      "></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 24],
    });

    const marker = L.marker([lat, lng], { icon, draggable: true }).addTo(map);
    markerRef.current = marker;
    mapRef.current = map;

    const syncFromMarker = () => {
      const { lat: newLat, lng: newLng } = marker.getLatLng();
      setLatValue(newLat.toFixed(6));
      setLngValue(newLng.toFixed(6));
    };

    marker.on('dragend', syncFromMarker);
    map.on('click', (e) => {
      marker.setLatLng(e.latlng);
      syncFromMarker();
    });

    // 地图容器尺寸变化后需要通知 Leaflet 重新计算
    requestAnimationFrame(() => {
      map.invalidateSize();
    });

    return () => {
      marker.off('dragend', syncFromMarker);
      map.off('click');
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [isOpen, initialLat, initialLng]);

  // 输入框变化时同步移动 marker
  const syncFromInputs = () => {
    const lat = parseFloat(latValue);
    const lng = parseFloat(lngValue);
    if (!isNaN(lat) && !isNaN(lng) && markerRef.current && mapRef.current) {
      markerRef.current.setLatLng([lat, lng]);
      mapRef.current.panTo([lat, lng]);
    }
  };

  const handleLatChange = (value: string) => {
    setLatValue(value);
  };

  const handleLngChange = (value: string) => {
    setLngValue(value);
  };

  const handleConfirm = () => {
    const lat = parseFloat(latValue);
    const lng = parseFloat(lngValue);
    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return;
    }
    onConfirm(lat, lng);
    onClose();
  };

  // ESC 关闭 picker
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isValid =
    latValue.trim() !== '' &&
    lngValue.trim() !== '' &&
    !isNaN(parseFloat(latValue)) &&
    !isNaN(parseFloat(lngValue)) &&
    parseFloat(latValue) >= -90 &&
    parseFloat(latValue) <= 90 &&
    parseFloat(lngValue) >= -180 &&
    parseFloat(lngValue) <= 180;

  return (
    <div
      className="fixed inset-0 z-[11000] bg-black/80 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl h-[80vh] bg-zinc-900 rounded-xl border border-zinc-800 flex flex-col overflow-hidden shadow-2xl">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <MapPin size={18} className="text-amber-500" />
            <h3 className="text-base font-medium text-zinc-100">{t('mapPicker.title')}</h3>
          </div>
          <button onClick={onClose} className="icon-btn">
            <X size={18} />
          </button>
        </div>

        {/* 地图 */}
        <div className="flex-1 relative">
          <div ref={mapContainerRef} className="absolute inset-0 z-0" />
        </div>

        {/* 底部操作栏 */}
        <div className="border-t border-zinc-800 p-4 space-y-3">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 flex-1">
              <span className="text-xs text-zinc-400 w-8">{t('common.latitude')}</span>
              <input
                type="number"
                value={latValue}
                onChange={(e) => handleLatChange(e.target.value)}
                onBlur={syncFromInputs}
                placeholder={t('common.latPlaceholder')}
                min="-90"
                max="90"
                step="0.000001"
                className="flex-1 input"
              />
            </div>
            <div className="flex items-center gap-2 flex-1">
              <span className="text-xs text-zinc-400 w-8">{t('common.longitude')}</span>
              <input
                type="number"
                value={lngValue}
                onChange={(e) => handleLngChange(e.target.value)}
                onBlur={syncFromInputs}
                placeholder={t('common.lngPlaceholder')}
                min="-180"
                max="180"
                step="0.000001"
                className="flex-1 input"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-secondary">
              {t('common.cancel')}
            </button>
            <button onClick={handleConfirm} disabled={!isValid} className="btn-primary">
              {t('mapPicker.confirmLocation')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MapPickerModal;
