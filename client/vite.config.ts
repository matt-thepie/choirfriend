import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Emits dist/sw.js from sw/sw.js with the build's precache list and a
 *  version hash prepended, so every deploy installs a fresh worker. */
function serviceWorker(): Plugin {
  const root = import.meta.dirname;
  const publicFiles = (dir: string): string[] =>
    fs.readdirSync(path.join(root, 'public', dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? publicFiles(path.join(dir, e.name)) : [`/${path.join(dir, e.name)}`],
    );
  return {
    name: 'choirfriend-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => !f.endsWith('.map')).map((f) => `/${f}`);
      const statics = ['brand', 'icons', 'piano'].flatMap(publicFiles).concat('/manifest.json');
      const precache = ['/', ...built, ...statics].sort();
      const src = fs.readFileSync(path.join(root, 'sw', 'sw.js'), 'utf8');
      const version = createHash('sha256').update(src).update(precache.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(precache)};\n${src}`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Forward API + auth calls to the Fastify server in dev.
      '/api': 'http://localhost:3001',
      '/auth': 'http://localhost:3001',
    },
  },
});
