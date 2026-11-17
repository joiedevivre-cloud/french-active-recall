// GitHub Pages has no server-side rewrite rules. For a BrowserRouter SPA,
// a direct URL hit (or a page refresh on a non-root route) requests a path
// that doesn't exist as a static file, so GitHub Pages serves dist/404.html.
// By making 404.html an exact copy of index.html, GitHub Pages ends up
// serving the same SPA shell for that request, and react-router then reads
// the real pathname from the browser and renders the right route client-side.
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const distDir = resolve(process.cwd(), 'dist');
copyFileSync(resolve(distDir, 'index.html'), resolve(distDir, '404.html'));
console.log('[copy-spa-fallback] dist/404.html written from dist/index.html');
