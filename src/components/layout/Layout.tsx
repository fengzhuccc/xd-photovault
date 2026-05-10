import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';

export function Layout() {
  const { sidebarCollapsed } = useAppStore();
  
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />
      <main className={cn(
        'min-h-screen transition-all duration-300',
        sidebarCollapsed ? 'ml-16' : 'ml-56'
      )}>
        <div className="h-full p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
