import { useState, useEffect } from 'react';
import { Database, Trash2, FolderOpen, Info, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';

export function SettingsPage() {
  const { stats, loadStats } = useAppStore();
  const [isClearing, setIsClearing] = useState(false);
  const [dataPath, setDataPath] = useState<string>('');
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [isChanging, setIsChanging] = useState(false);

  useEffect(() => {
    loadDataPath();
    loadStats();
  }, []);

  const loadDataPath = async () => {
    const path = await window.api.config.getDataPath();
    setDataPath(path);
    const config = await window.api.config.get();
    setCustomPath(config.dataPath);
  };

  const handleClearThumbnails = async () => {
    if (!confirm('确定要清除所有缩略图缓存吗？\n下次浏览时会重新生成缩略图。')) {
      return;
    }
    setIsClearing(true);
    try {
      await window.api.thumbnail.clear();
      alert('缩略图缓存已清除');
    } catch (error) {
      alert('清除失败：' + error);
    } finally {
      setIsClearing(false);
    }
  };

  const handleSelectDataFolder = async () => {
    const path = await window.api.dialog.openDataFolder();
    if (path) {
      setCustomPath(path);
    }
  };

  const handleSaveDataPath = async () => {
    if (!confirm('更改数据存储位置后需要重启应用才能生效。\n\n确定要保存吗？')) {
      return;
    }
    setIsChanging(true);
    try {
      await window.api.config.setDataPath(customPath);
      alert('设置已保存，请重启应用以使用新的数据存储位置。');
    } catch (error) {
      alert('保存失败：' + error);
    } finally {
      setIsChanging(false);
    }
  };

  const handleResetDataPath = async () => {
    if (!confirm('确定要恢复默认存储位置吗？\n需要重启应用才能生效。')) {
      return;
    }
    setCustomPath(null);
    setIsChanging(true);
    try {
      await window.api.config.setDataPath(null);
      alert('已恢复默认设置，请重启应用。');
    } catch (error) {
      alert('保存失败：' + error);
    } finally {
      setIsChanging(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-zinc-100 mb-1">设置</h1>
          <p className="text-sm text-zinc-400">管理应用程序设置和数据</p>
        </div>

        <div className="space-y-6">
          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-blue-500/10 rounded-lg">
                <FolderOpen size={20} className="text-blue-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">数据存储位置</h2>
                <p className="text-sm text-zinc-400">设置数据库和缩略图的存储位置</p>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="p-4 bg-zinc-800 rounded-lg">
                <p className="text-xs text-zinc-500 mb-1">当前位置</p>
                <p className="text-sm text-zinc-200 break-all">{dataPath}</p>
              </div>

              <div className="p-4 bg-zinc-800 rounded-lg">
                <p className="text-xs text-zinc-500 mb-2">自定义存储位置</p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customPath || ''}
                    onChange={(e) => setCustomPath(e.target.value || null)}
                    placeholder="使用默认位置"
                    className="flex-1 bg-zinc-700 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-200"
                    readOnly
                  />
                  <button
                    onClick={handleSelectDataFolder}
                    className="px-4 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm transition-colors"
                  >
                    浏览...
                  </button>
                </div>
                <p className="text-xs text-zinc-500 mt-2">
                  数据库和缩略图将存储在此位置。留空则使用默认位置。
                </p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={handleSaveDataPath}
                  disabled={isChanging}
                  className={cn(
                    'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    'bg-amber-500 text-zinc-900 hover:bg-amber-400',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  <RefreshCw size={14} className={isChanging ? 'animate-spin' : ''} />
                  保存并重启
                </button>
                <button
                  onClick={handleResetDataPath}
                  disabled={isChanging || customPath === null}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm transition-colors',
                    'bg-zinc-700 text-zinc-300 hover:bg-zinc-600',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  恢复默认
                </button>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-amber-500/10 rounded-lg">
                <Database size={20} className="text-amber-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">数据统计</h2>
                <p className="text-sm text-zinc-400">照片库数据概览</p>
              </div>
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-zinc-800 rounded-lg p-4">
                <p className="text-sm text-zinc-400">照片总数</p>
                <p className="text-2xl font-bold text-zinc-100 mt-1">
                  {stats?.total.toLocaleString() || 0}
                </p>
              </div>
              <div className="bg-zinc-800 rounded-lg p-4">
                <p className="text-sm text-zinc-400">有位置信息</p>
                <p className="text-2xl font-bold text-zinc-100 mt-1">
                  {stats?.withLocation.toLocaleString() || 0}
                </p>
              </div>
              <div className="bg-zinc-800 rounded-lg p-4">
                <p className="text-sm text-zinc-400">重复照片</p>
                <p className="text-2xl font-bold text-amber-500 mt-1">
                  {stats?.duplicates.toLocaleString() || 0}
                </p>
              </div>
              <div className="bg-zinc-800 rounded-lg p-4">
                <p className="text-sm text-zinc-400">文件夹数</p>
                <p className="text-2xl font-bold text-zinc-100 mt-1">
                  {stats?.folders || 0}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-500/10 rounded-lg">
                <Trash2 size={20} className="text-red-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">缓存管理</h2>
                <p className="text-sm text-zinc-400">清除缓存以释放磁盘空间</p>
              </div>
            </div>
            
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 bg-zinc-800 rounded-lg">
                <div>
                  <p className="text-sm text-zinc-200">缩略图缓存</p>
                  <p className="text-xs text-zinc-500 mt-1">清除后下次浏览时会重新生成</p>
                </div>
                <button
                  onClick={handleClearThumbnails}
                  disabled={isClearing}
                  className={cn(
                    'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                    'bg-red-500/10 text-red-500 hover:bg-red-500/20',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  {isClearing ? '清除中...' : '清除'}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-green-500/10 rounded-lg">
                <Info size={20} className="text-green-500" />
              </div>
              <div>
                <h2 className="text-lg font-medium text-zinc-100">关于</h2>
                <p className="text-sm text-zinc-400">应用程序信息</p>
              </div>
            </div>
            
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">版本</span>
                <span className="text-zinc-200">1.0.0</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">技术栈</span>
                <span className="text-zinc-200">Electron + React + TypeScript</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
