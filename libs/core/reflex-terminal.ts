/**
 * Reflex Terminal (RT) - Core Logic v1.0
 * Provides a persistent virtual terminal session with bi-directional neural bridging.
 */

import * as pty from 'node-pty';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './core.js';

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
  private outputBuffer: string = '';
  private feedbackPath: string;

  constructor(options: ReflexTerminalOptions = {}) {
    const shell = options.shell || (os.platform() === 'win32' ? 'powershell.exe' : 'zsh');
    this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');

    this.ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: options.cwd || process.cwd(),
      env: process.env as any
    });

    this.setupListeners(options.onOutput);
    logger.info(`[RT] Reflex Terminal started with shell: \${shell}`);
  }

  private setupListeners(onOutput?: (data: string) => void) {
    this.ptyProcess.onData((data) => {
      this.outputBuffer += data;
      if (onOutput) onOutput(data);
      this.processOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      logger.warn(`[RT] Shell exited with code ${exitCode}, signal ${signal}`);
    });
  }

  private processOutput(data: string) {
    // Process terminal output in real-time.
    // In v1.0, we just log it. In v2.0, we'll use an AI-based filter 
    // to decide what's important enough to send to Slack.
    process.stdout.write(data);
  }

  /**
   * Inject a command into the terminal.
   */
  public execute(command: string) {
    logger.info(`[RT] Injecting command: ${command}`);
    this.ptyProcess.write(`${command}`);
  }

  /**
   * Manually trigger a feedback update to the shared response file.
   * This is what allows the AI to "speak" back to Slack.
   */
  public persistResponse(text: string, skillName = 'reflex-terminal') {
    try {
      const envelope = {
        skill: skillName,
        status: 'success',
        data: { message: text },
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

  public resize(cols: number, rows: number) {
    this.ptyProcess.resize(cols, rows);
  }

  public kill() {
    this.ptyProcess.kill();
  }
}
