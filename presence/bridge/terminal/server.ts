import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ReflexTerminal } from '../../../libs/core/reflex-terminal.js';
import { logger } from '../../../libs/core/core.js';

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const ROOT_DIR = process.cwd();
const LAST_RESPONSE_PATH = path.join(ROOT_DIR, 'active/shared/last_response.json');

interface Session {
  id: string;
  rt: ReflexTerminal;
  ws: WebSocket | null;
  lastActive: number;
  captureBuffer: string;
  idleTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

app.use(express.static(path.join(ROOT_DIR, 'presence/bridge/terminal/static')));

// Helper: Strip ANSI and persist response for Slack/Nexus-Daemon
function persistFeedback(text: string) {
  try {
    // Remove ANSI escape sequences
    const cleanText = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r\n/g, '\n').trim();
    if (!cleanText || cleanText.length < 5) return;

    const envelope = {
      skill: 'terminal-hub',
      status: 'success',
      data: { message: cleanText },
      metadata: { timestamp: new Date().toISOString(), duration_ms: 0 }
    };
    fs.writeFileSync(LAST_RESPONSE_PATH, JSON.stringify(envelope, null, 2), 'utf8');
    logger.success(`[FEEDBACK] Captured response (${cleanText.length} chars)`);
  } catch (err: any) {
    logger.error(`[FEEDBACK] Save failed: ${err.message}`);
  }
}

// Helper: Typed input emulator
async function typeLine(rt: any, text: string) {
  const cleanText = text.replace(/[\r\n]/g, '');
  for (const char of cleanText) {
    rt.write(char);
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 100));
  rt.write('\r');
}

app.post('/inject', async (req, res) => {
  const { text, sessionId } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing "text"' });

  let target = sessionId ? sessions.get(sessionId) : Array.from(sessions.values()).sort((a,b) => b.lastActive - a.lastActive)[0];
  if (!target) return res.status(404).json({ error: 'No session' });

  if (target.ws) {
    target.ws.send(`\r\n\x1b[1;35m[API_INJECTION]: ${text}\x1b[0m\r\n`);
    target.ws.send(JSON.stringify({ type: 'ai_activity', active: true }));
  }

  await typeLine(target.rt, text);
  res.json({ status: 'success' });
});

function getOrCreateSession(id: string, cols: number, rows: number): Session {
  let session = sessions.get(id);
  if (session) return session;

  const newSession: Session = {
    id, rt: null as any, ws: null, lastActive: Date.now(), captureBuffer: ''
  };

  const rt = new ReflexTerminal({
    shell: process.env.SHELL || '/bin/bash',
    cols: cols || 80, rows: rows || 30,
    onOutput: (data) => {
      if (newSession.ws && newSession.ws.readyState === WebSocket.OPEN) newSession.ws.send(data);
      
      // Feedback Capture Logic
      newSession.captureBuffer += data;
      if (newSession.idleTimer) clearTimeout(newSession.idleTimer);
      newSession.idleTimer = setTimeout(() => {
        if (newSession.captureBuffer.length > 0) {
          persistFeedback(newSession.captureBuffer);
          newSession.captureBuffer = '';
          if (newSession.ws) newSession.ws.send(JSON.stringify({ type: 'ai_activity', active: false }));
        }
      }, 3500); // Wait for 3.5s of silence
    }
  });

  newSession.rt = rt;
  sessions.set(id, newSession);
  setTimeout(() => rt.write('/opt/homebrew/bin/gemini -y\r'), 3000);
  return newSession;
}

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const payload = JSON.parse(msg.toString());
      if (payload.type === 'init') {
        const session = getOrCreateSession(payload.sessionId || `s-${Date.now()}`, payload.cols, payload.rows);
        session.ws = ws;
        ws.send(JSON.stringify({ type: 'session_ready', sessionId: session.id }));
      } else if (payload.type === 'input') {
        const s = Array.from(sessions.values()).find(x => x.ws === ws);
        if (s) { s.rt.write(payload.data); s.lastActive = Date.now(); }
      }
    } catch (e) {}
  });
});

server.listen(4321, '0.0.0.0', () => {
  logger.success(`[API_HUB] Gemini Hub with Feedback Capture at http://localhost:4321`);
});
