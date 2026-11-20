'use strict';
/**
 * Local HTTP server for MintGuard (development + tests).
 *
 * Usage: node local-server.js [port]   (default port 8788)
 * Routes: GET /            -> serves public/index.html
 *         GET /api/health  -> { ok: true }
 *         POST /api/check  -> the checker
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { checkContract } = require('./src/checker');

const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/check') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch (_) {
        sendJson(res, 400, { error: 'invalid_json' });
        return;
      }
      const report = await checkContract(body);
      sendJson(res, 200, report);
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    console.error('[local-server] error:', err);
    sendJson(res, 502, { error: 'upstream_unavailable', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[mintguard] listening on http://localhost:${PORT}`);
});
