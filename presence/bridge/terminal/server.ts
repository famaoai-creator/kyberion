import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'node:path';
import {
  ReflexTerminal,
  logger, 
  pathResolver, 
  runtimeSupervisor,
  safeReadFile, 
  safeWriteFile, 
  safeMkdir, 
  safeRmSync,
  safeExistsSync, 
  safeUnlinkSync, 
  safeReaddir,
  safeAppendFileSync
} from '@agent/core';
import {
  buildSessionPaths,
  listPersistedSessionStates,
  mergeSessionSummaries,
  normalizeSessionName,
  readPersistedSessionState,
} from './session-utils.js';

/**
 * Terminal Hub v6.2 [STANDARDIZED]
 * Observability, Session Persistence, and Secure-IO Compliance.
 */

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const ROOT_DIR = pathResolver.rootDir();
const GLOBAL_STIMULI_PATH = path.join(ROOT_DIR, 'presence/bridge/runtime/stimuli.jsonl');
const RUNTIME_BASE = path.join(ROOT_DIR, 'active/shared/runtime/terminal');
const TERMINAL_TOKEN = process.env.KYBERION_TERMINAL_TOKEN || process.env.KYBERION_API_TOKEN;
const ALLOW_REMOTE = process.env.KYBERION_TERMINAL_ALLOW_REMOTE === 'true';
const DISCONNECT_TIMEOUT_MS = Number(process.env.KYBERION_TERMINAL_DISCONNECT_TIMEOUT_MS || 5 * 60 * 1000);
const RESTORE_RUNTIME_ON_BOOT = process.env.KYBERION_TERMINAL_RESTORE_RUNTIME === 'true';
const SESSION_RETENTION_MS = Number(process.env.KYBERION_TERMINAL_SESSION_RETENTION_MS || 7 * 24 * 60 * 60 * 1000);

interface Session {
  id: string;
  name: string;
  rt: ReflexTerminal | null;
  ws: WebSocket | null;
  lastActive: number;
  captureBuffer: string;
  backlog: string[];
  idleTimer?: NodeJS.Timeout;
  disconnectTimer?: NodeJS.Timeout;
  watcher?: any;
  active_brain?: string;
  syncPending?: boolean;
  current_stimulus_id?: string;
  createdAt: string;
  paths: { base: string; in: string; out: string; state: string; };
}

const sessions = new Map<string, Session>();

function getClientIp(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function extractToken(req: any): string | null {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    return url.searchParams.get('token');
  } catch (_) {
    return null;
  }
}

function authorizeRequest(req: any): { ok: boolean; status: number; reason: string } {
  const ip = getClientIp(req);
  const isLocal = isLoopback(ip);
  if (isLocal) return { ok: true, status: 200, reason: 'local' };

  if (!TERMINAL_TOKEN) {
    if (ALLOW_REMOTE) return { ok: true, status: 200, reason: 'remote_allowed' };
    return { ok: false, status: 403, reason: 'Remote access disabled. Set KYBERION_TERMINAL_ALLOW_REMOTE=true or provide KYBERION_TERMINAL_TOKEN.' };
  }

  const token = extractToken(req);
  if (token === TERMINAL_TOKEN) return { ok: true, status: 200, reason: 'token' };
  return { ok: false, status: 401, reason: 'Unauthorized. Provide Authorization: Bearer <token> or ?token=' };
}

app.use((req, res, next) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.reason });
  }
  return next();
});

app.use(express.static(path.join(ROOT_DIR, 'presence/bridge/terminal/static')));

function cleanTerminalOutput(text: string): string {
  if (!text) return "";
  let scrubbed = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x1b && code !== 0x7f)) {
      scrubbed += text[i];
    }
  }
  return scrubbed
    .replace(/\[[0-9;]*[a-zA-Z]/g, '') 
    .replace(/\][0-9;]*.*?\x07/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[─│╭╮╰╯─━┃┏┓┗┛]/g, '') 
    .replace(/\n{3,}/g, '\n\n').trim();
}

function updateSmartBuffer(currentBuffer: string, newData: string): string {
  const cleanNew = cleanTerminalOutput(newData);
  if (!cleanNew) return currentBuffer;

  const oldLines = currentBuffer.split('\n').map(l => l.trim());
  const newLines = cleanNew.split('\n').map(l => l.trim());
  
  let combined = [...oldLines];
  for (const line of newLines) {
    if (combined.length === 0 || combined[combined.length - 1] !== line) {
      combined.push(line);
    }
  }
  
  const structured = combined.filter(l => l.length === 0 || l.length > 2);
  return structured.slice(-20).join('\n');
}

