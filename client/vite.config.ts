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
      // The flowing-score engraver (~7 MB) is cached on first use instead
      // (see sw.js), so members who never open one don't download it.
      const built = Object.keys(bundle)
        .filter((f) => !f.endsWith('.map') && !/^assets\/verovio-/.test(f))
        .map((f) => `/${f}`);
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

/** pdf.js 5 decodes JBIG2 and JPEG 2000 images (scanned scores) with wasm
 *  modules it fetches by name from `wasmUrl` at runtime, so they can't go
 *  through Vite's hashed-import pipeline. Serve them from /pdfjs-wasm/ in
 *  dev and emit them unhashed into the build (which also precaches them). */
function pdfjsWasm(): Plugin[] {
  const srcDir = path.join(import.meta.dirname, 'node_modules', 'pdfjs-dist', 'wasm');
  const files = ['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm'];
  const types: Record<string, string> = { '.wasm': 'application/wasm', '.js': 'text/javascript' };
  return [{
    name: 'choirfriend-pdfjs-wasm-serve',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/pdfjs-wasm\/([^/?]+)/.exec(req.url ?? '');
        if (!m || !files.includes(m[1]!)) return next();
        res.setHeader('Content-Type', types[path.extname(m[1]!)] ?? 'application/octet-stream');
        fs.createReadStream(path.join(srcDir, m[1]!)).pipe(res);
      });
    },
  }, {
    name: 'choirfriend-pdfjs-wasm-emit',
    apply: 'build',
    // Emitted at build start so the service-worker plugin's generateBundle
    // sees them and adds them to the precache list.
    buildStart() {
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: `pdfjs-wasm/${f}`, source: fs.readFileSync(path.join(srcDir, f)) });
      }
    },
  }];
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker(), ...pdfjsWasm()],
  // Registered as /sw.js?v=<build>: Cloudflare caches /sw.js at the edge, so a
  // fresh URL per deploy is what makes devices pick up the new worker.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
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
