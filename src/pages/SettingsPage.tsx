import { useState } from 'react';
import { Database, Trash2, FolderOpen, Info, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';

export function SettingsPage() {
  const { stats, loadStats } = useAppStore();
  const [isClearing, setIsClearing] = useState(false);

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

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
              <div className="p-2 bg-blue-500/10 rounded-lg">
                <Info size={20} className="text-blue-500" />
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
