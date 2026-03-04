/**
 * Reflex Terminal (RT) - Core Logic v2.0 (node-pty Edition)
 * Provides a persistent virtual terminal session using node-pty for true PTY support.
 */

import * as pty from 'node-pty';
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

export class ReflexTerminal {
  private ptyProcess: pty.IPty;
  private feedbackPath: string;

  constructor(options: ReflexTerminalOptions = {}) {
    const shell = options.shell || (os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
    this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');

    this.ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: path.resolve(options.cwd || process.cwd()),
      env: { ...process.env, TERM: 'xterm-256color', PAGER: 'cat' } as any
    });

    this.setupListeners(options.onOutput);
    logger.info(`[RT] Reflex Terminal (node-pty) started with shell: ${shell}`);
  }

  private setupListeners(onOutput?: (data: string) => void) {
    this.ptyProcess.onData((data) => {
      if (onOutput) onOutput(data);
      // Optional: fallback to stdout if needed, but usually redundant for PTY
      // process.stdout.write(data); 
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      logger.warn(`[RT] PTY process exited with code ${exitCode}, signal ${signal}`);
    });
  }

  /**
   * Inject a command or raw input into the terminal.
   */
  public execute(command: string) {
    logger.info(`[RT] Injecting command: ${command}`);
    this.ptyProcess.write(`${command}\r`);
  }

  /**
   * Write raw data to the terminal.
   */
  public write(data: string) {
    this.ptyProcess.write(data);
  }

  /**
   * Resize the terminal dimensions.
   */
  public resize(cols: number, rows: number) {
    this.ptyProcess.resize(cols, rows);
  }

  /**
   * Register an output listener.
   */
  public onData(callback: (data: string) => void) {
    return this.ptyProcess.onData(callback);
  }

  /**
   * Manually trigger a feedback update to the shared response file.
   */
  public persistResponse(text: string, skillName = 'reflex-terminal') {
    try {
      const cleanText = ui.stripAnsi(text).trim();
      if (!cleanText) return;

      const envelope = {
        skill: skillName,
        status: 'success',
        data: { message: cleanText },
        metadata: {
          timestamp: new Date().toISOString(),
          duration_ms: 0
        }
      };
      const dir = path.dirname(this.feedbackPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.feedbackPath, JSON.stringify(envelope, null, 2), 'utf8');
      logger.success(`[RT] Response persisted to ${this.feedbackPath}`);
    } catch (err: any) {
      logger.error(`[RT] Failed to persist response: ${err.message}`);
    }
  }

  public kill() {
    this.ptyProcess.kill();
  }
}
