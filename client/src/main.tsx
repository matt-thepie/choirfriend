import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

// Service worker: installability plus offline shell and scores (client/sw/sw.js).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register(`/sw.js?v=${__BUILD_ID__}`).catch(() => {}));
}

// Keep Chrome's install prompt so the app can offer its own Install button.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__installPrompt = e as Window['__installPrompt'];
  window.dispatchEvent(new Event('choirfriend:installprompt'));
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
