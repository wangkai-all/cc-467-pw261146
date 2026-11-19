import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventStore } from './store/event-store.js';
import { LineageService } from './domain/lineage-service.js';
import { createRouter } from './http/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR = process.env.LINEAGE_DATA_DIR ?? path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT ?? 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

const store = new EventStore(DATA_DIR);
const service = new LineageService(store);
await service.init();
const router = createRouter(service);

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return router(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`字段级血缘服务已启动: http://localhost:${PORT}`);
  console.log(`事件存储目录: ${DATA_DIR}`);
});