function saveSessionState(session: Session, active = Boolean(session.rt)) {
  try {
    safeWriteFile(session.paths.state, JSON.stringify({
      id: session.id, pid: session.rt?.getPid(), ts: new Date().toISOString(),
      active,
      active_brain: session.active_brain || 'none',
      name: session.name,
      lastActive: session.lastActive,
      createdAt: session.createdAt,
      connected: Boolean(session.ws && session.ws.readyState === WebSocket.OPEN),
    }, null, 2));
  } catch (_) {}
}

function persistSessionFeedback(session: Session, text: string, skipBroadcast = false) {
  try {
    const cleanText = cleanTerminalOutput(text);
    if (!cleanText || cleanText.length < 10) return;

    const responseFile = path.join(session.paths.out, `res-${Date.now()}.json`);
    const envelope = {
      sessionId: session.id, status: 'success', data: { message: cleanText },
      metadata: { timestamp: new Date().toISOString() }
    };
    
    safeWriteFile(responseFile, JSON.stringify(envelope, null, 2));
    safeWriteFile(path.join(session.paths.out, 'latest_response.json'), JSON.stringify(envelope, null, 2));
    
    if (session.current_stimulus_id) {
      safeWriteFile(path.join(session.paths.out, 'latest_metadata.json'), JSON.stringify({
        stimulus_id: session.current_stimulus_id, ts: new Date().toISOString()
      }, null, 2));
    }

    if (!skipBroadcast) emitGlobalStimulus(cleanText, session);
  } catch (_) {}
}

function emitGlobalStimulus(text: string, session: Session) {
  if (session.syncPending) return;
  try {
    const cleanText = cleanTerminalOutput(text);
    if (!cleanText || cleanText.length < 5) return;
    
    const isExecutionFinished = /[%$#]>?\s*$/.test(cleanText.trim());
    
    const stimulus = {
      id: `term-${Date.now()}`, ts: new Date().toISOString(), ttl: 60,
      origin: { channel: 'terminal', source_id: session.id },
      signal: { 
        intent: isExecutionFinished ? 'EXECUTION_FINISHED' : 'LOG_STREAM', 
        priority: 5, 
        payload: cleanText 
      },
      control: { status: 'processed', feedback: 'silent', evidence: [] }
    };
    const stimuliFile = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
    safeAppendFileSync(stimuliFile, JSON.stringify(stimulus) + "\n");
  } catch (_) {}
}

async function typeLine(session: Session, text: string, useSync = true) {
  if (!session.rt) return;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\n' || char === '\r') {
      session.rt.write('\r');
    } else {
      session.rt.write(char);
    }
    await new Promise(r => setTimeout(r, 15));
  }
  
  await new Promise(r => setTimeout(r, 100));
  session.rt.write('\r');
  await new Promise(r => setTimeout(r, 50));
  session.rt.write('\r');

  if (useSync) {
    session.syncPending = true;
    session.rt.write('\x1b[6n'); 
  }
}

async function setupSessionWatcher(session: Session) {
  if (session.watcher || !session.rt) return;
  const chokidar = await import('chokidar');
  session.watcher = chokidar.watch(session.paths.in, { persistent: true, ignoreInitial: true });
  session.watcher.on('add', (filePath: string) => {
    if (!filePath.endsWith('.json')) return;
    try {
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const request = JSON.parse(content);
      if (request.text) { 
        typeLine(session, request.text); 
      } else if (request.stimulus_id) {
        session.current_stimulus_id = request.stimulus_id;
        const requestedBrain = request.brain_profile || 'default';
        
        let bootCommand = 'gemini -y';
        try {
          const registryPath = pathResolver.resolve('knowledge/orchestration/brain-profiles.json');
          if (safeExistsSync(registryPath)) {
            const registry = JSON.parse(safeReadFile(registryPath, { encoding: 'utf8' }) as string);
            const profileKey = requestedBrain === 'default' ? registry.default_profile : requestedBrain;
            const profile = registry.profiles[profileKey] || registry.profiles[registry.default_profile];
            if (profile) bootCommand = `${profile.cmd} ${profile.args.join(' ')}`;
          }
        } catch (_) {}

        if (bootCommand && session.active_brain !== requestedBrain) {
          typeLine(session, bootCommand);
          session.active_brain = requestedBrain;
          saveSessionState(session);
        }
      }
      safeUnlinkSync(filePath);
    } catch (_) {}
  });
}

function destroySessionRuntime(session: Session, reason: string) {
  logger.info(`[TerminalHub] Reaping terminal session ${session.id} (${reason})`);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
  session.idleTimer = undefined;
  session.disconnectTimer = undefined;
  try {
    session.watcher?.close?.();
  } catch (_) {}
  session.watcher = undefined;
  session.ws = null;
  if (session.rt) {
    session.rt.kill();
    session.rt = null;
  }
  session.lastActive = Date.now();
  saveSessionState(session, false);
}

