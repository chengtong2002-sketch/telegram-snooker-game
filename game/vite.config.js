import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Dev only: serve the TON Connect manifest with `url`/`iconUrl` pointing at
 * whatever host the page was actually opened on. A wallet app fetches this file
 * and signs its ton_proof for that domain, so behind a tunnel with a random
 * hostname (cloudflared) the static placeholder in public/ cannot work.
 * Production builds get theirs from buildTonConnectManifest() below.
 */
const devTonConnectManifest = () => ({
  name: 'dev-tonconnect-manifest',
  apply: 'serve',
  configureServer(server) {
    const base = JSON.parse(readFileSync(new URL('./public/tonconnect-manifest.json', import.meta.url), 'utf8'));
    server.middlewares.use('/tonconnect-manifest.json', (req, res) => {
      const proto = req.headers['x-forwarded-proto'] ?? 'http';
      const origin = `${proto}://${req.headers.host}`;
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', '*');
      res.end(JSON.stringify({ ...base, url: origin, iconUrl: `${origin}/icon-180.png` }));
    });
  },
});

/**
 * Build: write dist/tonconnect-manifest.json for GAME_PUBLIC_URL (the game's
 * https origin), replacing the public/ placeholder. Wallets refuse a manifest
 * whose url is not the page's origin, so on Railway a missing GAME_PUBLIC_URL
 * fails the build instead of shipping a game where wallet linking cannot work.
 */
const buildTonConnectManifest = () => ({
  name: 'build-tonconnect-manifest',
  apply: 'build',
  generateBundle() {
    const origin = process.env.GAME_PUBLIC_URL?.trim().replace(/\/+$/, '');
    if (!origin) {
      if (Object.keys(process.env).some((k) => k.startsWith('RAILWAY_'))) {
        this.error('GAME_PUBLIC_URL must be set (e.g. https://${{RAILWAY_PUBLIC_DOMAIN}}) so the TON Connect manifest names this site');
      }
      this.warn('GAME_PUBLIC_URL is not set: tonconnect-manifest.json keeps its placeholder url');
      return;
    }
    if (!origin.startsWith('https://')) this.error(`GAME_PUBLIC_URL must be https, got ${origin}`);
    const base = JSON.parse(readFileSync(new URL('./public/tonconnect-manifest.json', import.meta.url), 'utf8'));
    this.emitFile({
      type: 'asset',
      fileName: 'tonconnect-manifest.json',
      source: JSON.stringify({ ...base, url: origin, iconUrl: `${origin}/icon-180.png` }, null, 2),
    });
  },
});

export default defineConfig({
  plugins: [devTonConnectManifest(), buildTonConnectManifest()],
  server: {
    port: 5173,
    host: true,
    // cloudflared quick tunnels, for testing wallet linking over https.
    allowedHosts: ['.trycloudflare.com'],
    // Same-origin API in dev: an https tunnel page may not call an http backend.
    // Used when VITE_BACKEND_URL is set to an empty string.
    proxy: { '/api': 'http://localhost:8080' },
  },
  build: { target: 'es2022', outDir: 'dist', sourcemap: true },
  base: '/',
});
