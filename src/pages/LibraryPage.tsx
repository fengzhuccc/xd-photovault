import { useState, useEffect } from 'react';
import { FolderOpen, Plus, Trash2, RefreshCw, HardDrive, Calendar, ChevronDown, RotateCcw, Loader2, Brain, Pause, Play, Square, Zap, CheckCircle2, X } from 'lucide-react';
import Empty from '@/components/Empty';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn } from '@/lib/utils';

export function LibraryPage() {
  const {
    folders,
    scanProgress,
    scanningFolderId,
    isScanning,
    lastScanResult,
    aiIndexProgress,
    aiGpuEnabled,
    aiGpuActualProvider,
    loadFolders,
    loadStats,
    loadPhotosPage,
    loadTimeline,
    addFolder,
    removeFolder,
    setScanProgress,
    setScanningFolderId,
    clearLastScanResult,
    startAiIndex,
    pauseAiIndex,
    resumeAiIndex,
    cancelAiIndex,
    loadAiGpuStatus,
    toggleAiGpu,
  } = useAppStore();

  const [isAddingFolder, setIsAddingFolder] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [removingFolderId, setRemovingFolderId] = useState<string | null>(null);

  useEffect(() => {
    const start = performance.now();
    Promise.all([loadFolders(), loadStats(), loadAiGpuStatus()]).then(() => {
      // eslint-disable-next-line no-console
      console.log(`[Startup][Renderer] LibraryPage initial data loaded: ${Math.round(performance.now() - start)}ms`);
    });
  }, [loadFolders, loadStats, loadAiGpuStatus]);

  // ESC 关闭下拉菜单
  useEffect(() => {
    if (!openDropdown) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenDropdown(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openDropdown]);

  const handleAddFolder = async () => {
    setIsAddingFolder(true);
    try {
      const path = await window.api.dialog.openFolder();
      if (path) {
        const result = await window.api.folder.add(path);

        if (result.conflict) {
          if (result.conflict.type === 'child') {
            toast('info', `该文件夹已被包含在 "${result.conflict.childFolderPaths[0]}" 中，无需重复添加。`);
          } else if (result.conflict.type === 'parent') {
            const folderList = result.conflict.childFolderPaths.join('、');
            const confirmed = await confirm(
              `该文件夹包含已有的 ${result.conflict.childFolderPaths.length} 个子文件夹：\n${folderList}\n\n是否用父目录替换所有子目录？替换后子目录的索引将被删除，父目录将重新扫描。`,
              { variant: 'warning', confirmText: '替换' }
            );
            if (confirmed) {
              const replaceResult = await window.api.folder.replaceWithParent(result.conflict.childFolderIds, path);
              for (const childId of result.conflict.childFolderIds) {
                removeFolder(childId);
              }
              addFolder({
                id: replaceResult.id,
                path: replaceResult.path,
                added_at: new Date().toISOString(),
                last_scanned: null,
                photo_count: 0,
              });
            }
          }
        } else if (result.isNew) {
          addFolder({
            id: result.id,
            path: result.path,
            added_at: new Date().toISOString(),
            last_scanned: null,
            photo_count: 0,
          });
        }
      }
    } catch (error) {
      console.error('Add folder failed:', error);
      toast('error', `添加文件夹失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsAddingFolder(false);
    }
  };

  const handleScan = async (folderId: string, forceRescan: boolean = false) => {
    // 前端拦截：已有文件夹在扫描时，禁止再发起扫描
    if (scanningFolderId && scanningFolderId !== folderId) {
      toast('info', '已有文件夹正在扫描，请等待当前扫描完成。');
      return;
    }
    if (forceRescan && !await confirm('强制重新扫描将清除当前目录所有索引并重新扫描，确定继续吗？', { variant: 'warning' })) {
      return;
    }
    setOpenDropdown(null);
    setScanningFolderId(folderId);
    clearLastScanResult();
    setScanProgress({ current: 0, total: 0, currentFile: '', status: 'scanning' });
    try {
      await window.api.scan.start(folderId, forceRescan);
    } catch (error) {
      console.error('Scan failed:', error);
      setScanningFolderId(null);
      setScanProgress({ current: 0, total: 0, currentFile: '', status: 'idle' });
      toast('error', `扫描失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 不在 finally 中 setScanningFolderId(null)，由 onProgress 的 complete 事件控制
    // 也不在这里 loadFolders/loadStats，由 onProgress 的 complete 事件处理
  };

  const handleRemoveFolder = async (id: string) => {
    if (removingFolderId) return;
    if (await confirm('确定要移除此文件夹吗？照片索引将被删除，但原始文件不会被删除。', { variant: 'danger', confirmText: '删除' })) {
      setRemovingFolderId(id);
      try {
        await window.api.folder.remove(id);
        removeFolder(id);
      } catch (error) {
        console.error('Remove folder failed:', error);
        toast('error', `移除文件夹失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setRemovingFolderId(null);
      }
    }
  };

  const formatPath = (path: string) => {
    // 统一分隔符
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    // Windows 盘符（如 C:）始终保留
    const drive = parts[0] && /^[a-zA-Z]:$/.test(parts[0]) ? parts[0] : null;
    if (parts.length > 3) {
      const tail = parts.slice(-2).join('/');
      return drive ? `${drive}/.../${tail}` : `.../${tail}`;
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
    <div className="max-w-5xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">照片库</h1>
          <p className="page-subtitle">管理你的照片文件夹，扫描并建立索引</p>
        </div>
        <button
          onClick={handleAddFolder}
          disabled={isAddingFolder}
          className="btn-primary"
        >
          <Plus size={18} />
          添加文件夹
        </button>
      </div>

      {scanningFolderId && scanProgress && (
        <div className="card card-section mb-6">
          <div className="flex items-center gap-3 mb-3">
            <RefreshCw size={18} className="text-amber-500 animate-spin" />
            <span className="text-sm text-zinc-300">正在扫描...</span>
          </div>
          <div className="progress-bar mb-2">
            <div
              className="progress-bar-fill-amber"
              style={{ width: `${scanProgress.total > 0 ? (scanProgress.current / scanProgress.total) * 100 : 0}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-zinc-400">
            <span className="truncate mr-2">{scanProgress.currentFile}</span>
            <span>{scanProgress.current} / {scanProgress.total}</span>
          </div>
        </div>
      )}

      {lastScanResult && lastScanResult.status === 'complete' && (
        <div className="card card-section mb-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 size={18} className="text-green-500" />
              <span className="text-sm text-zinc-300">扫描完成</span>
            </div>
            <button
              onClick={() => clearLastScanResult()}
              className="icon-btn"
            >
              <X size={16} />
            </button>
          </div>
          <div className="flex gap-4 mt-2 text-xs text-zinc-400">
            {lastScanResult.newCount !== undefined && lastScanResult.newCount > 0 && (
              <span className="text-green-400">新增 {lastScanResult.newCount} 张</span>
            )}
            {lastScanResult.skipped !== undefined && lastScanResult.skipped > 0 && (
              <span>跳过 {lastScanResult.skipped} 张</span>
            )}
            {lastScanResult.deletedCount !== undefined && lastScanResult.deletedCount > 0 && (
              <span className="text-red-400">删除 {lastScanResult.deletedCount} 张</span>
            )}
            {lastScanResult.newCount === 0 && (lastScanResult.skipped ?? 0) === lastScanResult.total && (
              <span>未发现新照片</span>
            )}
          </div>
        </div>
      )}

      {/* AI 语义索引 */}
      <div className="card card-section mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <Brain size={18} className="text-amber-500" />
            <span className="text-sm text-zinc-300">AI 语义索引</span>
          </div>
          <div className="flex items-center gap-2">
            {(!aiIndexProgress || aiIndexProgress.status === 'idle' || aiIndexProgress.status === 'complete' || aiIndexProgress.status === 'error') && (
              <button
                onClick={startAiIndex}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                <Brain size={14} />
                建立索引
              </button>
            )}
            {(aiIndexProgress?.status === 'indexing' || aiIndexProgress?.status === 'pausing') && (
              <>
                <button
                  onClick={pauseAiIndex}
                  disabled={aiIndexProgress?.status === 'pausing'}
                  className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-50"
                >
                  <Pause size={14} />
                  {aiIndexProgress?.status === 'pausing' ? '暂停中' : '暂停'}
                </button>
                <button
                  onClick={cancelAiIndex}
                  className="btn-ghost text-xs px-3 py-1.5"
                >
                  <Square size={14} />
                  取消
                </button>
              </>
            )}
            {aiIndexProgress?.status === 'paused' && (
              <>
                <button
                  onClick={resumeAiIndex}
                  className="btn-secondary text-xs px-3 py-1.5"
                >
                  <Play size={14} />
                  继续
                </button>
                <button
                  onClick={cancelAiIndex}
                  className="btn-ghost text-xs px-3 py-1.5"
                >
                  <Square size={14} />
                  取消
                </button>
              </>
            )}
          </div>
        </div>
        {aiIndexProgress && ['loading', 'indexing', 'pausing', 'paused', 'error'].includes(aiIndexProgress.status) && (
          <>
            <div className="progress-bar mb-2">
              <div
                className={cn(
                  'progress-bar-fill',
                  aiIndexProgress.status === 'error' ? 'bg-red-500' :
                    aiIndexProgress.status === 'pausing' ? 'bg-amber-500' :
                      aiIndexProgress.status === 'paused' ? 'bg-zinc-500' : 'progress-bar-fill-amber'
                )}
                style={{ width: `${aiIndexProgress.total > 0 ? (aiIndexProgress.processed / aiIndexProgress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-zinc-400">
              <span className="truncate mr-2">{aiIndexProgress.message}</span>
              <span>{aiIndexProgress.processed.toLocaleString()} / {aiIndexProgress.total.toLocaleString()}</span>
            </div>
          </>
        )}
        {(!aiIndexProgress || aiIndexProgress.status === 'idle' || aiIndexProgress.status === 'complete') && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              建立索引后，可通过语义搜索照片内容。索引过程在后台运行，可随时暂停。
            </p>
            <label className="flex items-center justify-between p-3 bg-zinc-800 rounded-lg cursor-pointer hover:bg-zinc-700 transition-colors">
              <div className="flex items-center gap-2">
                <Zap size={14} className={cn('transition-colors', aiGpuEnabled ? 'text-amber-500' : 'text-zinc-500')} />
                <div className="flex flex-col">
                  <span className="text-xs text-zinc-300">GPU 加速索引</span>
                  <span className="text-xs text-zinc-400">
                    开启后使用 DirectML 调用显卡索引，失败会自动回退 CPU
                  </span>
                </div>
              </div>
              <div className="relative inline-flex items-center">
                <input
                  type="checkbox"
                  checked={aiGpuEnabled}
                  onChange={toggleAiGpu}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-amber-500" />
              </div>
            </label>
            {aiGpuEnabled && (
              <p className="text-xs text-zinc-400">
                当前执行器：{aiGpuActualProvider === 'dml' ? 'DirectML (GPU)' : 'CPU'}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-3">
        {folders.length === 0 ? (
          <Empty
            icon={FolderOpen}
            title="还没有添加任何文件夹"
            description="添加照片文件夹后，小呆相册会扫描并建立索引，方便你浏览、搜索和管理照片。"
            action={
              <button onClick={handleAddFolder} disabled={isAddingFolder} className="btn-primary">
                <Plus size={18} />
                添加文件夹
              </button>
            }
          />
        ) : (
          folders.map((folder) => {
            const isThisScanning = scanningFolderId === folder.id;
            const isThisRemoving = removingFolderId === folder.id;
            return (
              <div
                key={folder.id}
                className="card p-4 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <HardDrive size={16} className="text-zinc-500" />
                      <span className="text-sm text-zinc-300 truncate">
                        {formatPath(folder.path)}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-zinc-400">
                      <span>{folder.photo_count.toLocaleString()} 张照片</span>
                      <span className="flex items-center gap-1">
                        <Calendar size={12} />
                        {formatDate(folder.last_scanned)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <div className="flex">
                        <button
                          onClick={() => handleScan(folder.id, false)}
                          disabled={isScanning || isThisRemoving}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-l-lg text-sm transition-colors',
                            'bg-zinc-800 hover:bg-zinc-700 text-zinc-300',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                            'border-r border-zinc-700'
                          )}
                        >
                          {isThisScanning ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <RefreshCw size={14} />
                          )}
                          {isThisScanning ? '扫描中' : '扫描新增'}
                        </button>
                        <button
                          onClick={() => setOpenDropdown(openDropdown === folder.id ? null : folder.id)}
                          disabled={isScanning || isThisRemoving}
                          className={cn(
                            'px-1.5 py-1.5 rounded-r-lg text-sm transition-colors',
                            'bg-zinc-800 hover:bg-zinc-700 text-zinc-300',
                            'disabled:opacity-50 disabled:cursor-not-allowed'
                          )}
                        >
                          <ChevronDown size={14} />
                        </button>
                      </div>
                      {openDropdown === folder.id && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={() => setOpenDropdown(null)} />
                          <div className="absolute right-0 top-full mt-1 w-48 bg-zinc-800 rounded-lg border border-zinc-700 shadow-xl z-20 py-1">
                            <button
                              onClick={() => handleScan(folder.id, true)}
                              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors"
                            >
                              <RotateCcw size={14} />
                              强制重新扫描
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemoveFolder(folder.id)}
                      disabled={isThisRemoving || isScanning}
                      className="icon-btn text-zinc-500 hover:text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isThisRemoving ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
