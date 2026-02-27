#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pathResolver = require('@agent/core/path-resolver');
const { safeJsonParse } = require('@agent/core/validators');

const PORT = 3030;
const _rootDir = pathResolver.rootDir();
const queueDir = pathResolver.shared('queue');
const inboxDir = path.join(queueDir, 'inbox');
const outboxDir = path.join(queueDir, 'outbox');

// Ensure queue directories exist
[inboxDir, outboxDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const sendJson = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // 1. Request Queueing (Browser -> Agent)
  if (req.method === 'POST' && req.url === '/request') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const payload = safeJsonParse(body, 'Bridge Request');

        // Simple manual validation (Architecture v1)
        if (!payload.intent) {
          return sendJson(400, { error: 'Missing required field: intent' });
        }

        const msgId = `REQ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const message = {
          id: msgId,
          intent: payload.intent,
          context: payload.context || {},
          params: payload.params || {},
          timestamp: new Date().toISOString(),
          status: 'pending',
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
      const files = fs.readdirSync(outboxDir).filter((f) => f.endsWith('.json'));
      const responses = files.map((f) =>
        JSON.parse(fs.readFileSync(path.join(outboxDir, f), 'utf8'))
      );
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
      const missions = fs.readdirSync(missionsDir);
      missions.forEach((mission) => {
        const reportPath = path.join(missionsDir, mission, 'ace-report.json');
        if (fs.existsSync(reportPath)) {
          try {
            reports.push(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
          } catch (_) {
            /* ignore corrupted */
          }
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
      const categories = fs.readdirSync(skillsRootDir).filter((f) => {
        const full = path.join(skillsRootDir, f);
        return fs.lstatSync(full).isDirectory() && !f.startsWith('.');
      });
      categories.forEach((cat) => {
        const catPath = path.join(skillsRootDir, cat);
        const skills = fs.readdirSync(catPath).filter((f) => {
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
      const registry = fs.readFileSync(registryPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(registry);
    } else {
      sendJson(200, { active: [] });
    }
  } else {
    sendJson(404, { error: 'Not Found' });
  }
});

server.listen(PORT, () => {
  console.log(`\n\u26d3 Gemini Omni-Queue Bridge active on http://localhost:${PORT}`);
});
