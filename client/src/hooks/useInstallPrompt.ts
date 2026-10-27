import { useEffect, useState } from 'react';

/**
 * Install support. Chrome/Edge/Samsung Internet fire `beforeinstallprompt`
 * (captured early in main.tsx so it is never missed); iOS Safari has no
 * prompt, so it gets instructions instead. Nothing is offered once the app
 * runs installed.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    __installPrompt?: BeforeInstallPromptEvent | null;
  }
}

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function useInstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(() => window.__installPrompt ?? null);
  const [installed, setInstalled] = useState(standalone);

  useEffect(() => {
    const onPrompt = () => setEvt(window.__installPrompt ?? null);
    const onInstalled = () => {
      setInstalled(true);
      setEvt(null);
    };
    window.addEventListener('choirfriend:installprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('choirfriend:installprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!evt) return;
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    window.__installPrompt = null;
    setEvt(null);
    if (outcome === 'accepted') setInstalled(true);
  };

  return {
    installed,
    canPrompt: !installed && !!evt,
    iosInstructions: !installed && !evt && isIos(),
    install,
  };
}
