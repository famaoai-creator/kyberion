/**
 * Reflex Terminal (RT) - Self-Healing Edition v3.0
 * Provides terminal session with automatic fallback between node-pty and child_process.
 */

import { spawn as spawnChild, ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, ui } from './core.js';

export interface ReflexTerminalOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  feedbackPath?: string;
  onOutput?: (data: string) => void;
}

/**
 * Abstract interface for terminal adapters
 */
interface TerminalAdapter {
  write(data: string): void;
  resize(cols: number, rows: number, width?: number, height?: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  getPid(): number | undefined;
}

/**
 * Adapter using node-pty (Native PTY)
 */
class PtyAdapter implements TerminalAdapter {
  constructor(private pty: any) {}
  write(data: string) { this.pty.write(data); }
  resize(cols: number, rows: number) { this.pty.resize(cols, rows); }
  kill() { this.pty.kill(); }
  onData(cb: (data: string) => void) { this.pty.onData(cb); }
  onExit(cb: (code: number, signal: string) => void) { this.pty.onExit(cb); }
  getPid() { return this.pty.pid; }
}

/**
 * Fallback Adapter using standard child_process (Basic Emulation)
 */
class ChildProcessAdapter implements TerminalAdapter {
  private process: ChildProcess;
  constructor(shell: string, args: string[], options: any) {
    this.process = spawnChild(shell, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    logger.warn('[RT] node-pty failed. Falling back to ChildProcess emulation.');
  }
  write(data: string) { this.process.stdin?.write(data); }
  resize() { /* no-op in emulation */ }
  kill() { this.process.kill(); }
  onData(cb: (data: string) => void) {
    this.process.stdout?.on('data', (d) => cb(d.toString()));
    this.process.stderr?.on('data', (d) => cb(d.toString()));
  }
  onExit(cb: (code: number | null, signal: string | null) => void) {
    this.process.on('exit', cb);
  }
  getPid() { return this.process.pid; }
}

export class ReflexTerminal {
  private adapter: TerminalAdapter;
  private feedbackPath: string;

  constructor(options: ReflexTerminalOptions = {}) {
    const shell = options.shell || (os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
    const cwd = path.resolve(options.cwd || process.cwd());
    this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');

    const env = { ...process.env, TERM: 'xterm-256color', PAGER: 'cat' };

    try {
      // Dynamic import to avoid crash if node-pty is missing or broken
      const pty = require('node-pty');
      const ptyInstance = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: options.cols || 80,
        rows: options.rows || 24,
        cwd,
        env
      });
      this.adapter = new PtyAdapter(ptyInstance);
      logger.info(`[RT] Using Native PTY (node-pty)`);
    } catch (err: any) {
      // Fallback to child_process
      this.adapter = new ChildProcessAdapter(shell, [], { cwd, env });
      logger.info(`[RT] Using Emulated Terminal (child_process)`);
    }

    this.setupListeners(options.onOutput);
  }

  private setupListeners(onOutput?: (data: string) => void) {
    const DSR_REQ = /\x1b\[\??6n/g;
    const DSR_RES = '\x1b[1;1R';

    this.adapter.onData((data) => {
      let processedData = data;

      // 1. Detect and auto-respond to DSR (Device Status Report)
      // This prevents interactive tools (less, git, etc.) from hanging.
      if (DSR_REQ.test(data)) {
        this.adapter.write(DSR_RES);
        // Strip the request from the output to keep logs/AI context clean
        processedData = data.replace(DSR_REQ, '');
      }

      if (onOutput && processedData.length > 0) {
        onOutput(processedData);
      }
    });

    this.adapter.onExit((code, signal) => {
      logger.warn(`[RT] Terminal process exited with code ${code}, signal ${signal}`);
    });
  }

  public execute(command: string) {
    logger.info(`[RT] Injecting command: ${command}`);
    this.adapter.write(`${command}\n`); // Changed \r to \n for better compatibility with child_process
  }

  public write(data: string) {
    this.adapter.write(data);
  }

  public resize(cols: number, rows: number, width?: number, height?: number) {
    this.adapter.resize(cols, rows, width, height);
  }

  public getPid(): number | undefined {
    return this.adapter.getPid();
  }

  public kill() {
    this.adapter.kill();
  }

  public persistResponse(text: string, skillName = 'reflex-terminal') {
    try {
      const cleanText = ui.stripAnsi(text).trim();
      if (!cleanText) return;

      const envelope = {
        skill: skillName,
        status: 'success',
        data: { message: cleanText },
        metadata: { timestamp: new Date().toISOString(), duration_ms: 0 }
      };
      const dir = path.dirname(this.feedbackPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.feedbackPath, JSON.stringify(envelope, null, 2), 'utf8');
      logger.success(`[RT] Response persisted to ${this.feedbackPath}`);
    } catch (err: any) {
      logger.error(`[RT] Failed to persist response: ${err.message}`);
    }
  }
}
