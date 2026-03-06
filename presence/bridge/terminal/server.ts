import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ReflexTerminal } from '../../../libs/core/reflex-terminal.js';
import { logger } from '../../../libs/core/core.js';

/**
 * Terminal Hub v4.3 (ESM-Fixed Sovereign Gateway)
 * Sessions are ONLY created when a browser (xterm.js) connects.
 */

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const ROOT_DIR = process.cwd();
const GLOBAL_STIMULI_PATH = path.join(ROOT_DIR, 'presence/bridge/runtime/stimuli.jsonl');
const RUNTIME_BASE = path.join(ROOT_DIR, 'active/shared/runtime/terminal');

interface Session {
  id: string;
  name: string;
  rt: ReflexTerminal;
  ws: WebSocket | null;
  lastActive: number;
  captureBuffer: string;
  backlog: string[];
  idleTimer?: NodeJS.Timeout;
  watcher?: any; // Dynamic import for chokidar
  paths: {
    base: string;
    in: string;
    out: string;
    state: string;
  };
}

const sessions = new Map<string, Session>();

app.use(express.static(path.join(ROOT_DIR, 'presence/bridge/terminal/static')));

function emitGlobalStimulus(text: string, sessionId: string) {
  try {
    const cleanText = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r\n/g, '\n').trim();
    if (!cleanText || cleanText.length < 5) return;
    const stimulus = {
      id: `term-${Date.now()}`,
      ts: new Date().toISOString(),
      ttl: 60,
      origin: { channel: 'terminal', source_id: sessionId },
      signal: { intent: 'broadcast', priority: 5, payload: cleanText },
      control: { status: 'processed', feedback: 'silent', evidence: [] }
    };
    fs.appendFileSync(GLOBAL_STIMULI_PATH, JSON.stringify(stimulus) + "\n");
  } catch (_) {}
}

function persistSessionFeedback(session: Session, text: string) {
  try {
    const cleanText = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r\n/g, '\n').trim();
    if (!cleanText) return;

    logger.info(`💾 [TerminalHub] Persisting feedback for ${session.id} (${cleanText.length} chars)`);

    const responseFile = path.join(session.paths.out, `res-${Date.now()}.json`);
    const envelope = {
      sessionId: session.id,
      status: 'success',
      data: { message: cleanText },
      metadata: { timestamp: new Date().toISOString() }
    };
    fs.writeFileSync(responseFile, JSON.stringify(envelope, null, 2), 'utf8');
    fs.writeFileSync(path.join(session.paths.out, 'latest_response.json'), JSON.stringify(envelope, null, 2), 'utf8');
    emitGlobalStimulus(cleanText, session.id);
  } catch (err: any) {
    logger.error(`[TerminalHub] Feedback error for ${session.id}: ${err.message}`);
  }
}

async function typeLine(rt: any, text: string) {
  const cleanText = text.replace(/[\r\n]/g, '');
  for (const char of cleanText) {
    rt.write(char);
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 100));
  rt.write('\r');
}

function stopSession(id: string) {
  const session = sessions.get(id);
  if (session) {
    logger.warn(`🛑 [TerminalHub] Closing session: ${id}`);
    if (session.watcher) session.watcher.close();
    session.rt.kill();
    if (fs.existsSync(session.paths.state)) fs.unlinkSync(session.paths.state);
    sessions.delete(id);
  }
}

async function setupSessionWatcher(session: Session) {
  const chokidar = await import('chokidar');
  session.watcher = chokidar.watch(session.paths.in, { persistent: true, ignoreInitial: true });
  session.watcher.on('add', (filePath: string) => {
    if (!filePath.endsWith('.json')) return;
    try {
      const request = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      typeLine(session.rt, request.text);
      fs.unlinkSync(filePath);
    } catch (e) {}
  });
}

function getOrCreateSession(id: string, cols = 80, rows = 30, name?: string): Session {
  let session = sessions.get(id);
  if (session) return session;

  const sessionBase = path.join(RUNTIME_BASE, id);
  const paths = {
    base: sessionBase,
    in: path.join(sessionBase, 'in'),
    out: path.join(sessionBase, 'out'),
    state: path.join(sessionBase, 'state.json')
  };

  [paths.base, paths.in, paths.out].forEach(p => {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });

  const newSession: Session = {
    id, name: name || `Session ${id}`, rt: null as any, ws: null, 
    lastActive: Date.now(), captureBuffer: '', backlog: [], paths
  };

  const rt = new ReflexTerminal({
    shell: process.env.SHELL || '/bin/zsh',
    cols, rows,
    onOutput: (data) => {
      newSession.backlog.push(data);
      if (newSession.backlog.length > 1000) newSession.backlog.shift();
      if (newSession.ws && newSession.ws.readyState === WebSocket.OPEN) newSession.ws.send(data);
      newSession.captureBuffer += data;
      
      if (newSession.idleTimer) clearTimeout(newSession.idleTimer);
      newSession.idleTimer = setTimeout(() => {
        if (newSession.captureBuffer.length > 0) {
          persistSessionFeedback(newSession, newSession.captureBuffer);
          newSession.captureBuffer = '';
        }
      }, 3000);
    }
  });

  newSession.rt = rt;
  sessions.set(id, newSession);
  fs.writeFileSync(paths.state, JSON.stringify({
    id, pid: (rt as any).ptyProcess.pid, ts: new Date().toISOString(), active: true
  }, null, 2));

  setupSessionWatcher(newSession);

  return newSession;
}

wss.on('connection', (ws) => {
  let assignedSessionId: string | null = null;

  ws.on('message', (msg) => {
    try {
      const payload = JSON.parse(msg.toString());
      if (payload.type === 'init') {
        assignedSessionId = payload.sessionId || `s-${Date.now()}`;
        const session = getOrCreateSession(assignedSessionId!, payload.cols, payload.rows, payload.name);
        session.ws = ws;
        ws.send(JSON.stringify({ type: 'session_ready', sessionId: session.id }));
      } else if (payload.type === 'input' && assignedSessionId) {
        const s = sessions.get(assignedSessionId);
        if (s) { s.rt.write(payload.data); s.lastActive = Date.now(); }
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (assignedSessionId) {
      const s = sessions.get(assignedSessionId);
      if (s) s.ws = null;
    }
  });
});

server.listen(4321, '0.0.0.0', () => {
  logger.success(`[TERMINAL-HUB] Sovereign Gateway active at http://localhost:4321`);
});
