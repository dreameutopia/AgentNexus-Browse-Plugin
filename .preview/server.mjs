import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.argv[2];
const port = Number(process.argv[3] || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

http
  .createServer(async (req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = path.join(root, url);
    try {
      const body = await readFile(target);
      res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  })
  .listen(port, () => console.log('preview server on http://localhost:' + port));
