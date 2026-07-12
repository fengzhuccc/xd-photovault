import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n'
import i18next from './i18n'
import { getStoredLanguage } from '@/lib/language'

declare global {
  interface Window {
    api: typeof import('../electron/preload').api;
  }
}

const rootEl = document.getElementById('root')!;

function logTiming(label: string) {
  // eslint-disable-next-line no-console
  console.log(`[Startup][Renderer] ${label}: ${Math.round(performance.now())}ms`);
}

logTiming('main.tsx executed');

window.addEventListener('DOMContentLoaded', () => {
  logTiming('DOMContentLoaded');
});

const app = <App />;
const root = createRoot(rootEl);

void (async () => {
  const stored = await getStoredLanguage();
  if (stored !== i18next.language) {
    await i18next.changeLanguage(stored);
  }

  if (import.meta.env.DEV) {
    root.render(
      <StrictMode>
        {app}
      </StrictMode>,
    );
  } else {
    root.render(app);
  }

  logTiming('React root rendered');
})();
