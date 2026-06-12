import { useState, useEffect } from 'react';
import { FolderOpen, Plus, Trash2, RefreshCw, HardDrive, Calendar } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';
import type { ScanProgress } from '@/types';

export function LibraryPage() {
  const {
    folders,
    scanProgress,
    isScanning,
    loadFolders,
    loadStats,
    addFolder,
    removeFolder,
    setScanProgress,
    setIsScanning,
  } = useAppStore();

  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [scanResult, setScanResult] = useState<ScanProgress | null>(null);

  useEffect(() => {
    loadFolders();
    loadStats();
  }, [loadFolders, loadStats]);

  useEffect(() => {
    const unsubscribe = window.api.scan.onProgress((progress: ScanProgress) => {
      setScanProgress(progress);
      if (progress.status === 'complete') {
        setIsScanning(false);
        setScanResult(progress);
        loadFolders();
        loadStats();
      }
    });
    return () => { unsubscribe(); };
  }, [setScanProgress, setIsScanning, loadFolders, loadStats]);

  const handleAddFolder = async () => {
    setIsAddingFolder(true);
    try {
      const path = await window.api.dialog.openFolder();
      if (path) {
        const result = await window.api.folder.add(path);
        if (result.isNew) {
          addFolder({
            id: result.id,
            path: result.path,
            added_at: new Date().toISOString(),
            last_scanned: null,
            photo_count: 0,
          });
        }
      }
    } finally {
      setIsAddingFolder(false);
    }
  };

  const handleScan = async (folderId: string) => {
    setIsScanning(true);
    setScanResult(null);
    setScanProgress({ current: 0, total: 0, currentFile: '', status: 'scanning' });
    try {
      await window.api.scan.start(folderId);
    } catch (error) {
      console.error('Scan failed:', error);
      setScanProgress({ current: 0, total: 0, currentFile: '', status: 'idle' });
    } finally {
      setIsScanning(false);
      loadFolders();
      loadStats();
    }
  };

  const handleRemoveFolder = async (id: string) => {
    if (confirm('确定要移除此文件夹吗？照片索引将被删除，但原始文件不会被删除。')) {
      await window.api.folder.remove(id);
      removeFolder(id);
    }
  };

  const formatPath = (path: string) => {
    const parts = path.split(/[/\\]/);
    if (parts.length > 3) {
      return '.../' + parts.slice(-3).join('/');
    }
    return path;
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '从未';
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-zinc-100 mb-2">照片库</h1>
        <p className="text-zinc-400">管理你的照片文件夹，扫描并建立索引</p>
      </div>

      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={handleAddFolder}
          disabled={isAddingFolder}
          className={cn(
            'flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium transition-colors',
            'bg-amber-500 hover:bg-amber-400 text-zinc-900',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <Plus size={18} />
          添加文件夹
        </button>
      </div>

      {isScanning && scanProgress && (
        <div className="mb-6 p-4 bg-zinc-900 rounded-xl border border-zinc-800">
          <div className="flex items-center gap-3 mb-3">
            <RefreshCw size={18} className="text-amber-500 animate-spin" />
            <span className="text-sm text-zinc-300">
              {scanProgress.status === 'hashing' ? '正在检测重复照片...' : '正在扫描...'}
            </span>
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 mb-2">
            <div
              className="bg-amber-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-zinc-500">
            <span>{scanProgress.currentFile}</span>
            <span>{scanProgress.current} / {scanProgress.total}</span>
          </div>
        </div>
      )}

      {scanResult && scanResult.status === 'complete' && (
        <div className="mb-6 p-4 bg-zinc-900 rounded-xl border border-zinc-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-green-400 text-lg">✓</span>
              <span className="text-sm text-zinc-300">扫描完成</span>
            </div>
            <button
              onClick={() => setScanResult(null)}
              className="text-zinc-500 hover:text-zinc-300 text-xs"
            >
              关闭
            </button>
          </div>
          <div className="flex gap-4 mt-2 text-xs text-zinc-400">
            {scanResult.newCount !== undefined && scanResult.newCount > 0 && (
              <span className="text-green-400">新增 {scanResult.newCount} 张</span>
            )}
            {scanResult.skipped !== undefined && scanResult.skipped > 0 && (
              <span>跳过 {scanResult.skipped} 张</span>
            )}
            {scanResult.duplicates !== undefined && scanResult.duplicates > 0 && (
              <span className="text-amber-400">重复 {scanResult.duplicates} 组</span>
            )}
            {scanResult.deletedCount !== undefined && scanResult.deletedCount > 0 && (
              <span className="text-red-400">删除 {scanResult.deletedCount} 张</span>
            )}
            {scanResult.newCount === 0 && scanResult.skipped === scanResult.total && (
              <span>未发现新照片</span>
            )}
          </div>
        </div>
      )}

      <div className="space-y-3">
        {folders.length === 0 ? (
          <div className="text-center py-16 text-zinc-500">
            <FolderOpen size={48} className="mx-auto mb-4 opacity-50" />
            <p>还没有添加任何文件夹</p>
            <p className="text-sm mt-1">点击上方按钮添加照片文件夹</p>
          </div>
        ) : (
          folders.map((folder) => (
            <div
              key={folder.id}
              className="p-4 bg-zinc-900 rounded-xl border border-zinc-800 hover:border-zinc-700 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <HardDrive size={16} className="text-zinc-500" />
                    <span className="text-sm text-zinc-300 truncate">
                      {formatPath(folder.path)}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-zinc-500">
                    <span>{folder.photo_count.toLocaleString()} 张照片</span>
                    <span className="flex items-center gap-1">
                      <Calendar size={12} />
                      {formatDate(folder.last_scanned)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleScan(folder.id)}
                    disabled={isScanning}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors',
                      'bg-zinc-800 hover:bg-zinc-700 text-zinc-300',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                  >
                    <RefreshCw size={14} className={isScanning ? 'animate-spin' : ''} />
                    扫描
                  </button>
                  <button
                    onClick={() => handleRemoveFolder(folder.id)}
                    className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
