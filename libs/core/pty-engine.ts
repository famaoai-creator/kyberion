import * as pty from 'node-pty';
import { spawn as spawnChild, ChildProcess } from 'node:child_process';
import { logger } from './core.js';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { runtimeSupervisor } from './runtime-supervisor.js';

/**
 * Kyberion PTY Engine (Logical Kernel) v2.1
 * Manages persistent terminal sessions with native PTY or ChildProcess fallback.
 * Includes support for dynamic resizing.
 */

export interface PtySession {
  id: string;
  adapter: TerminalAdapter;
  buffer: string;
  status: 'running' | 'exited';
  exitCode?: number;
  lastUpdated: number;
}

interface TerminalAdapter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  pid?: number;
}

class NativePtyAdapter implements TerminalAdapter {
  constructor(private pty: pty.IPty) {}
  write(data: string) { this.pty.write(data); }
  resize(cols: number, rows: number) { this.pty.resize(cols, rows); }
  kill() { this.pty.kill(); }
  onData(cb: (data: string) => void) { this.pty.onData(cb); }
  onExit(cb: (code: number | null, signal: string | null) => void) {
    this.pty.onExit(({ exitCode, signal }) => cb(exitCode, String(signal ?? '')));
  }
  get pid() { return this.pty.pid; }
}

class ChildProcessAdapter implements TerminalAdapter {
  constructor(private child: ChildProcess) {}
  write(data: string) { this.child.stdin?.write(data); }
  resize(_cols: number, _rows: number) { /* Emulated terminal does not support resize */ }
  kill() { this.child.kill(); }
  onData(cb: (data: string) => void) {
    this.child.stdout?.on('data', (d) => cb(d.toString()));
    this.child.stderr?.on('data', (d) => cb(d.toString()));
  }
  onExit(cb: (code: number | null, signal: string | null) => void) {
    this.child.on('exit', cb);
  }
  get pid() { return this.child.pid; }
}

export interface InSessionMessage {
  from: string;
  to: string;
  payload: any;
  ts: number;
}

class PtyRegistry {
  private sessions: Map<string, PtySession> = new Map();
  private threadToSession: Map<string, string> = new Map(); // Mapping: threadId -> sessionId
  private messageBus: Map<string, InSessionMessage[]> = new Map(); // Key: threadId
  private readonly DSR_REQ = /\x1b\[\??6n/g;
  private readonly DSR_RES = '\x1b[1;1R';
  private readonly idleTimeoutMs = Number(process.env.KYBERION_PTY_IDLE_TIMEOUT_MS || 15 * 60 * 1000);

  private detachThread(sessionId: string): void {
    for (const [threadId, mappedSessionId] of this.threadToSession.entries()) {
      if (mappedSessionId === sessionId) {
        this.threadToSession.delete(threadId);
      }
    }
  }

  /**
   * Cleans ANSI escape sequences. Conservative approach to avoid text loss.
   */
  private cleanSemanticBuffer(input: string): string {
    // 1. Strip colors, formatting, and cursor position/clear sequences
    // Matches: [m (color), [H (home), [J (clear screen), [K (clear line), etc.
    let text = input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    
    // 2. Handle backspaces
    while (text.includes('\b')) {
      text = text.replace(/[^\b]\b/g, '');
    }

    // 3. Remove leading/trailing empty lines often caused by TUI redraws
    return text.trim();
  }

  /**
   * Pushes a message to the in-session bus for a specific thread.
   */
  public pushMessage(threadId: string, from: string, to: string, payload: any) {
    if (!this.messageBus.has(threadId)) {
      this.messageBus.set(threadId, []);
    }
    this.messageBus.get(threadId)!.push({ from, to, payload, ts: Date.now() });
    logger.info(`[ISM] Message pushed to thread ${threadId}: From ${from} To ${to}`);
  }

  /**
   * Pops messages addressed to a specific persona in a thread.
   */
  public popMessages(threadId: string, persona: string): InSessionMessage[] {
    const threadMessages = this.messageBus.get(threadId) || [];
    const forPersona = threadMessages.filter(m => m.to === persona || m.to === '*');
    
    // Remove the popped messages from the original bus
    const remaining = threadMessages.filter(m => !(m.to === persona || m.to === '*'));
    if (remaining.length === 0) {
      this.messageBus.delete(threadId);
    } else {
      this.messageBus.set(threadId, remaining);
    }

    return forPersona;
  }

  /**
   * Waits for a specific pattern or a quiet period in the session buffer.
   */
  public async waitFor(id: string, pattern: string | RegExp, timeoutMs: number = 30000, quietMs: number = 500): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);

