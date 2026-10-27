import { useCallback, useEffect, useRef, useState } from 'react';
import { autoSyncAllowed, getScope, getStatus, offlineSupported, setScope, syncScores, type OfflineScope, type OfflineStatus, type SyncProgress } from '@/lib/offline.ts';

/** Offline score state for the menu, plus one automatic sync per app load. */
export function useOfflineScores(signedIn: boolean) {
  const [status, setStatus] = useState<OfflineStatus | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const running = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus());
    } catch {
      /* offline: keep the last status */
    }
  }, []);

  const sync = useCallback(
    async (scope?: OfflineScope) => {
      if (running.current || !offlineSupported) return;
      const s = scope ?? getScope();
      if (s === 'off') return;
      running.current = true;
      try {
        await syncScores(s, setProgress);
      } catch {
        /* network dropped; next sync picks up where this one stopped */
      } finally {
        running.current = false;
        setProgress(null);
        await refresh();
      }
    },
    [refresh],
  );

  const chooseScope = useCallback(
    async (scope: OfflineScope) => {
      setScope(scope);
      await refresh();
      if (scope !== 'off') void sync(scope);
    },
    [refresh, sync],
  );

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // Once per load, a few seconds in so it never competes with the first page.
  useEffect(() => {
    if (!signedIn || !offlineSupported) return;
    const t = window.setTimeout(() => {
      void refresh();
      if (autoSyncAllowed()) void sync();
    }, 4000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn]);

  return { status, progress, online, sync, chooseScope, refresh };
}
