import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as path from 'node:path';
import { ReflexTerminal } from '../../../libs/core/reflex-terminal.js';
import { 
  logger, 
  pathResolver, 
  safeReadFile, 
  safeWriteFile, 
  safeMkdir, 
  safeExistsSync, 
  safeUnlinkSync, 
  safeReaddir,
  safeAppendFileSync
} from '../../../libs/core/index.js';

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

interface Session {
  id: string;
  name: string;
  rt: ReflexTerminal;
  ws: WebSocket | null;
  lastActive: number;
  captureBuffer: string;
  backlog: string[];
  idleTimer?: NodeJS.Timeout;
  watcher?: any;
  active_brain?: string;
  syncPending?: boolean;
  current_stimulus_id?: string;
  paths: { base: string; in: string; out: string; state: string; };
}

const sessions = new Map<string, Session>();

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

function saveSessionState(session: Session) {
  try {
    safeWriteFile(session.paths.state, JSON.stringify({
      id: session.id, pid: session.rt.getPid(), ts: new Date().toISOString(),
      active: true, active_brain: session.active_brain || 'none', name: session.name
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

function getOrCreateSession(id: string, cols = 80, rows = 30): Session {
  let session = sessions.get(id);
  if (session) return session;

  const sessionBase = path.join(RUNTIME_BASE, id);
  const paths = { 
    base: sessionBase, 
    in: path.join(sessionBase, 'in'), 
    out: path.join(sessionBase, 'out'), 
    state: path.join(sessionBase, 'state.json') 
  };

  [paths.in, paths.out].forEach(d => {
    if (!safeExistsSync(d)) safeMkdir(d, { recursive: true });
  });

  const newSession: Session = { 
    id, name: `Session ${id}`, rt: null as any, ws: null, 
    lastActive: Date.now(), captureBuffer: '', backlog: [], paths 
  };

  const rt = new ReflexTerminal({
    shell: process.env.SHELL || '/bin/zsh', cols, rows, cwd: ROOT_DIR,
    onOutput: (data) => {
      newSession.backlog.push(data);
      if (newSession.backlog.length > 5000) newSession.backlog = newSession.backlog.slice(-5000);
      if (newSession.ws && newSession.ws.readyState === WebSocket.OPEN) newSession.ws.send(data);
      
      const plainText = cleanTerminalOutput(data);
      
      if (plainText.includes('Action Required') && (plainText.includes('Allow once') || data.includes('1.'))) {
        logger.info(`🛡️ [AutoPilot] Approving action in ${id}...`);
        newSession.rt.write('1\r');
        return;
      }
      if (plainText.includes('Waiting for auth')) {
        logger.info(`🛡️ [AutoPilot] Bypassing auth wait in ${id}...`);
        newSession.rt.write('\r');
        return;
      }

      const isDsrRes = data.includes('\x1b[1;1R');
      const isAiPrompt = plainText.includes('Type your message');

      if (newSession.syncPending && (isDsrRes || isAiPrompt)) {
        newSession.syncPending = false;
        if (newSession.idleTimer) clearTimeout(newSession.idleTimer);
        persistSessionFeedback(newSession, newSession.captureBuffer + data, true);
        newSession.captureBuffer = '';
        newSession.current_stimulus_id = undefined;
        return;
      }

      newSession.captureBuffer = updateSmartBuffer(newSession.captureBuffer, data);
      
      const promptDetected = /[%$#]>?\s*$/.test(plainText.trim());
      
      if (newSession.idleTimer) clearTimeout(newSession.idleTimer);
      
      const handleSettle = () => {
        if (newSession.captureBuffer.length > 0) { 
          persistSessionFeedback(newSession, newSession.captureBuffer); 
          newSession.captureBuffer = ''; 
        }
      };

      if (promptDetected && newSession.captureBuffer.length > 10) {
        logger.info(`⚡ [Reflex] Prompt detected in ${id}. Triggering immediate feedback.`);
        handleSettle();
      } else {
        newSession.idleTimer = setTimeout(handleSettle, 3000); 
      }

      emitGlobalStimulus(data, newSession);
    }
  });

  newSession.rt = rt;
  sessions.set(id, newSession);
  saveSessionState(newSession);
  setupSessionWatcher(newSession);
  return newSession;
}

wss.on('connection', (ws, req) => {
  let activeSession: Session | null = null;

  ws.on('message', (msg) => {
    try {
      const p = JSON.parse(msg.toString());
      if (p.type === 'init') {
        const id = p.sessionId || `s-${Date.now()}`;
        activeSession = getOrCreateSession(id, p.cols, p.rows);
        activeSession.ws = ws;
        ws.send(JSON.stringify({ type: 'session_ready', sessionId: id, name: activeSession.name }));
        ws.send(activeSession.backlog.join(''));
      } else if (p.type === 'input' && activeSession) {
        activeSession.rt.write(p.data);
        activeSession.lastActive = Date.now();
      } else if (p.type === 'resize' && activeSession) {
        activeSession.rt.resize(p.cols, p.rows);
      }
    } catch (_) {
      if (activeSession) activeSession.rt.write(msg.toString());
    }
  });

  ws.on('close', () => { if (activeSession) activeSession.ws = null; });
});

app.get('/sessions', (req, res) => { 
  res.json(Array.from(sessions.values()).map(s => ({ id: s.id, name: s.name, active_brain: s.active_brain }))); 
});

const PORT = process.env.TERMINAL_PORT || 4000;
server.listen(PORT, () => { 
  logger.info(`🌌 Terminal Hub v6.2 standardized on port ${PORT}`); 

  if (safeExistsSync(RUNTIME_BASE)) {
    const existing = safeReaddir(RUNTIME_BASE);
    for (const id of existing) {
      if (id.startsWith('s-')) {
        logger.info(`📡 [TerminalHub] Auto-restoring watcher for session: ${id}`);
        getOrCreateSession(id);
      }
    }
  }
});
