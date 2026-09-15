import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Dev only: serve the TON Connect manifest with `url`/`iconUrl` pointing at
 * whatever host the page was actually opened on. A wallet app fetches this file
 * and signs its ton_proof for that domain, so behind a tunnel with a random
 * hostname (cloudflared) the static placeholder in public/ cannot work.
 * Production builds still ship public/tonconnect-manifest.json unchanged.
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

export default defineConfig({
  plugins: [devTonConnectManifest()],
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
