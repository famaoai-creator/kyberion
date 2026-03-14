/**
 * Reflex Terminal (RT) - Unified Wrapper v4.0
 * Now powered by ptyEngine for centralized session management.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { logger, ui, ptyEngine } from './index.js';

export interface ReflexTerminalOptions {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  feedbackPath?: string;
  onOutput?: (data: string) => void;
}

export class ReflexTerminal {
  private sessionId: string;
  private feedbackPath: string;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: ReflexTerminalOptions = {}) {
    this.feedbackPath = options.feedbackPath || path.join(process.cwd(), 'active/shared/last_response.json');
    
    // Delegate spawning to ptyEngine
    this.sessionId = ptyEngine.spawn(
      options.shell,
      [],
      options.cwd,
      {}
    );

    if (options.onOutput) {
      // Setup polling for the legacy onOutput callback
      this.pollTimer = setInterval(() => {
        const result = ptyEngine.poll(this.sessionId);
        if (result?.output && options.onOutput) {
          options.onOutput(result.output);
        }
      }, 100);
    }
  }

  public execute(command: string) {
    logger.info(`[RT] Injecting command: ${command}`);
    this.write(`${command}\n`);
  }

  public write(data: string) {
    ptyEngine.write(this.sessionId, data);
  }

  public resize(cols: number, rows: number) {
    ptyEngine.resize(this.sessionId, cols, rows);
  }

  public getPid(): number | undefined {
    return ptyEngine.get(this.sessionId)?.adapter.pid;
  }

  public kill() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    ptyEngine.kill(this.sessionId);
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
