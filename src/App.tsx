import { useEffect, Suspense, lazy } from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { LibraryPage } from '@/pages/LibraryPage';
import { ToastContainer } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAppStore } from '@/stores/appStore';
import { toast } from '@/stores/toastStore';

// 非首屏页面懒加载，减少初始 bundle 体积
const BrowsePage = lazy(() => import('@/pages/BrowsePage'));
const DuplicatesPage = lazy(() => import('@/pages/DuplicatesPage'));
const MapPage = lazy(() => import('@/pages/MapPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));

function DuplicateProgressSubscriber() {
  const setDuplicateProgress = useAppStore(state => state.setDuplicateProgress);
  const loadDuplicates = useAppStore(state => state.loadDuplicates);
  const loadStats = useAppStore(state => state.loadStats);

  useEffect(() => {
    if (!window.api?.duplicate?.onProgress) {
      console.warn('[DuplicateProgressSubscriber] window.api.duplicate.onProgress 不可用');
      return;
    }

    const unsubscribe = window.api.duplicate.onProgress((progress) => {
      setDuplicateProgress(progress.stage === 'complete' ? null : progress);
      if (progress.stage === 'complete') {
        loadDuplicates().catch((error) => {
          console.error('[DuplicateProgressSubscriber] 加载去重结果失败:', error);
          toast('error', '去重结果加载失败');
        });
        loadStats().catch((error) => {
          console.error('[DuplicateProgressSubscriber] 刷新统计数据失败:', error);
        });
        toast('success', '去重检测完成');
      }
    });
    return () => unsubscribe();
  }, [setDuplicateProgress, loadDuplicates, loadStats]);

  return null;
}

function PageLoader() {
  return (
    <div className="h-full flex items-center justify-center text-zinc-400">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500" />
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <DuplicateProgressSubscriber />
      <ToastContainer />
      <ConfirmDialog />
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<LibraryPage />} />
            <Route path="browse" element={<BrowsePage />} />
            <Route path="duplicates" element={<DuplicatesPage />} />
            <Route path="map" element={<MapPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </Suspense>
    </Router>
  );
}
