import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

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
