import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Library,
  Images,
  Copy,
  Map,
  ChevronLeft,
  ChevronRight,
  Settings,
  Trash2
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', icon: Library, labelKey: 'nav.library' },
  { to: '/browse', icon: Images, labelKey: 'nav.browse' },
  { to: '/duplicates', icon: Copy, labelKey: 'nav.duplicates' },
  { to: '/map', icon: Map, labelKey: 'nav.map' },
  { to: '/trash', icon: Trash2, labelKey: 'nav.trash' },
];

export function Sidebar() {
  const { sidebarCollapsed, setSidebarCollapsed, stats, trashCount, loadTrashCount } = useAppStore();
  const { t } = useTranslation();

  useEffect(() => {
    loadTrashCount();
  }, [loadTrashCount]);

  const resetBrowseSearch = () => {
    useAppStore.setState({
      aiSearchQuery: '',
      aiSearchResults: [],
      aiSearchSimilarities: {},
      aiSearching: false,
    });
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 h-full bg-zinc-900 border-r border-zinc-800 transition-all duration-300 flex flex-col',
        sidebarCollapsed ? 'w-16' : 'w-56'
      )}
    >
      <div className="h-14 flex items-center justify-between px-4 border-b border-zinc-800">
        {!sidebarCollapsed && (
          <h1 className="text-lg font-semibold text-zinc-100">{t('nav.brand')}</h1>
        )}
        <button
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          className="icon-btn"
        >
          {sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="flex-1 py-4">
        {navItems.map(({ to, icon: Icon, labelKey }) => (
          <NavLink
            key={to}
            to={to}
            onClick={to === '/browse' ? resetBrowseSearch : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg transition-colors',
                isActive
                  ? 'bg-amber-500 text-zinc-950 shadow-sm'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
              )
            }
          >
            <Icon size={20} />
            {!sidebarCollapsed && <span className="text-sm font-medium">{t(labelKey)}</span>}
            {to === '/trash' && trashCount > 0 && !sidebarCollapsed && (
              <span className="ml-auto text-xs bg-amber-500 text-zinc-950 px-1.5 py-0.5 rounded-full font-semibold">
                {trashCount > 99 ? t('nav.badgeOverflow') : trashCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-zinc-800">
        {!sidebarCollapsed && stats && (
          <div className="p-4">
            <div className="text-xs text-zinc-400 space-y-1">
              <div className="flex justify-between">
                <span>{t('nav.totalPhotos')}</span>
                <span className="text-zinc-300">{stats.total.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('nav.withLocation')}</span>
                <span className="text-zinc-300">{stats.withLocation.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('nav.duplicatesCount')}</span>
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
                ? 'bg-amber-500 text-zinc-950 shadow-sm'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            )
          }
        >
          <Settings size={20} />
          {!sidebarCollapsed && <span className="text-sm font-medium">{t('nav.settings')}</span>}
        </NavLink>
      </div>
    </aside>
  );
}
