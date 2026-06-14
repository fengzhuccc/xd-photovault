import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { LibraryPage } from '@/pages/LibraryPage';
import { BrowsePage } from '@/pages/BrowsePage';
import { DuplicatesPage } from '@/pages/DuplicatesPage';
import { MapPage } from '@/pages/MapPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ToastContainer } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export default function App() {
  return (
    <Router>
      <ToastContainer />
      <ConfirmDialog />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<LibraryPage />} />
          <Route path="browse" element={<BrowsePage />} />
          <Route path="duplicates" element={<DuplicatesPage />} />
          <Route path="map" element={<MapPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </Router>
  );
}