    const startTime = Date.now();
    let lastBufferLength = 0;
    let lastChangeTime = Date.now();

    return new Promise((resolve, reject) => {
      const check = () => {
        const buffer = session.buffer;
        const semanticBuffer = this.cleanSemanticBuffer(buffer);
        const now = Date.now();

        // Check if buffer length changed
        if (buffer.length !== lastBufferLength) {
          lastBufferLength = buffer.length;
          lastChangeTime = now;
        }

        const match = typeof pattern === 'string' 
          ? (pattern === '' ? false : semanticBuffer.includes(pattern)) 
          : pattern.test(semanticBuffer);

        // Success if match OR process exited
        if ((match && (now - lastChangeTime >= quietMs)) || session.status === 'exited') {
          const output = this.cleanSemanticBuffer(session.buffer);
          session.buffer = ''; // Logical consume
          resolve(output);
          return;
        }

        if (now - startTime > timeoutMs) {
          reject(new Error(`Timeout waiting for pattern: ${pattern}`));
          return;
        }

        setTimeout(check, 100);
      };
      check();
    });
  }

  public spawn(shell?: string, args: string[] = [], cwd?: string, env: Record<string, string> = {}, threadId?: string): string {
    // Check if threadId already has an active session
    if (threadId && this.threadToSession.has(threadId)) {
      const existingId = this.threadToSession.get(threadId)!;
      const session = this.sessions.get(existingId);
      if (session && session.status === 'running') {
        logger.info(`[PTY_ENGINE] Re-attaching to existing thread: ${threadId} (Session: ${existingId})`);
        return existingId;
      }
    }

    const id = crypto.randomUUID();
    if (threadId) this.threadToSession.set(threadId, id);
    const targetShell = shell || (os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
    const targetCwd = cwd || process.cwd();
    const targetEnv = { ...process.env, ...env, TERM: 'xterm-256color', PAGER: 'cat' };

    let adapter: TerminalAdapter;

    try {
      const ptyInstance = pty.spawn(targetShell, args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: targetCwd,
        env: targetEnv
      });
      adapter = new NativePtyAdapter(ptyInstance);
      logger.info(`[PTY_ENGINE] Session ${id} started with Native PTY`);
    } catch (err: any) {
      const child = spawnChild(targetShell, args, {
        cwd: targetCwd,
        env: targetEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      adapter = new ChildProcessAdapter(child);
      logger.warn(`[PTY_ENGINE] node-pty failed, falling back to ChildProcess for session ${id}`);
    }

    const session: PtySession = {
      id,
      adapter,
      buffer: '',
      status: 'running',
      lastUpdated: Date.now()
    };

    adapter.onData((data) => {
      let processed = data;
      if (this.DSR_REQ.test(data)) {
        adapter.write(this.DSR_RES);
        processed = data.replace(this.DSR_REQ, '');
      }

      // Handle ADF Tunnel (detect instructions from terminal output)
      const ADF_PATTERN = />>ADF(\{.*?\})<</g;
      let match;
      while ((match = ADF_PATTERN.exec(processed)) !== null) {
        try {
          const adfPayload = JSON.parse(match[1]);
          logger.info(`[ADF_TUNNEL] Detected instruction from session ${id}: ${JSON.stringify(adfPayload)}`);
          // In a full implementation, this would call Orchestrator.executeADF(adfPayload)
        } catch (err) {
          logger.error(`[ADF_TUNNEL] Failed to parse ADF payload from session ${id}: ${err}`);
        }
      }

      session.buffer += processed;
      session.lastUpdated = Date.now();
      runtimeSupervisor.touch(id);
      if (session.buffer.length > 1024 * 1024) {
        session.buffer = session.buffer.slice(-1024 * 1024);
      }
    });

    adapter.onExit((code) => {
      session.status = 'exited';
      session.exitCode = code || 0;
      session.lastUpdated = Date.now();
      this.detachThread(id);
      runtimeSupervisor.update(id, { state: 'exited', lastActiveAt: Date.now() });
      logger.info(`[PTY_ENGINE] Session ${id} exited with code ${code}`);
      const gcTimer = setTimeout(() => {
        const existing = this.sessions.get(id);
        if (existing && existing.status === 'exited') {
          this.sessions.delete(id);
          runtimeSupervisor.unregister(id);
        }
      }, 60_000);
      gcTimer.unref?.();
    });

    this.sessions.set(id, session);
    runtimeSupervisor.register({
      resourceId: id,
      kind: 'pty',
      ownerId: threadId || id,
      ownerType: threadId ? 'thread' : 'terminal-session',
      pid: adapter.pid,
      idleTimeoutMs: this.idleTimeoutMs,
      shutdownPolicy: 'idle',
      metadata: { cwd: targetCwd, shell: targetShell },
      cleanup: () => {
        const existing = this.sessions.get(id);
        if (existing) {
          existing.adapter.kill();
          this.sessions.delete(id);
        }
        this.detachThread(id);
      },
    });
    return id;
  }

  public get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  public poll(id: string, offset?: number, limit?: number): { output: string, nextOffset: number, total: number } {
    const session = this.sessions.get(id);
    if (!session) return { output: '', nextOffset: 0, total: 0 };

    const total = session.buffer.length;
    runtimeSupervisor.touch(id);
    let start = offset !== undefined ? offset : 0;
    
    // If no offset provided, return all and clear (backward compatibility or full drain)
    if (offset === undefined && limit === undefined) {
      const output = session.buffer;
      session.buffer = '';
      return { output, nextOffset: 0, total: 0 };
    }

    let end = limit !== undefined ? start + limit : total;
    const output = session.buffer.slice(start, end);
    
    return { 
      output, 
      nextOffset: start + output.length,
      total
    };
  }

  public write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (session && session.status === 'running') {
      session.adapter.write(data);
      session.lastUpdated = Date.now();
      runtimeSupervisor.touch(id);
      return true;
    }
    return false;
  }

  public resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (session && session.status === 'running') {
      session.adapter.resize(cols, rows);
      session.lastUpdated = Date.now();
      runtimeSupervisor.touch(id);
      return true;
    }
    return false;
  }

  public kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (session) {
      session.adapter.kill();
      this.sessions.delete(id);
      this.detachThread(id);
      runtimeSupervisor.unregister(id);
      return true;
    }
    return false;
  }

  public list(): string[] {
    return Array.from(this.sessions.keys());
  }
}

// Global singleton registry
const GLOBAL_PTY_KEY = Symbol.for('@kyberion/pty-engine');
if (!(globalThis as any)[GLOBAL_PTY_KEY]) {
  (globalThis as any)[GLOBAL_PTY_KEY] = new PtyRegistry();
  runtimeSupervisor.startSweep(Number(process.env.KYBERION_RUNTIME_SWEEP_INTERVAL_MS || 30_000));
}

export const ptyEngine: PtyRegistry = (globalThis as any)[GLOBAL_PTY_KEY];
