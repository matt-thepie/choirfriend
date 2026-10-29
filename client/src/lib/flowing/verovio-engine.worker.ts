/// <reference lib="webworker" />
import { perform, type Job } from './jobs.ts';

// Engraving a score takes ~18s on an old tablet; off the main thread the
// page stays tappable meanwhile. (Named verovio-… so the service worker
// caches it with the engraver rather than precaching it for everyone.)
self.onmessage = (e: MessageEvent<{ id: number; job: Job }>) => {
  const { id, job } = e.data;
  perform(job).then(
    (result) => self.postMessage({ id, result }),
    (err: unknown) => self.postMessage({ id, error: err instanceof Error ? err.message : String(err) }),
  );
};
