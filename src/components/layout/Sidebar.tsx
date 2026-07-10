import { NavLink } from 'react-router-dom';
import { 
  Library, 
  Images, 
  Copy, 
  Map, 
  ChevronLeft,
  ChevronRight,
  Settings
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', icon: Library, label: '照片库' },
  { to: '/browse', icon: Images, label: '浏览' },
  { to: '/duplicates', icon: Copy, label: '去重' },
  { to: '/map', icon: Map, label: '地图' },
];

export function Sidebar() {
  const { sidebarCollapsed, setSidebarCollapsed, stats } = useAppStore();

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-full bg-zinc-900 border-r border-zinc-800 transition-all duration-300 flex flex-col',
        sidebarCollapsed ? 'w-16' : 'w-56'
      )}
    >
      <div className="h-14 flex items-center justify-between px-4 border-b border-zinc-800">
        {!sidebarCollapsed && (
          <h1 className="text-lg font-semibold text-amber-500">PhotoVault</h1>
        )}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="flex-1 py-4">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg transition-colors',
                isActive
                  ? 'bg-amber-500/10 text-amber-500'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              )
            }
          >
            <Icon size={20} />
            {!sidebarCollapsed && <span className="text-sm font-medium">{label}</span>}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-zinc-800">
        {!sidebarCollapsed && stats && (
          <div className="p-4">
            <div className="text-xs text-zinc-400 space-y-1">
              <div className="flex justify-between">
                <span>照片总数</span>
                <span className="text-zinc-300">{stats.total.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>有位置</span>
                <span className="text-zinc-300">{stats.withLocation.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>重复</span>
                <span className="text-amber-500">{stats.duplicates.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 px-4 py-2.5 mx-2 mb-2 rounded-lg transition-colors',
              isActive
                ? 'bg-amber-500/10 text-amber-500'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            )
          }
        >
          <Settings size={20} />
          {!sidebarCollapsed && <span className="text-sm font-medium">设置</span>}
        </NavLink>
      </div>
    </aside>
  );
}
