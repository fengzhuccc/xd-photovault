import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Trash2, FolderOpen, Save, FileText, Eye, ExternalLink, Map, Loader2, RefreshCw, Info, FolderInput, Languages } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn } from '@/lib/utils';
import { SUPPORTED_LANGUAGES, setStoredLanguage } from '@/lib/language';

// 瓦片源配置（与 MapPage 保持一致）
const TILE_PROVIDERS: Record<string, {
  needKey: boolean;
  needCoordTransform: boolean;
  keyApplyUrl?: string;
}> = {
  amap: {
    needKey: false,
    needCoordTransform: true,
  },
  amap_dark: {
    needKey: false,
    needCoordTransform: true,
  },
  tianditu: {
    needKey: true,
    needCoordTransform: true,
    keyApplyUrl: 'https://console.tianditu.gov.cn/api/key',
  },
};

export function SettingsPage() {
  const { loadStats } = useAppStore();
  const { t, i18n } = useTranslation();
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
      toast('error', t('settings.cache.toastStatsFailed') + error);
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
      toast('success', t('settings.map.toastSaved'));
    } catch (error) {
      toast('error', t('common.saveFailed') + error);
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
      console.error('Failed to load data path:', error);
      toast('error', t('settings.dataStorage.toastLoadFailed'));
    }
  };

  const loadLogPath = async () => {
    try {
      const path = await window.api.config.getLogPath();
      setLogPath(path);
      const config = await window.api.config.get();
      setCustomLogPath(config.logPath);
    } catch (error) {
      console.error('Failed to load log path:', error);
      toast('error', t('settings.log.toastLoadFailed'));
    }
  };

  const handleClearThumbnails = async () => {
    if (!await confirm(t('settings.cache.confirmClear'), { variant: 'warning' })) {
      return;
    }
    setIsClearing(true);
    try {
      await window.api.thumbnail.clear();
      toast('success', t('settings.cache.toastCleared'));
      await loadThumbnailStats();
    } catch (error) {
      toast('error', t('settings.cache.toastClearFailed') + error);
    } finally {
      setIsClearing(false);
    }
  };

  const handleClearDatabase = async () => {
    if (!await confirm(t('settings.danger.confirmClear1'), { variant: 'danger', confirmText: t('settings.danger.confirmClearBtn') })) {
      return;
    }
    if (!await confirm(t('settings.danger.confirmClear2'), { variant: 'danger', confirmText: t('settings.danger.confirmClear2Btn') })) {
      return;
    }
    try {
      const result = await window.api.database.clear();
      if (result.success) {
        await window.api.thumbnail.clear();
        toast('success', t('settings.danger.toastCleared'));
        loadStats();
      } else {
        toast('error', t('settings.danger.toastFailed') + (result.error || t('common.unknown')));
      }
    } catch (error) {
      toast('error', t('settings.danger.toastFailed') + error);
    }
  };

  const handleSelectDataFolder = async () => {
    const path = await window.api.dialog.openDataFolder();
    if (path) {
      setCustomPath(path);
    }
  };

  const handleSaveDataPath = async () => {
    if (!await confirm(t('settings.dataStorage.confirmChange'), { variant: 'info' })) {
      return;
    }
    setIsChanging(true);
    try {
      await window.api.config.setDataPath(customPath);
      toast('success', t('settings.dataStorage.toastSaved'));
    } catch (error) {
      toast('error', t('common.saveFailed') + error);
    } finally {
      setIsChanging(false);
    }
  };

  const handleResetDataPath = async () => {
    if (!await confirm(t('settings.dataStorage.confirmReset'), { variant: 'info' })) {
      return;
    }
    setCustomPath(null);
    setIsChanging(true);
    try {
      await window.api.config.setDataPath(null);
      toast('success', t('settings.dataStorage.toastReset'));
    } catch (error) {
      toast('error', t('common.saveFailed') + error);
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
      toast('success', t('settings.log.toastSaved'));
    } catch (error) {
      toast('error', t('common.saveFailed') + error);
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
      toast('success', t('settings.log.toastReset'));
    } catch (error) {
      toast('error', t('common.saveFailed') + error);
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
        setLogContent(t('settings.log.readFailed') + error);
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
      setLogContent(t('settings.log.readFailed') + error);
    } finally {
      setIsLogLoading(false);
    }
  };

  const handleClearLog = async () => {
    if (!await confirm(t('settings.log.confirmClear'), { variant: 'warning' })) {
      return;
    }
    try {
      await window.api.log.clear();
      setLogContent('');
      toast('success', t('settings.log.toastCleared'));
    } catch (error) {
      toast('error', t('settings.log.toastClearFailed') + error);
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
            <h1 className="page-title">{t('settings.pageTitle')}</h1>
            <p className="page-subtitle">{t('settings.pageSubtitle')}</p>
          </div>
        </div>

        <div className="space-y-6">
          {/* 语言 / Language */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <Languages size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.language.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.language.subtitle')}</p>
              </div>
            </div>
            <p className="text-sm text-zinc-400 mb-3">{t('settings.language.description')}</p>
            <div className="flex gap-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => setStoredLanguage(lang.code)}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    i18n.language === lang.code
                      ? 'bg-amber-500 text-zinc-900'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
                  )}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>

          {/* 数据存储位置 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <FolderOpen size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.dataStorage.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.dataStorage.subtitle')}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">{t('settings.dataStorage.currentLocation')}</label>
                <p className="text-sm text-zinc-200 break-all">{dataPath}</p>
              </div>

              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">{t('settings.dataStorage.customLocation')}</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customPath || ''}
                    placeholder={t('common.useDefault')}
                    className="flex-1 input-readonly"
                    readOnly
                  />
                  <button
                    onClick={handleSelectDataFolder}
                    className="btn-secondary"
                  >
                    {t('common.browse')}
                  </button>
                </div>
                <p className="text-xs text-zinc-400 mt-2">
                  {t('settings.dataStorage.customHint')}
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
                  {isChanging ? t('common.saving') : t('settings.dataStorage.saveAndRestart')}
                </button>
                <button
                  onClick={handleResetDataPath}
                  disabled={isChanging || customPath === null}
                  className="btn-secondary"
                >
                  {t('common.restoreDefault')}
                </button>
              </div>
            </div>
          </div>

          {/* 回收站说明 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <FolderInput size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.trash.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.trash.subtitle')}</p>
              </div>
            </div>

            <div className="space-y-3 text-sm text-zinc-300">
              <p
                className="text-sm text-zinc-400"
                dangerouslySetInnerHTML={{
                  __html: t('settings.trash.description', {
                    folder: '<code class="px-1.5 py-0.5 bg-zinc-800 rounded text-amber-400">.xd-photovault-trash</code>',
                  }),
                }}
              />
              <ul className="list-disc list-inside space-y-1 text-zinc-400">
                <li>{t('settings.trash.step1')}</li>
                <li>{t('settings.trash.step2')}</li>
                <li>{t('settings.trash.step3')}</li>
              </ul>
              <p className="text-xs text-zinc-500">
                {t('settings.trash.note')}
              </p>
            </div>
          </div>

          {/* 日志设置 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <FileText size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.log.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.log.subtitle')}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">{t('settings.log.currentPath')}</label>
                <p className="text-sm text-zinc-200 break-all">{logPath}</p>
              </div>

              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">{t('settings.log.customPath')}</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customLogPath || ''}
                    placeholder={t('common.useDefault')}
                    className="flex-1 input-readonly"
                    readOnly
                  />
                  <button
                    onClick={handleSelectLogFolder}
                    className="btn-secondary"
                  >
                    {t('common.browse')}
                  </button>
                </div>
                <p className="text-xs text-zinc-400 mt-2">
                  {t('settings.log.customHint')}
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
                  {isLogSaving ? t('common.saving') : t('settings.log.savePath')}
                </button>
                <button
                  onClick={handleResetLogPath}
                  disabled={isLogSaving || customLogPath === null}
                  className="btn-secondary"
                >
                  {t('common.restoreDefault')}
                </button>
                <button
                  onClick={handleOpenLogFolder}
                  className="btn-secondary"
                  disabled={isLogSaving}
                >
                  <ExternalLink size={14} />
                  {t('common.openFolder')}
                </button>
              </div>

              <div className="p-4 bg-zinc-800 rounded-lg">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-sm text-zinc-200">{t('settings.log.logView')}</p>
                    <p className="text-xs text-zinc-400 mt-1">{t('settings.log.logViewHint')}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleViewLog}
                      className="btn-secondary"
                    >
                      <Eye size={14} />
                      {showLog ? t('settings.log.hideLog') : t('settings.log.viewLog')}
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
                          {isLogLoading ? t('common.refreshing') : t('common.refresh')}
                        </button>
                        <button
                          onClick={handleClearLog}
                          className="btn-danger"
                        >
                          {t('settings.log.clearLog')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {showLog && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 max-h-96 overflow-auto">
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all font-mono">
                    {isLogLoading ? t('common.loading') : (logContent || t('settings.log.emptyLog'))}
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
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.map.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.map.subtitle')}</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-zinc-800 rounded-lg">
                <label className="form-label">{t('settings.map.tileProvider')}</label>
                <select
                  value={mapTileProvider}
                  onChange={(e) => setMapTileProvider(e.target.value)}
                  className="w-full input appearance-none cursor-pointer"
                >
                  {Object.entries(TILE_PROVIDERS).map(([key]) => (
                    <option key={key} value={key}>{t('settings.map.providers.' + key)}</option>
                  ))}
                </select>
                {TILE_PROVIDERS[mapTileProvider]?.needCoordTransform && (
                  <p className="text-xs text-amber-500/80 mt-2">
                    {t('settings.map.coordTransformHint')}
                  </p>
                )}
              </div>

              {TILE_PROVIDERS[mapTileProvider]?.needKey && (
                <div className="p-4 bg-zinc-800 rounded-lg">
                  <label className="form-label">{t('settings.map.apiKey')}</label>
                  <input
                    type="text"
                    value={mapApiKey}
                    onChange={(e) => setMapApiKey(e.target.value)}
                    placeholder={t('settings.map.apiKeyPlaceholder')}
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
                      {t('settings.map.applyKey')}
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
                {isMapSaving ? t('common.saving') : t('settings.map.save')}
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
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.cache.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.cache.subtitle')}</p>
              </div>
            </div>

            <div className="p-4 bg-zinc-800 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-200">{t('settings.cache.thumbnail')}</p>
                  <p className="text-xs text-zinc-400 mt-1">{t('settings.cache.thumbnailHint')}</p>
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
                  {isClearing ? t('common.clearing') : t('common.clear')}
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-zinc-700/50">
                <div>
                  <p className="text-xs text-zinc-400">{t('settings.cache.fileCount')}</p>
                  <p className="text-lg font-semibold text-zinc-200">
                    {isLoadingThumbnailStats ? '-' : (thumbnailStats?.count ?? 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-400">{t('settings.cache.diskUsage')}</p>
                  <p className="text-lg font-semibold text-zinc-200">
                    {isLoadingThumbnailStats ? '-' : formatBytes(thumbnailStats?.totalSize ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-zinc-400">{t('settings.cache.sizeDistribution')}</p>
                  <p className="text-sm text-zinc-300 mt-0.5">
                    {isLoadingThumbnailStats
                      ? '-'
                      : t('settings.cache.sizeDistributionDetail', {
                          small: (thumbnailStats?.smallCount ?? 0).toLocaleString(),
                          medium: (thumbnailStats?.mediumCount ?? 0).toLocaleString(),
                        })}
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
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.danger.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.danger.subtitle')}</p>
              </div>
            </div>

            <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
              <div>
                <p className="text-sm text-zinc-200">{t('settings.danger.clearDatabase')}</p>
                <p className="text-xs text-zinc-400 mt-1">{t('settings.danger.clearDatabaseHint')}</p>
              </div>
              <button
                onClick={handleClearDatabase}
                className="btn-danger-solid"
              >
                {t('settings.danger.clearDatabase')}
              </button>
            </div>
          </div>

          {/* 关于 */}
          <div className="card card-section">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <Info size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">{t('settings.about.title')}</h2>
                <p className="text-sm text-zinc-400">{t('settings.about.subtitle')}</p>
              </div>
            </div>

            <div className="flex items-start gap-4 p-4 bg-zinc-800 rounded-lg">
              <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center flex-shrink-0 shadow-lg">
                <span className="text-2xl font-bold text-white">{t('settings.about.appName').charAt(0)}</span>
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold text-zinc-100">{t('settings.about.appName')}</h3>
                <p className="text-sm text-amber-500 font-medium mt-0.5">{t('settings.about.version', { version: __APP_VERSION__ })}</p>
                <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
                  {t('settings.about.description')}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
