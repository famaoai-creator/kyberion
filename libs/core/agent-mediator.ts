import { ptyEngine } from './pty-engine.js';
import { logger } from './core.js';

/**
 * Agent Mediator v1.0
 * Handles intermediation with interactive Agent CLIs (e.g. Gemini CLI, Claude CLI).
 * Inspired by OpenClaw cli-runner.
 */

export interface MediatorOptions {
  threadId: string;
  promptPattern: string | RegExp;
  bootCommand: string;
  bootArgs: string[];
  timeoutMs?: number;
}

export class AgentMediator {
  private sessionId: string | null = null;

  constructor(private options: MediatorOptions) {}

  /**
   * Boots the Agent CLI and waits for the initial prompt.
   */
  public async boot(): Promise<string> {
    logger.info(`[MEDIATOR] Booting Agent CLI: ${this.options.bootCommand} ${this.options.bootArgs.join(' ')}`);
    
    this.sessionId = ptyEngine.spawn(
      this.options.bootCommand,
      this.options.bootArgs,
      process.cwd(),
      {},
      this.options.threadId
    );

    // Wait for the initial prompt to appear
    const output = await ptyEngine.waitFor(
      this.sessionId, 
      this.options.promptPattern, 
      this.options.timeoutMs || 60000
    );
    
    logger.info(`[MEDIATOR] Agent CLI is ready (Thread: ${this.options.threadId})`);
    return output;
  }

  /**
   * Sends a query to the Agent CLI and waits for the next prompt.
   */
  public async ask(query: string): Promise<string> {
    if (!this.sessionId) throw new Error('Agent CLI is not booted. Call boot() first.');

    logger.info(`[MEDIATOR] Sending query to Agent CLI: "${query}"`);
    
    // Clear buffer before sending to avoid old data
    ptyEngine.poll(this.sessionId);

    // Write query to stdin
    ptyEngine.write(this.sessionId, `${query}\n`);

    // Wait for the prompt to return, signifying the end of the response
    // Using a 1000ms quiet period to ensure streaming response has finished.
    const rawOutput = await ptyEngine.waitFor(
      this.sessionId, 
      this.options.promptPattern, 
      this.options.timeoutMs || 120000,
      1000 
    );

    return rawOutput.trim();
  }

  public async shutdown() {
    if (this.sessionId) {
      ptyEngine.kill(this.sessionId);
      this.sessionId = null;
    }
  }
}
