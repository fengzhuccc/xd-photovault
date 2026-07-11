import { useState, useEffect } from 'react';
import { Database, Trash2, FolderOpen, Save, FileText, Eye, ExternalLink, Map, Loader2, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';

// 瓦片源配置（与 MapPage 保持一致）
const TILE_PROVIDERS: Record<string, {
  name: string;
  needKey: boolean;
  needCoordTransform: boolean;
  keyApplyUrl?: string;
}> = {
  amap: {
    name: '高德地图（自动坐标偏移）',
    needKey: false,
    needCoordTransform: true,
  },
  amap_dark: {
    name: '高德暗色（自动坐标偏移）',
    needKey: false,
    needCoordTransform: true,
  },
  tianditu: {
    name: '天地图（需 API Key + 自动坐标偏移）',
    needKey: true,
    needCoordTransform: true,
    keyApplyUrl: 'https://console.tianditu.gov.cn/api/key',
  },
};

export function SettingsPage() {
  const { loadStats } = useAppStore();
  const [isClearing, setIsClearing] = useState(false);
  const [thumbnailStats, setThumbnailStats] = useState<{ count: number; totalSize: number; smallCount: number; mediumCount: number } | null>(null);
  const [isLoadingThumbnailStats, setIsLoadingThumbnailStats] = useState(false);
  const [dataPath, setDataPath] = useState<string>('');
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [isChanging, setIsChanging] = useState(false);

  // 地图设置状态
  const [mapTileProvider, setMapTileProvider] = useState<string>('amap');
  const [mapApiKey, setMapApiKey] = useState<string>('');
  const [isMapSaving, setIsMapSaving] = useState(false);

  // 日志相关状态
  const [logPath, setLogPath] = useState<string>('');
  const [customLogPath, setCustomLogPath] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string>('');
  const [showLog, setShowLog] = useState(false);
  const [isLogLoading, setIsLogLoading] = useState(false);
  const [isLogSaving, setIsLogSaving] = useState(false);

  useEffect(() => {
    loadDataPath();
    loadLogPath();
    loadMapSettings();
    loadThumbnailStats();
  }, []);

  const loadThumbnailStats = async () => {
    setIsLoadingThumbnailStats(true);
    try {
      const stats = await window.api.thumbnail.stats();
      setThumbnailStats(stats);
    } catch (error) {
      toast('error', '获取缩略图统计失败：' + error);
    } finally {
      setIsLoadingThumbnailStats(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const loadMapSettings = async () => {
    try {
      const saved = await window.api.mapSetting.get('tileProvider');
      if (saved && TILE_PROVIDERS[saved]) {
        setMapTileProvider(saved);
      }
      const savedKey = await window.api.mapSetting.get('apiKey');
      if (savedKey) {
        setMapApiKey(savedKey.trim());
      }
    } catch { /* 使用默认值 */ }
  };

  const handleSaveMapSettings = async () => {
    setIsMapSaving(true);
    try {
      await window.api.mapSetting.set('tileProvider', mapTileProvider);
      if (mapApiKey.trim()) {
        await window.api.mapSetting.set('apiKey', mapApiKey.trim());
      } else {
        // 清除空 key
        await window.api.mapSetting.set('apiKey', '');
      }
      toast('success', '地图设置已保存，切换到地图页面即可生效');
    } catch (error) {
      toast('error', '保存失败：' + error);
    } finally {
      setIsMapSaving(false);
    }
  };

  const loadDataPath = async () => {
    try {
      const path = await window.api.config.getDataPath();
      setDataPath(path);
      const config = await window.api.config.get();
      setCustomPath(config.dataPath);
    } catch (error) {
      console.error('加载数据路径失败:', error);
      toast('error', '加载数据路径失败');
    }
  };

  const loadLogPath = async () => {
    try {
      const path = await window.api.config.getLogPath();
      setLogPath(path);
      const config = await window.api.config.get();
      setCustomLogPath(config.logPath);
    } catch (error) {
      console.error('加载日志路径失败:', error);
      toast('error', '加载日志路径失败');
    }
  };

  const handleClearThumbnails = async () => {
    if (!await confirm('确定要清除所有缩略图缓存吗？\n下次浏览时会重新生成缩略图。', { variant: 'warning' })) {
      return;
    }
    setIsClearing(true);
    try {
      await window.api.thumbnail.clear();
      toast('success', '缩略图缓存已清除');
      await loadThumbnailStats();
    } catch (error) {
      toast('error', '清除失败：' + error);
    } finally {
      setIsClearing(false);
    }
  };

  const handleClearDatabase = async () => {
    if (!await confirm('确定要清除所有数据吗？\n\n这将删除所有照片记录、文件夹和重复检测结果。\n此操作不可恢复！', { variant: 'danger', confirmText: '清除' })) {
      return;
    }
    if (!await confirm('再次确认：这将删除数据库中的所有记录，需要重新扫描文件夹。\n\n确定继续吗？', { variant: 'danger', confirmText: '确认清除' })) {
      return;
    }
    try {
      const result = await window.api.database.clear();
      if (result.success) {
        await window.api.thumbnail.clear();
        toast('success', '数据库已清除，请重新添加文件夹并扫描。');
        loadStats();
      } else {
        toast('error', '清除失败：' + (result.error || '未知错误'));
      }
    } catch (error) {
      toast('error', '清除失败：' + error);
    }
  };

  const handleSelectDataFolder = async () => {
    const path = await window.api.dialog.openDataFolder();
    if (path) {
      setCustomPath(path);
    }
  };

  const handleSaveDataPath = async () => {
    if (!await confirm('更改数据存储位置后需要重启应用才能生效。\n\n确定要保存吗？', { variant: 'info' })) {
      return;
    }
    setIsChanging(true);
    try {
      await window.api.config.setDataPath(customPath);
      toast('success', '设置已保存，请重启应用以使用新的数据存储位置。');
    } catch (error) {
      toast('error', '保存失败：' + error);
    } finally {
      setIsChanging(false);
    }
  };

  const handleResetDataPath = async () => {
    if (!await confirm('确定要恢复默认存储位置吗？\n需要重启应用才能生效。', { variant: 'info' })) {
      return;
    }
    setCustomPath(null);
    setIsChanging(true);
    try {
      await window.api.config.setDataPath(null);
      toast('success', '已恢复默认设置，请重启应用。');
    } catch (error) {
      toast('error', '保存失败：' + error);
    } finally {
      setIsChanging(false);
    }
  };

  const handleSelectLogFolder = async () => {
    const path = await window.api.dialog.openLogFolder();
    if (path) {
      setCustomLogPath(path);
    }
  };

  const handleSaveLogPath = async () => {
    setIsLogSaving(true);
    try {
      await window.api.config.setLogPath(customLogPath);
      const newPath = await window.api.config.getLogPath();
      setLogPath(newPath);
      toast('success', '日志路径已更新');
    } catch (error) {
      toast('error', '保存失败：' + error);
    } finally {
      setIsLogSaving(false);
    }
  };

  const handleResetLogPath = async () => {
    setIsLogSaving(true);
    try {
      setCustomLogPath(null);
      await window.api.config.setLogPath(null);
      const newPath = await window.api.config.getLogPath();
      setLogPath(newPath);
      toast('success', '已恢复默认日志路径');
    } catch (error) {
      toast('error', '保存失败：' + error);
    } finally {
      setIsLogSaving(false);
    }
  };

  const handleViewLog = async () => {
    setShowLog(!showLog);
    if (!showLog) {
      setIsLogLoading(true);
      try {
        const content = await window.api.log.read(500);
        setLogContent(content);
      } catch (error) {
        setLogContent('读取日志失败：' + error);
      } finally {
        setIsLogLoading(false);
      }
    }
  };

  const handleRefreshLog = async () => {
    setIsLogLoading(true);
    try {
      const content = await window.api.log.read(500);
      setLogContent(content);
    } catch (error) {
      setLogContent('读取日志失败：' + error);
    } finally {
      setIsLogLoading(false);
    }
  };

  const handleClearLog = async () => {
    if (!await confirm('确定要清除所有日志吗？', { variant: 'warning' })) {
      return;
    }
    try {
      await window.api.log.clear();
      setLogContent('');
      toast('success', '日志已清除');
    } catch (error) {
      toast('error', '清除失败：' + error);
    }
  };

  const handleOpenLogFolder = async () => {
    await window.api.log.openFolder();
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto">
        <div className="page-header">
          <div>
            <h1 className="page-title">设置</h1>
            <p className="page-subtitle">管理应用程序设置和数据</p>
          </div>
        </div>

        <div className="space-y-6">
          {/* 数据存储位置 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <FolderOpen size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">数据存储位置</h2>
                <p className="text-sm text-zinc-400">设置数据库和缩略图的存储位置</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">当前位置</label>
                <p className="text-sm text-zinc-200 break-all">{dataPath}</p>
              </div>

              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">自定义存储位置</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customPath || ''}
                    placeholder="使用默认位置"
                    className="flex-1 input-readonly"
                    readOnly
                  />
                  <button
                    onClick={handleSelectDataFolder}
                    className="btn-secondary"
                  >
                    浏览...
                  </button>
                </div>
                <p className="text-xs text-zinc-400 mt-2">
                  数据库和缩略图将存储在此位置。留空则使用默认位置。
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleSaveDataPath}
                  disabled={isChanging}
                  className="btn-primary"
                >
                  {isChanging ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  {isChanging ? '保存中...' : '保存并重启'}
                </button>
                <button
                  onClick={handleResetDataPath}
                  disabled={isChanging || customPath === null}
                  className="btn-secondary"
                >
                  恢复默认
                </button>
              </div>
            </div>
          </div>

          {/* 日志设置 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <FileText size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">日志设置</h2>
                <p className="text-sm text-zinc-400">配置日志存储位置并查看日志</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">当前日志路径</label>
                <p className="text-sm text-zinc-200 break-all">{logPath}</p>
              </div>

              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">自定义日志路径</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customLogPath || ''}
                    placeholder="使用默认位置"
                    className="flex-1 input-readonly"
                    readOnly
                  />
                  <button
                    onClick={handleSelectLogFolder}
                    className="btn-secondary"
                  >
                    浏览...
                  </button>
                </div>
                <p className="text-xs text-zinc-400 mt-2">
                  日志文件将存储在此目录下。留空则使用默认位置。
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleSaveLogPath}
                  disabled={isLogSaving}
                  className="btn-secondary"
                >
                  {isLogSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Save size={14} />
                  )}
                  {isLogSaving ? '保存中...' : '保存路径'}
                </button>
                <button
                  onClick={handleResetLogPath}
                  disabled={isLogSaving || customLogPath === null}
                  className="btn-secondary"
                >
                  恢复默认
                </button>
                <button
                  onClick={handleOpenLogFolder}
                  className="btn-secondary"
                  disabled={isLogSaving}
                >
                  <ExternalLink size={14} />
                  打开目录
                </button>
              </div>

              <div className="p-4 bg-zinc-800 rounded-lg">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-sm text-zinc-200">日志查看</p>
                    <p className="text-xs text-zinc-400 mt-1">查看、刷新或清除应用运行日志</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleViewLog}
                      className="btn-secondary"
                    >
                      <Eye size={14} />
                      {showLog ? '隐藏日志' : '查看日志'}
                    </button>
                    {showLog && (
                      <>
                        <button
                          onClick={handleRefreshLog}
                          disabled={isLogLoading}
                          className="btn-secondary"
                        >
                          {isLogLoading ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                          {isLogLoading ? '刷新中...' : '刷新'}
                        </button>
                        <button
                          onClick={handleClearLog}
                          className="btn-danger"
                        >
                          清除日志
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {showLog && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 max-h-96 overflow-auto">
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all font-mono">
                    {isLogLoading ? '加载中...' : logContent || '暂无日志'}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* 地图设置 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <Map size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">地图设置</h2>
                <p className="text-sm text-zinc-400">配置地图瓦片源和 API Key</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">地图瓦片源</label>
                <select
                  value={mapTileProvider}
                  onChange={(e) => setMapTileProvider(e.target.value)}
                  className="w-full input appearance-none cursor-pointer"
                >
                  {Object.entries(TILE_PROVIDERS).map(([key, provider]) => (
                    <option key={key} value={key}>{provider.name}</option>
                  ))}
                </select>
                {TILE_PROVIDERS[mapTileProvider]?.needCoordTransform && (
                  <p className="text-xs text-amber-500/80 mt-2">
                    此地图源使用 GCJ02 坐标系，照片坐标将自动从 WGS84 转换
                  </p>
                )}
              </div>

              {TILE_PROVIDERS[mapTileProvider]?.needKey && (
                <div className="p-4 bg-zinc-800 rounded-lg">
                  <label className="form-label">API Key</label>
                  <input
                    type="text"
                    value={mapApiKey}
                    onChange={(e) => setMapApiKey(e.target.value)}
                    placeholder="输入 API Key"
                    className="w-full input"
                  />
                  {TILE_PROVIDERS[mapTileProvider]?.keyApplyUrl && (
                    <a
                      href={TILE_PROVIDERS[mapTileProvider].keyApplyUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-amber-500 hover:text-amber-400 mt-2"
                    >
                      <ExternalLink size={12} />
                      前往申请 API Key
                    </a>
                  )}
                </div>
              )}

              <button
                onClick={handleSaveMapSettings}
                disabled={isMapSaving}
                className="btn-primary"
              >
                {isMapSaving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                {isMapSaving ? '保存中...' : '保存地图设置'}
              </button>
            </div>
          </div>

          {/* 缓存管理 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <Database size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">缓存管理</h2>
                <p className="text-sm text-zinc-400">清除缓存以释放磁盘空间</p>
              </div>
            </div>

            <div className="p-4 bg-zinc-800 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-200">缩略图缓存</p>
                  <p className="text-xs text-zinc-400 mt-1">清除后下次浏览时会重新生成</p>
                </div>
                <button
                  onClick={handleClearThumbnails}
                  disabled={isClearing || isLoadingThumbnailStats}
                  className="btn-danger"
                >
                  {isClearing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {isClearing ? '清除中...' : '清除'}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-zinc-700/50">
                <div>
                  <p className="text-xs text-zinc-400">文件总数</p>
                  <p className="text-lg font-semibold text-zinc-200">
                    {isLoadingThumbnailStats ? '-' : (thumbnailStats?.count ?? 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-400">占用空间</p>
                  <p className="text-lg font-semibold text-zinc-200">
                    {isLoadingThumbnailStats ? '-' : formatBytes(thumbnailStats?.totalSize ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-400">尺寸分布</p>
                  <p className="text-sm text-zinc-300 mt-0.5">
                    {isLoadingThumbnailStats
                      ? '-'
                      : `small ${(thumbnailStats?.smallCount ?? 0).toLocaleString()} / medium ${(thumbnailStats?.mediumCount ?? 0).toLocaleString()}`}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* 危险操作 */}
          <div className="card card-section border-red-500/20">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-500/10 rounded-lg">
                <Trash2 size={20} className="text-red-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">危险操作</h2>
                <p className="text-sm text-zinc-400">这些操作不可逆，请谨慎使用</p>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
              <div>
                <p className="text-sm text-zinc-200">清除数据库</p>
                <p className="text-xs text-zinc-400 mt-1">删除所有照片记录、文件夹和重复检测结果，需要重新扫描</p>
              </div>
              <button
                onClick={handleClearDatabase}
                className="btn-danger-solid"
              >
                清除数据库
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
