import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useAppStore } from '@/stores/appStore';
import { cn, isTypingTarget } from '@/lib/utils';

export function Layout() {
  const { sidebarCollapsed, setSidebarCollapsed } = useAppStore();
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;

      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;

      switch (e.key) {
        case '1':
          e.preventDefault();
          navigate('/');
          break;
        case '2':
          e.preventDefault();
          navigate('/browse');
          break;
        case '3':
          e.preventDefault();
          navigate('/duplicates');
          break;
        case '4':
          e.preventDefault();
          navigate('/map');
          break;
        case '5':
          e.preventDefault();
          navigate('/settings');
          break;
        case 'b':
        case 'B':
          e.preventDefault();
          setSidebarCollapsed(!sidebarCollapsed);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, sidebarCollapsed, setSidebarCollapsed]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />
      <main className={cn(
        'min-h-screen transition-all duration-300',
        sidebarCollapsed ? 'ml-16' : 'ml-56'
      )}>
        <div className="page-container">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
