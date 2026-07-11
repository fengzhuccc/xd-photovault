import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AlertTriangle, Check, Trash2, Star, MapPin, Calendar, X, ChevronLeft, ChevronRight, RefreshCw, Loader2, Keyboard, CornerDownLeft, Images } from 'lucide-react';
import Empty from '@/components/Empty';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';
import { confirm } from '@/stores/confirmStore';
import { cn, isTypingTarget } from '@/lib/utils';
import type { DuplicateGroup, Photo } from '@/types';

export function DuplicatesPage() {
  const {
    duplicates,
    duplicatesTotal,
    duplicatesHasMore,
    duplicateProgress,
    duplicateReason,
    loadDuplicates,
    loadDuplicatesPage,
    loadStats,
    setDuplicateReason,
    setDuplicates,
    removePhotos,
    stats,
  } = useAppStore();

  // 组级选择
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  // 焦点组索引（键盘导航用），-1 表示无焦点
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  // 上次点击的组索引（Shift+Click 范围选择锚点）
  const [lastClickedIndex, setLastClickedIndex] = useState<number>(-1);

  // 组内手动保留集：groupId -> Set<photoId>。未出现的组使用默认（推荐项保留）
  const [manualKeep, setManualKeep] = useState<Record<string, Set<string>>>({});

  const [loadingMore, setLoadingMore] = useState(false);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);
  const [currentGroup, setCurrentGroup] = useState<DuplicateGroup | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // 用 ref 读取最新 thumbnails，避免缩略图加载 effect 依赖 thumbnails 导致每批更新都重算
  const thumbnailsRef = useRef(thumbnails);
  thumbnailsRef.current = thumbnails;

  const isDetecting = duplicateProgress !== null;
  const detectStage: 'exact' | 'similar' | 'hashing' | null = duplicateProgress
    ? (duplicateProgress.stage === 'exact'
        ? 'exact'
        : duplicateProgress.stage === 'hashing'
          ? 'hashing'
          : 'similar')
    : null;
  const detectProgress = duplicateProgress
    ? { current: duplicateProgress.current, total: duplicateProgress.total, message: duplicateProgress.message }
    : null;

  useEffect(() => {
    loadDuplicates();
  }, [loadDuplicates, duplicateReason]);

  // 切换 reason 或刷新后重置选择/焦点
  useEffect(() => {
    setSelectedGroups(new Set());
    setFocusedIndex(-1);
    setLastClickedIndex(-1);
    setManualKeep({});
  }, [duplicateReason, duplicatesTotal]);

  // 焦点越界保护
  useEffect(() => {
    if (focusedIndex >= duplicates.length) {
      setFocusedIndex(duplicates.length === 0 ? -1 : duplicates.length - 1);
    }
  }, [duplicates.length, focusedIndex]);

  useEffect(() => {
    // M-24: 添加取消标志，防止 duplicates 快速变化时过期请求覆盖当前结果
    let cancelled = false;
    const loadThumbnails = async () => {
      const allPhotos = duplicates.flatMap(g => g.photos);
      const missing = allPhotos.filter(p => !(p.id in thumbnailsRef.current));
      if (missing.length === 0) return;

      // 分批请求，避免单次 IPC 负载过大
      const BATCH = 100;
      for (let i = 0; i < missing.length; i += BATCH) {
        if (cancelled) return;
        const chunk = missing.slice(i, i + BATCH);
        const items = chunk.map(p => ({ photoId: p.id, photoPath: p.path, size: 'small' as const }));
        try {
          const batch = await window.api.thumbnail.getBatch(items);
          if (cancelled) return;
          setThumbnails(prev => ({ ...prev, ...batch }));
        } catch {
          // 加载失败时不显示随机占位图，保持默认占位等待下次重试
        }
      }
    };
    if (duplicates.length > 0) {
      loadThumbnails();
    }
    return () => { cancelled = true; };
  }, [duplicates]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !duplicatesHasMore) return;
    setLoadingMore(true);
    try {
      await loadDuplicatesPage(true);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, duplicatesHasMore, loadDuplicatesPage]);

  const handleReasonChange = useCallback((reason: 'all' | 'exact' | 'similar') => {
    setDuplicateReason(reason);
  }, [setDuplicateReason]);

  const handleDetectExact = useCallback(async () => {
    if (!await confirm('将重新检测所有完全相同的照片（基于文件内容哈希）。确定继续吗？', { variant: 'info', confirmText: '开始检测' })) {
      return;
    }
    try {
      const result = await window.api.duplicate.detectExact(true);
      if (!result.started) {
        if (result.reason === 'scanning') {
          toast('info', '扫描进行中，请等待扫描完成后再进行去重检测');
        } else {
          toast('info', '去重检测已在进行中，请勿重复点击');
        }
        return;
      }
      // 检测已实际开始，进度由 duplicate:progress 事件驱动；完成后由订阅器刷新列表
    } catch (error) {
      toast('error', '检测失败：' + error);
    }
  }, [confirm]);

  const handleDetectSimilar = useCallback(async () => {
    if (!await confirm(
      '相似去重会计算每张照片的感知哈希并比较视觉相似度，照片数量较多时可能需要数小时。\n\n建议在不需要使用应用时进行。确定继续吗？',
      { variant: 'warning', confirmText: '开始相似去重' }
    )) {
      return;
    }
    try {
      const result = await window.api.duplicate.detectSimilar(true);
      if (!result.started) {
        if (result.reason === 'scanning') {
          toast('info', '扫描进行中，请等待扫描完成后再进行去重检测');
        } else {
          toast('info', '去重检测已在进行中，请勿重复点击');
        }
        return;
      }
      // 检测已实际开始，进度由 duplicate:progress 事件驱动；完成后由订阅器刷新列表
    } catch (error) {
      toast('error', '检测失败：' + error);
    }
  }, [confirm]);

  // ===== 选择逻辑 =====

  const toggleGroup = useCallback((index: number, shiftKey: boolean) => {
    if (index < 0 || index >= duplicates.length) return;
    const group = duplicates[index];

    if (shiftKey && lastClickedIndex >= 0 && lastClickedIndex !== index) {
      // Shift+Click：范围选择，选中从锚点到当前的所有组
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      setSelectedGroups(prev => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) next.add(duplicates[i].id);
        return next;
      });
    } else {
      setSelectedGroups(prev => {
        const next = new Set(prev);
        if (next.has(group.id)) next.delete(group.id);
        else next.add(group.id);
        return next;
      });
    }
    setLastClickedIndex(index);
    setFocusedIndex(index);
  }, [duplicates, lastClickedIndex]);

  const selectAll = useCallback(() => {
    setSelectedGroups(new Set(duplicates.map(g => g.id)));
  }, [duplicates]);

  const deselectAll = useCallback(() => {
    setSelectedGroups(new Set());
  }, []);

  const invertSelection = useCallback(() => {
    setSelectedGroups(prev => {
      const next = new Set<string>();
      for (const g of duplicates) {
        if (!prev.has(g.id)) next.add(g.id);
      }
      return next;
    });
  }, [duplicates]);

  const moveFocus = useCallback((delta: number, shiftKey: boolean) => {
    if (duplicates.length === 0) return;
    setFocusedIndex(prev => {
      const next = prev + delta;
      if (next < 0 || next >= duplicates.length) return prev;

      // Shift+方向键：范围选择
      if (shiftKey && lastClickedIndex >= 0) {
        const start = Math.min(lastClickedIndex, next);
        const end = Math.max(lastClickedIndex, next);
        setSelectedGroups(cur => {
          const updated = new Set(cur);
          for (let i = start; i <= end; i++) updated.add(duplicates[i].id);
          return updated;
        });
      }

      // 滚动到焦点元素
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-group-index="${next}"]`);
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });

      return next;
    });
  }, [duplicates, lastClickedIndex]);

  // ===== 本地应用删除 =====
  // 删除照片后不重新加载整个列表（避免排序变化导致组跳动/消失、滚动位置丢失），
  // 而是本地更新 duplicates：从对应组移除已删除照片，组内剩余 ≤1 张时移除整个组。
  const applyPhotoDeletion = useCallback((deletedIds: string[]) => {
    if (deletedIds.length === 0) return;
    const deletedSet = new Set(deletedIds);
    const updated = duplicates
      .map(g => {
        const remaining = g.photos.filter(p => !deletedSet.has(p.id));
        if (remaining.length === g.photos.length) return g;
        const newRecommended = deletedSet.has(g.recommended_photo_id)
          ? (remaining[0]?.id ?? g.recommended_photo_id)
          : g.recommended_photo_id;
        return { ...g, photos: remaining, recommended_photo_id: newRecommended };
      })
      .filter(g => g.photos.length > 1);

    const removedGroupCount = duplicates.length - updated.length;
    setDuplicates(updated);
    if (removedGroupCount > 0) {
      useAppStore.setState(state => ({
        duplicatesTotal: Math.max(0, state.duplicatesTotal - removedGroupCount),
      }));
    }
    // 清理 manualKeep 中已删除的照片引用
    setManualKeep(prev => {
      const next: Record<string, Set<string>> = {};
      for (const [gid, photoIds] of Object.entries(prev)) {
        const filtered = new Set([...photoIds].filter(id => !deletedSet.has(id)));
        if (filtered.size > 0) next[gid] = filtered;
      }
      return next;
    });

    // 删除后若已加载列表变空但后端还有更多，自动加载下一页，避免误显示"没有重复照片"
    if (updated.length === 0 && useAppStore.getState().duplicatesHasMore) {
      loadDuplicatesPage(true).catch(() => { /* 忽略，用户可手动重试 */ });
    }
  }, [duplicates, setDuplicates, loadDuplicatesPage]);

  // ===== 组内保留逻辑 =====

  const isPhotoKept = useCallback((groupId: string, photoId: string, recommendedPhotoId: string) => {
    const manual = manualKeep[groupId];
    if (manual) return manual.has(photoId);
    return photoId === recommendedPhotoId;
  }, [manualKeep]);

  const toggleKeep = useCallback((groupId: string, photoId: string, recommendedPhotoId: string) => {
    setManualKeep(prev => {
      const current = prev[groupId] ?? new Set([recommendedPhotoId]);
      // 重复组内只能保留一张照片，再次点击已保留项时禁止取消
      if (current.has(photoId) && current.size <= 1) {
        toast('warning', '每组至少需要保留一张照片');
        return prev;
      }
      return { ...prev, [groupId]: new Set([photoId]) };
    });
  }, []);

  const getPhotosToDelete = useCallback((group: DuplicateGroup) => {
    return group.photos.filter(p => !isPhotoKept(group.id, p.id, group.recommended_photo_id));
  }, [isPhotoKept]);

  // 删除统计：选中组将删除的张数与释放空间
  const deleteStats = useMemo(() => {
    let count = 0;
    let size = 0;
    for (const group of duplicates) {
      if (selectedGroups.has(group.id)) {
        for (const photo of getPhotosToDelete(group)) {
          count++;
          size += photo.file_size;
        }
      }
    }
    return { count, size };
  }, [duplicates, selectedGroups, getPhotosToDelete]);

  // ===== 删除逻辑 =====

  const handleDeleteDuplicates = useCallback(async () => {
    // M-20: 重入守卫，防止重复点击导致多次删除
    if (isDeleting) return;
    const toDelete: string[] = [];
    for (const group of duplicates) {
      if (selectedGroups.has(group.id)) {
        for (const photo of getPhotosToDelete(group)) {
          toDelete.push(photo.id);
        }
      }
    }

    if (toDelete.length === 0) {
      toast('warning', '请先选择要处理的重复组');
      return;
    }

    if (!await confirm(`确定要删除 ${toDelete.length} 张重复照片吗？\n文件将被移动到回收站。`, { variant: 'danger', confirmText: '删除' })) {
      return;
    }

    setIsDeleting(true);
    try {
      await window.api.duplicate.delete(toDelete);
      applyPhotoDeletion(toDelete);
      removePhotos(toDelete);
      loadStats().catch((e) => console.error('[Duplicates] 删除后刷新统计失败:', e));
      setSelectedGroups(new Set());
    } catch (error) {
      toast('error', '删除失败：' + error);
    } finally {
      setIsDeleting(false);
    }
  }, [duplicates, selectedGroups, getPhotosToDelete, confirm, applyPhotoDeletion, removePhotos, loadStats, isDeleting]);

  const handleDeleteGroup = useCallback(async (group: DuplicateGroup) => {
    const toDelete = getPhotosToDelete(group);
    if (toDelete.length === 0) {
      toast('info', '该组没有可删除的照片');
      return;
    }
    if (!await confirm(`确定要删除该组中 ${toDelete.length} 张重复照片吗？\n文件将被移动到回收站。`, { variant: 'danger', confirmText: '删除' })) {
      return;
    }
    setIsDeleting(true);
    try {
      const ids = toDelete.map(p => p.id);
      await window.api.duplicate.delete(ids);
      applyPhotoDeletion(ids);
      removePhotos(ids);
      loadStats().catch((e) => console.error('[Duplicates] 删除后刷新统计失败:', e));
      setSelectedGroups(prev => {
        const next = new Set(prev);
        next.delete(group.id);
        return next;
      });
    } catch (error) {
      toast('error', '删除失败：' + error);
    } finally {
      setIsDeleting(false);
    }
  }, [getPhotosToDelete, confirm, applyPhotoDeletion, removePhotos, loadStats]);

  const handleDeleteCurrentPhoto = useCallback(async () => {
    if (!selectedPhoto || !currentGroup) return;
    if (isPhotoKept(currentGroup.id, selectedPhoto.id, currentGroup.recommended_photo_id)) {
      toast('warning', '该照片被标记为保留，无法删除');
      return;
    }
    if (!await confirm(`确定要删除这张照片吗？\n${selectedPhoto.filename}\n文件将被移动到回收站。`, { variant: 'danger', confirmText: '删除' })) {
      return;
    }
    try {
      await window.api.duplicate.delete([selectedPhoto.id]);
      applyPhotoDeletion([selectedPhoto.id]);
      removePhotos([selectedPhoto.id]);
      loadStats().catch((e) => console.error('[Duplicates] 删除后刷新统计失败:', e));
      setSelectedPhoto(null);
      setCurrentGroup(null);
      toast('success', '已删除');
    } catch (error) {
      toast('error', '删除失败：' + error);
    }
  }, [selectedPhoto, currentGroup, isPhotoKept, confirm, applyPhotoDeletion, removePhotos, loadStats]);

  // ===== 详情弹窗 =====

  const handlePhotoClick = useCallback((photo: Photo, group: DuplicateGroup, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedPhoto(photo);
    setCurrentGroup(group);
  }, []);

  const navigatePhoto = useCallback((direction: number) => {
    if (!selectedPhoto || !currentGroup) return;
    const currentIndex = currentGroup.photos.findIndex(p => p.id === selectedPhoto.id);
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < currentGroup.photos.length) {
      setSelectedPhoto(currentGroup.photos[newIndex]);
    }
  }, [selectedPhoto, currentGroup]);

  const closeDetail = useCallback(() => {
    setSelectedPhoto(null);
    setCurrentGroup(null);
  }, []);

  // ===== 全局快捷键 =====
  // 用 ref 存最新状态，避免依赖项过多导致频繁重绑定
  const stateRef = useRef({ selectedPhoto, currentGroup, showShortcuts, selectedGroups, focusedIndex, lastClickedIndex, duplicates, isDetecting });
  stateRef.current = { selectedPhoto, currentGroup, showShortcuts, selectedGroups, focusedIndex, lastClickedIndex, duplicates, isDetecting };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const s = stateRef.current;

      // 详情弹窗打开时优先处理
      if (s.selectedPhoto) {
        if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); navigatePhoto(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); navigatePhoto(1); }
        else if (e.key === 'Delete') { e.preventDefault(); handleDeleteCurrentPhoto(); }
        return;
      }

      // 快捷键帮助浮层打开时，仅响应 Esc
      if (s.showShortcuts) {
        if (e.key === 'Escape') { e.preventDefault(); setShowShortcuts(false); }
        return;
      }

      const isMod = e.ctrlKey || e.metaKey;

      // Esc：取消全选
      if (e.key === 'Escape') {
        if (s.selectedGroups.size > 0) {
          e.preventDefault();
          deselectAll();
        }
        return;
      }

      // Ctrl+A：全选
      if (isMod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }

      // Ctrl+I：反选
      if (isMod && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        invertSelection();
        return;
      }

      // Ctrl+E：触发精确检测
      if (isMod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        handleDetectExact();
        return;
      }

      // Delete：删除选中组
      if (e.key === 'Delete' && s.selectedGroups.size > 0) {
        e.preventDefault();
        handleDeleteDuplicates();
        return;
      }

      // ?：显示快捷键帮助（Shift+/ 或直接 ?）
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowShortcuts(true);
        return;
      }

      // 1/2/3：切换 全部/精确/相似（不与全局 Ctrl+1~5 切页冲突，因为这里无 isMod）
      if (!isMod && (e.key === '1' || e.key === '2' || e.key === '3')) {
        e.preventDefault();
        const reasons: Array<'all' | 'exact' | 'similar'> = ['all', 'exact', 'similar'];
        handleReasonChange(reasons[Number(e.key) - 1]);
        return;
      }

      // ↑/↓：移动焦点
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey);
        return;
      }

      // Space/Enter：切换焦点组选中态
      if ((e.key === ' ' || e.key === 'Enter') && s.focusedIndex >= 0) {
        e.preventDefault();
        toggleGroup(s.focusedIndex, e.shiftKey);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    closeDetail, navigatePhoto, handleDeleteCurrentPhoto,
    deselectAll, selectAll, invertSelection, handleDetectExact,
    handleDeleteDuplicates, handleReasonChange, moveFocus, toggleGroup,
  ]);

  const formatDate = useCallback((dateStr: string | null) => {
    if (!dateStr) return '未知';
    return new Date(dateStr).toLocaleDateString('zh-CN');
  }, []);

  const formatFileSize = useCallback((bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏：sticky 吸顶 */}
      <div className="sticky top-0 z-20 bg-zinc-950/95 backdrop-blur border-b border-zinc-800/50">
        <div className="page-header py-3 mb-0">
          <div>
            <h1 className="page-title">重复照片</h1>
            <p className="page-subtitle">
              发现 {duplicatesTotal.toLocaleString()} 组重复，共 {stats?.duplicates || 0} 张重复照片
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDetectExact}
              disabled={isDetecting}
              title="Ctrl+E"
              className={cn(
                'btn-secondary',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {isDetecting && detectStage === 'exact' ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              {isDetecting && detectStage === 'exact' ? '检测中...' : '精确去重'}
            </button>
            <button
              onClick={handleDetectSimilar}
              disabled={isDetecting}
              className={cn(
                'btn',
                'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {isDetecting && (detectStage === 'similar' || detectStage === 'hashing') ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <RefreshCw size={16} />
              )}
              {isDetecting && (detectStage === 'similar' || detectStage === 'hashing') ? '检测中...' : '相似去重'}
            </button>
            <div className="w-px h-6 bg-zinc-800 mx-1" />
            <button
              onClick={selectAll}
              title="Ctrl+A"
              className="btn-secondary"
            >
              全选
            </button>
            <button
              onClick={invertSelection}
              title="Ctrl+I"
              className="btn-secondary"
            >
              反选
            </button>
            <button
              onClick={deselectAll}
              title="Esc"
              className="btn-secondary"
            >
              取消全选
            </button>
            <button
              onClick={handleDeleteDuplicates}
              disabled={isDeleting || deleteStats.count === 0}
              title="Delete"
              className={cn(
                'btn-danger-solid',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {isDeleting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Trash2 size={16} />
              )}
              {isDeleting
                ? '删除中...'
                : deleteStats.count > 0
                  ? `删除重复 (${selectedGroups.size} 组 · ${deleteStats.count} 张 · ${formatFileSize(deleteStats.size)})`
                  : `删除重复 (${selectedGroups.size})`}
            </button>
            <button
              onClick={() => setShowShortcuts(true)}
              title="快捷键 (?)"
              className="icon-btn"
            >
              <Keyboard size={16} />
            </button>
          </div>
        </div>

        {/* 筛选标签栏 */}
        <div className="flex items-center gap-2 pb-3">
          {(['all', 'exact', 'similar'] as const).map((reason, idx) => (
            <button
              key={reason}
              onClick={() => handleReasonChange(reason)}
              disabled={isDetecting}
              title={`按 ${idx + 1}`}
              className={cn(
                'px-3 py-1.5 rounded-lg text-sm transition-colors',
                duplicateReason === reason
                  ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                  : 'bg-zinc-800/50 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {reason === 'all' && '全部'}
              {reason === 'exact' && '精确重复'}
              {reason === 'similar' && '相似重复'}
            </button>
          ))}
          <span className="text-xs text-zinc-600 ml-2">
            提示：点击卡片选择，Shift+点击范围选择，? 查看快捷键
          </span>
        </div>
      </div>

      {isDetecting && detectProgress && (
        <div className="card card-section mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-zinc-300">{detectProgress.message}</span>
            <span className="text-xs text-zinc-400">
              {detectProgress.total > 0 ? `${Math.round((detectProgress.current / detectProgress.total) * 100)}%` : ''}
            </span>
          </div>
          <div className="progress-bar">
            <div
              className={cn(
                'progress-bar-fill',
                detectStage === 'similar' ? 'progress-bar-fill-amber' : 'progress-bar-fill-blue'
              )}
              style={{
                width: detectProgress.total > 0 ? `${(detectProgress.current / detectProgress.total) * 100}%` : '0%'
              }}
            />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto pt-4">
        {duplicates.length === 0 ? (
          <Empty
            icon={Images}
            title="没有发现重复照片"
            description="你的照片库很干净！"
          />
        ) : (
          <div className="space-y-4">
            {duplicates.map((group, index) => (
              <DuplicateCard
                key={group.id}
                group={group}
                index={index}
                isSelected={selectedGroups.has(group.id)}
                isFocused={focusedIndex === index}
                isDeleting={isDeleting}
                thumbnails={thumbnails}
                formatDate={formatDate}
                formatFileSize={formatFileSize}
                onToggle={(idx, shift) => toggleGroup(idx, shift)}
                onPhotoClick={handlePhotoClick}
                isPhotoKept={(photoId) => isPhotoKept(group.id, photoId, group.recommended_photo_id)}
                onToggleKeep={(photoId) => toggleKeep(group.id, photoId, group.recommended_photo_id)}
                onDeleteGroup={() => handleDeleteGroup(group)}
              />
            ))}
            {duplicatesHasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className={cn(
                    'btn-secondary',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  {loadingMore ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      加载中...
                    </>
                  ) : (
                    '加载更多'
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      {selectedPhoto && currentGroup && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center">
          <button
            onClick={closeDetail}
            className="icon-btn absolute top-4 right-4 z-10"
            title="关闭 (Esc)"
          >
            <X size={20} />
          </button>

          <button
            onClick={() => navigatePhoto(-1)}
            disabled={currentGroup.photos.findIndex(p => p.id === selectedPhoto.id) === 0}
            className="icon-btn absolute left-4 disabled:opacity-30 disabled:cursor-not-allowed"
            title="上一张 (←)"
          >
            <ChevronLeft size={24} />
          </button>

          <button
            onClick={() => navigatePhoto(1)}
            disabled={currentGroup.photos.findIndex(p => p.id === selectedPhoto.id) === currentGroup.photos.length - 1}
            className="icon-btn absolute right-4 disabled:opacity-30 disabled:cursor-not-allowed"
            title="下一张 (→)"
          >
            <ChevronRight size={24} />
          </button>

          <div className="flex h-full w-full">
            <div className="flex-1 flex items-center justify-center p-4">
              <img
                src={`file:///${selectedPhoto.path.replace(/\\/g, '/')}`}
                alt={selectedPhoto.filename}
                className="max-w-full max-h-full object-contain"
              />
            </div>

            <div className="w-64 bg-zinc-900/95 border-l border-zinc-800 p-4 overflow-auto">
              <h3 className="text-base font-medium text-zinc-100 mb-3 truncate">{selectedPhoto.filename}</h3>

              <div className="space-y-3">
                <div>
                  <label className="text-xs text-zinc-400 uppercase tracking-wider">文件路径</label>
                  <div className="mt-1.5 p-2 bg-zinc-800 rounded text-xs text-zinc-300 break-all">
                    {selectedPhoto.path}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-400 uppercase tracking-wider">文件信息</label>
                  <div className="mt-1.5 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-400">大小</span>
                      <span className="text-zinc-200">{formatFileSize(selectedPhoto.file_size)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-400">分辨率</span>
                      <span className="text-zinc-200">{selectedPhoto.width} × {selectedPhoto.height}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-400 uppercase tracking-wider">拍摄信息</label>
                  <div className="mt-1.5 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-zinc-400">日期</span>
                      <span className={cn(
                        selectedPhoto.taken_at ? 'text-zinc-200' : 'text-zinc-500 italic'
                      )}>
                        {formatDate(selectedPhoto.taken_at)}
                      </span>
                    </div>
                    {selectedPhoto.camera && (
                      <div className="flex justify-between">
                        <span className="text-zinc-400">相机</span>
                        <span className="text-zinc-200">{selectedPhoto.camera}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <label className="text-xs text-zinc-400 uppercase tracking-wider">位置</label>
                  <div className="mt-1.5">
                    {selectedPhoto.latitude && selectedPhoto.longitude ? (
                      <div className="flex items-center gap-2 text-sm text-zinc-200">
                        <MapPin size={14} className="text-green-500" />
                        <span>
                          {selectedPhoto.latitude.toFixed(4)}, {selectedPhoto.longitude.toFixed(4)}
                        </span>
                      </div>
                    ) : (
                      <div className="p-2 bg-zinc-800 rounded text-center">
                        <p className="text-xs text-zinc-400">此照片没有GPS信息</p>
                      </div>
                    )}
                  </div>
                </div>

                {selectedPhoto.id === currentGroup.recommended_photo_id && (
                  <div className="p-2 bg-amber-500/10 rounded-lg border border-amber-500/30">
                    <div className="flex items-center gap-2 text-amber-500 text-sm">
                      <Star size={14} />
                      <span>推荐保留</span>
                    </div>
                  </div>
                )}

                {/* 保留/删除操作 */}
                <div className="pt-2 space-y-2">
                  <button
                    onClick={() => toggleKeep(currentGroup.id, selectedPhoto.id, currentGroup.recommended_photo_id)}
                    className={cn(
                      'w-full btn',
                      isPhotoKept(currentGroup.id, selectedPhoto.id, currentGroup.recommended_photo_id)
                        ? 'bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 border border-amber-500/30'
                        : 'btn-secondary'
                    )}
                  >
                    <Star size={14} className={isPhotoKept(currentGroup.id, selectedPhoto.id, currentGroup.recommended_photo_id) ? 'fill-current' : ''} />
                    {isPhotoKept(currentGroup.id, selectedPhoto.id, currentGroup.recommended_photo_id) ? '已标记保留' : '标记为保留'}
                  </button>
                  {!isPhotoKept(currentGroup.id, selectedPhoto.id, currentGroup.recommended_photo_id) && (
                    <button
                      onClick={handleDeleteCurrentPhoto}
                      disabled={isDeleting}
                      title="Delete"
                      className="w-full btn-danger disabled:opacity-50"
                    >
                      <Trash2 size={14} />
                      删除此照片
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 快捷键帮助浮层 */}
      {showShortcuts && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
          onClick={() => setShowShortcuts(false)}
        >
          <div
            className="card card-section max-w-lg w-full mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
                <Keyboard size={18} />
                键盘快捷键
              </h2>
              <button
                onClick={() => setShowShortcuts(false)}
                className="icon-btn"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4 text-sm">
              <div>
                <div className="text-xs text-zinc-400 uppercase tracking-wider mb-2">选择</div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                  <Kbd>Ctrl+A</Kbd><span className="text-zinc-300">全选已加载组</span>
                  <Kbd>Ctrl+I</Kbd><span className="text-zinc-300">反选</span>
                  <Kbd>Esc</Kbd><span className="text-zinc-300">取消全选</span>
                  <Kbd>Shift+Click</Kbd><span className="text-zinc-300">范围选择（从上次点击到当前）</span>
                  <Kbd>↑ / ↓</Kbd><span className="text-zinc-300">移动焦点</span>
                  <Kbd>Shift+↑/↓</Kbd><span className="text-zinc-300">范围选择（从锚点到焦点）</span>
                  <Kbd>Space / Enter</Kbd><span className="text-zinc-300">切换焦点组选中态</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 uppercase tracking-wider mb-2">操作</div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                  <Kbd>Delete</Kbd><span className="text-zinc-300">删除选中组的重复照片</span>
                  <Kbd>1 / 2 / 3</Kbd><span className="text-zinc-300">切换 全部 / 精确 / 相似</span>
                  <Kbd>Ctrl+E</Kbd><span className="text-zinc-300">触发精确检测</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 uppercase tracking-wider mb-2">详情弹窗</div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                  <Kbd>← / →</Kbd><span className="text-zinc-300">上一张 / 下一张</span>
                  <Kbd>Esc</Kbd><span className="text-zinc-300">关闭弹窗</span>
                  <Kbd>Delete</Kbd><span className="text-zinc-300">删除当前照片（非保留项）</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-zinc-400 uppercase tracking-wider mb-2">其他</div>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                  <Kbd>?</Kbd><span className="text-zinc-300">显示 / 隐藏本帮助</span>
                </div>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-zinc-800 text-xs text-zinc-400 flex items-center gap-2">
              <CornerDownLeft size={12} />
              <span>点击空白处或按 Esc 关闭</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-2 py-0.5 bg-zinc-800 rounded text-xs text-zinc-300 border border-zinc-700 font-mono whitespace-nowrap">
      {children}
    </kbd>
  );
}

interface DuplicateCardProps {
  group: DuplicateGroup;
  index: number;
  isSelected: boolean;
  isFocused: boolean;
  isDeleting: boolean;
  thumbnails: Record<string, string>;
  formatDate: (date: string | null) => string;
  formatFileSize: (bytes: number) => string;
  onToggle: (index: number, shiftKey: boolean) => void;
  onPhotoClick: (photo: Photo, group: DuplicateGroup, e: React.MouseEvent) => void;
  isPhotoKept: (photoId: string) => boolean;
  onToggleKeep: (photoId: string) => void;
  onDeleteGroup: () => void;
}

function DuplicateCard({
  group,
  index,
  isSelected,
  isFocused,
  isDeleting,
  thumbnails,
  formatDate,
  formatFileSize,
  onToggle,
  onPhotoClick,
  isPhotoKept,
  onToggleKeep,
  onDeleteGroup,
}: DuplicateCardProps) {
  const keptCount = group.photos.filter(p => isPhotoKept(p.id)).length;
  const toDeleteCount = group.photos.length - keptCount;

  return (
    <div
      data-group-index={index}
      tabIndex={0}
      role="button"
      aria-selected={isSelected}
      className={cn(
        'card card-section transition-colors cursor-pointer outline-none',
        isSelected
          ? 'border-amber-500/50'
          : 'hover:border-zinc-700',
        isFocused && 'ring-2 ring-amber-500/40 ring-offset-2 ring-offset-zinc-950'
      )}
      onClick={(e) => onToggle(index, e.shiftKey)}
      onKeyDown={(e) => {
        // 卡片自身键盘处理交给全局监听，这里仅阻止默认行为避免滚动
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
        }
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <div
          className={cn(
            'w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0',
            isSelected
              ? 'bg-amber-500 border-amber-500'
              : 'border-zinc-600'
          )}
        >
          {isSelected && <Check size={12} className="text-zinc-900" />}
        </div>
        <span className="text-sm text-zinc-400">
          {group.reason === 'exact' ? '完全相同' : '相似'} · {group.photos.length} 张 · 保留 {keptCount} / 删除 {toDeleteCount}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onDeleteGroup(); }}
            disabled={isDeleting || toDeleteCount === 0}
            title={`删除本组重复照片（${toDeleteCount} 张）`}
            className={cn(
              'btn-danger text-xs px-2 py-1',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            <Trash2 size={12} />
            删除本组 ({toDeleteCount})
          </button>
        </div>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {group.photos.map((photo) => {
          const kept = isPhotoKept(photo.id);
          const isRecommended = photo.id === group.recommended_photo_id;
          return (
            <div
              key={photo.id}
              className={cn(
                'flex-shrink-0 w-40 rounded-lg overflow-hidden border-2 transition-colors',
                kept ? 'border-amber-500' : 'border-transparent'
              )}
            >
              <div
                className="aspect-square relative cursor-pointer hover:opacity-80 transition-opacity group"
                onClick={(e) => onPhotoClick(photo, group, e)}
              >
                {thumbnails[photo.id] ? (
                  <img
                    src={thumbnails[photo.id]}
                    alt={photo.filename}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full skeleton flex items-center justify-center">
                    <Loader2 size={20} className="text-zinc-500 animate-spin" />
                  </div>
                )}

                {/* 保留切换按钮：右上角，可点击 */}
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleKeep(photo.id); }}
                  className={cn(
                    'absolute top-2 right-2 p-1.5 rounded-full transition-all z-10',
                    kept
                      ? 'bg-amber-500 text-zinc-900 hover:bg-amber-400'
                      : 'bg-black/50 text-zinc-400 hover:bg-black/70 hover:text-zinc-200 opacity-80 group-hover:opacity-100'
                  )}
                  title={kept ? '已标记保留（点击取消保留）' : '未保留（点击标记为保留）'}
                >
                  <Star size={12} className={kept ? 'fill-current' : ''} />
                </button>

                {/* 推荐标记：左上角小标签 */}
                {isRecommended && (
                  <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-amber-500/90 rounded text-xs text-zinc-900 font-medium z-10">
                    推荐
                  </div>
                )}

                <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-2 pointer-events-none">
                  <p className="text-xs text-zinc-200 text-center break-all">{photo.path}</p>
                </div>
              </div>
              <div className="p-2 bg-zinc-800">
                <p className="text-xs text-zinc-300 truncate" title={photo.path}>{photo.filename}</p>
                <p className="text-xs text-zinc-400 truncate mt-0.5" title={photo.path}>
                  {photo.path.split(/[\\/]/).slice(-2, -1)[0] || ''}
                </p>
                <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                  <Calendar size={10} />
                  {formatDate(photo.taken_at)}
                </div>
                {photo.latitude && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-green-500">
                    <MapPin size={10} />
                    有位置
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-xs text-zinc-400 flex items-center gap-2">
        <AlertTriangle size={12} className="inline" />
        <span>点击右上角星标选择要保留的照片，每组仅保留一张，未选中的照片将被删除。带"推荐"标签为系统推荐保留项。</span>
      </div>
    </div>
  );
}

export default DuplicatesPage;
