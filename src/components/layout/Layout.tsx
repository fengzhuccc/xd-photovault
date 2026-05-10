import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function Layout() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Sidebar />
      <main className="ml-14 min-h-screen transition-all duration-300">
        <div className="h-full p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
