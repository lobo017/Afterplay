import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithParent } from './lib/process-guard.mjs';
import { CANONICAL_HOST, canonicalRedirect } from './lib/canonical-origin.mjs';

// Harnesses that start this server set WC_EXIT_WITH_PARENT_PID, so the server goes away
// even if the harness is force-killed and can't clean up after itself.
exitWithParent(Number(process.env.WC_EXIT_WITH_PARENT_PID) || 0);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

const args = process.argv.slice(2);
let port = Number(process.env.PORT) || 4173;
const portFlagIndex = args.indexOf('--port');
if (portFlagIndex !== -1 && args[portFlagIndex + 1]) {
  port = Number(args[portFlagIndex + 1]);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.nnue': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const handleRequest = (req, res) => {
  // One origin, one game library: localhost / [::1] go to 127.0.0.1 (lib/canonical-origin.mjs)
  const redirect = canonicalRedirect(req.headers.host, req.url, port);
  if (redirect) {
    res.writeHead(307, { Location: redirect, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // Always set COOP/COEP headers required by multi-threaded Stockfish SharedArrayBuffer
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  const reqUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let pathname = decodeURIComponent(reqUrl.pathname);
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = path.join(distDir, safePath);

  if (!filePath.startsWith(distDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const indexFallback = path.join(distDir, 'index.html');
    if (fs.existsSync(indexFallback) && !path.extname(pathname)) {
      filePath = indexFallback;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Internal Server Error');
  });
  stream.pipe(res);
};

const server = http.createServer(handleRequest);

server.listen(port, CANONICAL_HOST, () => {
  console.log(`Wizard's Chess offline server running at http://${CANONICAL_HOST}:${port}`);
  console.log('COOP/COEP headers enabled (Cross-Origin Isolated).');
  console.log(`http://localhost:${port} redirects here (one origin, one game library).`);
});

// Browsers may resolve `localhost` to ::1 first. Listening there too means that name always
// reaches the redirect; where IPv6 loopback isn't available, the IPv4 fallback still does.
const ipv6Server = http.createServer(handleRequest);
ipv6Server.on('error', () => {
  ipv6Server.close();
});
ipv6Server.listen(port, '::1');
