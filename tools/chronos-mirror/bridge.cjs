#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pathResolver = require('@agent/core/path-resolver');

const PORT = 3030;
const _rootDir = path.resolve(__dirname, '../..');
const queueDir = pathResolver.shared('queue');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 1. 依頼のキューイング (Browser -> Agent)
  if (req.method === 'POST' && req.url === '/request') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      const msgId = `REQ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const payload = JSON.parse(body);
      
      const message = {
        id: msgId,
        intent: payload.intent,
        timestamp: new Date().toISOString(),
        status: 'pending'
      };
      
      fs.writeFileSync(path.join(queueDir, 'inbox', `${msgId}.json`), JSON.stringify(message, null, 2));
      console.log(`[Queue] Queued: ${msgId} - ${message.intent}`);
      
      res.writeHead(202); // Accepted
      res.end(JSON.stringify({ status: 'accepted', id: msgId }));
    });
  } 
  // 2. 全レスポンスの取得 (Agent -> Browser)
  else if (req.method === 'GET' && req.url === '/responses') {
    const outboxDir = path.join(queueDir, 'outbox');
    const files = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
    const responses = files.map(f => JSON.parse(fs.readFileSync(path.join(outboxDir, f), 'utf8')));
    
    // 時系列でソートして返す
    responses.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responses));
  }
  // 3. 実行中プロセス一覧の取得 (Pulse -> Browser)
  else if (req.method === 'GET' && req.url === '/registry') {
    const registryPath = pathResolver.shared('tasks/parallel_registry.json');
    if (fs.existsSync(registryPath)) {
      const registry = fs.readFileSync(registryPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(registry);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ active: [] }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`\n\u26d3 Gemini Omni-Queue active on http://localhost:${PORT}`);
});