function prunePersistedSessionState() {
  const now = Date.now();
  for (const state of listPersistedSessionStates(RUNTIME_BASE)) {
    const lastActive = state.lastActive || 0;
    const isExpired = lastActive > 0 && now - lastActive > SESSION_RETENTION_MS;
    if (!isExpired || state.connected || state.active) continue;
    const paths = buildSessionPaths(RUNTIME_BASE, state.id);
    logger.info(`[TerminalHub] Pruning stale terminal session ${state.id}`);
    try {
      safeRmSync(paths.base, { recursive: true, force: true });
    } catch (_) {}
    sessions.delete(state.id);
  }
}

function scheduleDisconnectCleanup(session: Session) {
  if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
  session.disconnectTimer = setTimeout(() => {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      destroySessionRuntime(session, 'disconnect_timeout');
    }
  }, DISCONNECT_TIMEOUT_MS);
  session.disconnectTimer.unref?.();
}

function attachRuntime(session: Session, cols = 80, rows = 30) {
  if (session.rt) return;

  const rt = new ReflexTerminal({
    shell: process.env.SHELL || '/bin/zsh', cols, rows, cwd: ROOT_DIR,
    onOutput: (data) => {
      session.backlog.push(data);
      if (session.backlog.length > 5000) session.backlog = session.backlog.slice(-5000);
      if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(data);

      const plainText = cleanTerminalOutput(data);

      if (plainText.includes('Action Required') && (plainText.includes('Allow once') || data.includes('1.'))) {
        logger.info(`🛡️ [AutoPilot] Approving action in ${session.id}...`);
        session.rt?.write('1\r');
        return;
      }
      if (plainText.includes('Waiting for auth')) {
        logger.info(`🛡️ [AutoPilot] Bypassing auth wait in ${session.id}...`);
        session.rt?.write('\r');
        return;
      }

      const isDsrRes = data.includes('\x1b[1;1R');
      const isAiPrompt = plainText.includes('Type your message');

      if (session.syncPending && (isDsrRes || isAiPrompt)) {
        session.syncPending = false;
        if (session.idleTimer) clearTimeout(session.idleTimer);
        persistSessionFeedback(session, session.captureBuffer + data, true);
        session.captureBuffer = '';
        session.current_stimulus_id = undefined;
        return;
      }

      session.captureBuffer = updateSmartBuffer(session.captureBuffer, data);

      const promptDetected = /[%$#]>?\s*$/.test(plainText.trim());

      if (session.idleTimer) clearTimeout(session.idleTimer);

      const handleSettle = () => {
        if (session.captureBuffer.length > 0) {
          persistSessionFeedback(session, session.captureBuffer);
          session.captureBuffer = '';
        }
      };

      if (promptDetected && session.captureBuffer.length > 10) {
        logger.info(`⚡ [Reflex] Prompt detected in ${session.id}. Triggering immediate feedback.`);
        handleSettle();
      } else {
        session.idleTimer = setTimeout(handleSettle, 3000);
      }

      emitGlobalStimulus(data, session);
    }
  });

  session.rt = rt;
  saveSessionState(session);
  setupSessionWatcher(session);
}

function hydratePersistedSession(id: string, requestedName?: string): Session {
  const paths = buildSessionPaths(RUNTIME_BASE, id);
  const persisted = readPersistedSessionState(paths.state);

  [paths.in, paths.out].forEach(d => {
    if (!safeExistsSync(d)) safeMkdir(d, { recursive: true });
  });

  return {
    id,
    name: normalizeSessionName(requestedName || persisted?.name, id),
    rt: null,
    ws: null,
    lastActive: persisted?.lastActive || Date.now(),
    captureBuffer: '',
    backlog: [],
    active_brain: persisted?.active_brain || 'none',
    createdAt: persisted?.createdAt || new Date().toISOString(),
    paths
  };
}

function listSessionSummaries() {
  const persisted = listPersistedSessionStates(RUNTIME_BASE);
  const runtime = Array.from(sessions.values()).map(session => ({
    id: session.id,
    name: session.name,
    active_brain: session.active_brain || 'none',
    lastActive: session.lastActive,
    connected: Boolean(session.ws && session.ws.readyState === WebSocket.OPEN),
  }));

  return mergeSessionSummaries(persisted, runtime);
}

function getOrCreateSession(id: string, cols = 80, rows = 30, requestedName?: string): Session {
  let session = sessions.get(id);
  if (session) {
    const nextName = normalizeSessionName(requestedName || session.name, id);
    if (session.name !== nextName) {
      session.name = nextName;
      saveSessionState(session);
    }
    if (!session.rt) {
      attachRuntime(session, cols, rows);
    }
    return session;
  }

  const newSession = hydratePersistedSession(id, requestedName);
  sessions.set(id, newSession);
  attachRuntime(newSession, cols, rows);
  return newSession;
}

wss.on('connection', (ws, req) => {
  const auth = authorizeRequest(req);
  if (!auth.ok) {
    ws.close(1008, auth.reason);
    return;
  }
  let activeSession: Session | null = null;

  ws.on('message', (msg) => {
    try {
      const p = JSON.parse(msg.toString());
      if (p.type === 'init') {
        const id = p.sessionId || `s-${Date.now()}`;
         activeSession = getOrCreateSession(id, p.cols, p.rows, p.name);
         if (activeSession.disconnectTimer) clearTimeout(activeSession.disconnectTimer);
         activeSession.disconnectTimer = undefined;
         activeSession.ws = ws;
         activeSession.lastActive = Date.now();
         saveSessionState(activeSession);
         ws.send(JSON.stringify({ type: 'session_ready', sessionId: id, name: activeSession.name }));
         ws.send(activeSession.backlog.join(''));
       } else if (p.type === 'input' && activeSession) {
         if (!activeSession.rt) attachRuntime(activeSession);
         activeSession.rt?.write(p.data);
         activeSession.lastActive = Date.now();
         saveSessionState(activeSession);
       } else if (p.type === 'resize' && activeSession) {
         if (!activeSession.rt) attachRuntime(activeSession, p.cols, p.rows);
         activeSession.rt?.resize(p.cols, p.rows);
       }
    } catch (_) {
      if (activeSession) {
        if (!activeSession.rt) attachRuntime(activeSession);
        activeSession.rt?.write(msg.toString());
      }
    }
  });

  ws.on('close', () => {
    if (activeSession) {
      activeSession.ws = null;
      activeSession.lastActive = Date.now();
      saveSessionState(activeSession);
      scheduleDisconnectCleanup(activeSession);
    }
  });
});

app.get('/sessions', (req, res) => { 
  res.json(listSessionSummaries()); 
});

app.get('/health', (req, res) => {
  const runtimeResources = runtimeSupervisor.snapshot();
  const runtimeByKind = runtimeResources.reduce<Record<string, number>>((acc, record) => {
    acc[record.kind] = (acc[record.kind] || 0) + 1;
    return acc;
  }, {});

  res.json({
    ok: true,
    liveSessions: Array.from(sessions.values()).filter(session => Boolean(session.rt)).length,
    persistedSessions: listPersistedSessionStates(RUNTIME_BASE).length,
    runtimeResources: runtimeResources.length,
    runtimeByKind,
    timestamp: new Date().toISOString(),
  });
});

app.get('/runtime', (req, res) => {
  res.json({
    resources: runtimeSupervisor.snapshot().map((record) => ({
      resourceId: record.resourceId,
      kind: record.kind,
      ownerId: record.ownerId,
      ownerType: record.ownerType,
      pid: record.pid,
      state: record.state,
      shutdownPolicy: record.shutdownPolicy,
      idleForMs: record.idleForMs,
      metadata: record.metadata || {},
    })),
    timestamp: new Date().toISOString(),
  });
});

app.post('/sessions', (req, res) => {
  const requestedId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const id = requestedId || `s-${Date.now()}`;
  const requestedName = typeof req.body?.name === 'string' ? req.body.name : undefined;
  const session = getOrCreateSession(id, 80, 30, requestedName);
  saveSessionState(session);
  res.status(201).json({
    id: session.id,
    name: session.name,
    active_brain: session.active_brain || 'none',
    lastActive: session.lastActive,
    connected: Boolean(session.ws && session.ws.readyState === WebSocket.OPEN),
  });
});

const PORT = Number(process.env.TERMINAL_PORT || 4000);
const HOST = process.env.KYBERION_TERMINAL_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => { 
  logger.info(`🌌 Terminal Hub v6.2 standardized on port ${PORT}`); 

  if (safeExistsSync(RUNTIME_BASE)) {
    prunePersistedSessionState();
    const existing = listPersistedSessionStates(RUNTIME_BASE);
    for (const session of existing) {
      const hydrated = hydratePersistedSession(session.id, session.name);
      sessions.set(session.id, hydrated);
      if (RESTORE_RUNTIME_ON_BOOT && session.active) {
        logger.info(`📡 [TerminalHub] Restoring runtime for session: ${session.id}`);
        attachRuntime(hydrated, 80, 30);
      }
    }
  }
});
