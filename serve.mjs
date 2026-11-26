import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('./public', import.meta.url));
const index = path.join(root, 'index.html');
if (!fs.existsSync(index) || !fs.existsSync(path.join(root, 'catalog.js'))) {
  console.error('Build the site first: node scripts/build.mjs');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  const file = pathname === '/' ? index : path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
});
server.listen(4219, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4219'));
