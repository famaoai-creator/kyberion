/**
 * Reflex Terminal (RT) - Core Logic v1.1 (Native Bridge Edition)
 * Provides a persistent virtual terminal session using native child_process.
 */

import { spawn, ChildProcess } from 'node:child_process';
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
  private proc: ChildProcess;
  private feedbackPath: string;

  constructor(options: ReflexTerminalOptions = {}) {
    const shell = options.shell || (os.platform() === 'win32' ? 'powershell.exe' : '/bin/zsh');
    this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');

    this.proc = spawn(shell, ['-i'], { // Use interactive mode to get prompt and environment
      cwd: path.resolve(options.cwd || process.cwd()),
      env: { ...process.env, TERM: 'xterm-256color', PAGER: 'cat' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.setupListeners(options.onOutput);
    logger.info(`[RT] Reflex Terminal (Native) started with shell: ${shell}`);
  }

  private setupListeners(onOutput?: (data: string) => void) {
    this.proc.stdout?.on('data', (data) => {
      const str = data.toString();
      if (onOutput) onOutput(str);
      process.stdout.write(str);
    });

    this.proc.stderr?.on('data', (data) => {
      const str = data.toString();
      if (onOutput) onOutput(str);
      process.stderr.write(str);
    });

    this.proc.on('exit', (code) => {
      logger.warn(`[RT] Shell exited with code ${code}`);
    });
  }

  /**
   * Inject a command into the terminal.
   */
  public execute(command: string) {
    logger.info(`[RT] Injecting command: ${command}`);
    this.proc.stdin?.write(`${command}\n`);
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
    this.proc.kill();
  }
}
