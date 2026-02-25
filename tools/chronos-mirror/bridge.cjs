const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');

const _rootDir = path.resolve(__dirname, '../..');
const queueDir = pathResolver.shared('queue');
const inboxDir = path.join(queueDir, 'inbox');
const outboxDir = path.join(queueDir, 'outbox');

function safeJsonParse(str, fallback = {}) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const sendJson = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // 1. Request Queueing (Browser -> Agent)
  if (req.method === 'POST' && req.url === '/request') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = safeJsonParse(body, null);
        if (!payload || !payload.intent) {
          return sendJson(400, { error: 'Missing required field: intent' });
        }

        const msgId = `REQ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const message = {
          id: msgId,
          intent: payload.intent,
          context: payload.context || {},
          params: payload.params || {},
          timestamp: new Date().toISOString(),
          status: 'pending'
        };
        
        fs.writeFileSync(path.join(inboxDir, `${msgId}.json`), JSON.stringify(message, null, 2));
        console.log(`[Queue] Queued: ${msgId} - ${message.intent}`);
        
        sendJson(202, { status: 'accepted', id: msgId });
      } catch (err) {
        sendJson(400, { error: `Invalid Request: ${err.message}` });
      }
    });
  } 
  // 2. Fetch Responses (Agent -> Browser)
  else if (req.method === 'GET' && req.url === '/responses') {
    try {
      const files = fs.readdirSync(outboxDir).filter(f => f.endsWith('.json'));
      const responses = files.map(f => JSON.parse(fs.readFileSync(path.join(outboxDir, f), 'utf8')));
      responses.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      sendJson(200, responses);
    } catch (err) {
      sendJson(500, { error: 'Failed to fetch responses' });
    }
  }
  // 3. Fetch ACE Reports (Evidence -> Browser)
  else if (req.method === 'GET' && req.url === '/ace-reports') {
    const missionsDir = path.join(_rootDir, 'active/missions');
    const reports = [];
    
    if (fs.existsSync(missionsDir)) {
      const missions = fs.readdirSync(missionsDir).filter(f => fs.lstatSync(path.join(missionsDir, f)).isDirectory());
      missions.forEach(mission => {
        const reportPath = path.join(missionsDir, mission, 'ace-report.json');
        if (fs.existsSync(reportPath)) {
          try {
            reports.push(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
          } catch (_) { /* ignore corrupted */ }
        }
      });
    }
    sendJson(200, reports);
  }
  // 4. Fetch Skills Tree (Namespace -> Browser)
  else if (req.method === 'GET' && req.url === '/skills-tree') {
    const skillsRootDir = path.join(_rootDir, 'skills');
    const tree = {};
    
    if (fs.existsSync(skillsRootDir)) {
      const categories = fs.readdirSync(skillsRootDir).filter(f => {
        const full = path.join(skillsRootDir, f);
        return fs.lstatSync(full).isDirectory() && !f.startsWith('.');
      });
      categories.forEach(cat => {
        const catPath = path.join(skillsRootDir, cat);
        const skills = fs.readdirSync(catPath).filter(f => {
          const full = path.join(catPath, f);
          return fs.lstatSync(full).isDirectory() && !f.startsWith('.');
        });
        tree[cat] = skills;
      });
    }
    sendJson(200, tree);
  }
  // 5. Active Registry (Pulse -> Browser)
  else if (req.method === 'GET' && req.url === '/registry') {
    const registryPath = pathResolver.shared('tasks/parallel_registry.json');
    if (fs.existsSync(registryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        sendJson(200, data);
      } catch (err) {
        sendJson(500, { error: 'Failed to read registry' });
      }
    } else {
      sendJson(200, { missions: [] });
    }
  }
  else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const PORT = process.env.BRIDGE_PORT || 3030;
server.listen(PORT, () => {
  console.log(`\ud83c\udf09 Chronos Bridge v3.0 active on port ${PORT}`);
});
