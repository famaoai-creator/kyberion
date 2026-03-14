import { logger } from './core';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn, ChildProcess } from 'node:child_process';
import { Readable, Writable, PassThrough } from 'node:stream';

/**
 * Universal Agent Adapter (UAA) v1.5
 * Truly Universal: Handles deeply nested ID structures and complex turn lifecycles.
 */

export interface AgentResponse {
  text: string;
  thought?: string;
  stopReason: string;
}

export interface AgentAdapter {
  boot(): Promise<void>;
  ask(prompt: string): Promise<AgentResponse>;
  shutdown(): Promise<void>;
}

interface ACPDialect {
  authenticate: string;
  newSession: string;
  prompt: string;
}

abstract class BaseACPAdapter implements AgentAdapter {
  protected child: ChildProcess | null = null;
  protected connection: ClientSideConnection | null = null;
  protected acpSessionId: string | null = null;
  protected accumulatedResponse: string = '';
  protected accumulatedThought: string = '';

  constructor(
    protected bootCommand: string,
    protected bootArgs: string[],
    protected dialect: ACPDialect,
    protected authMethod: string = 'oauth-personal'
  ) {}

  public async boot(): Promise<void> {
    logger.info(`[UAA] Spawning: ${this.bootCommand} ${this.bootArgs.join(' ')}`);
    this.child = spawn(this.bootCommand, this.bootArgs, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', TERM: 'dumb' }
    });

    const sdkInput = new PassThrough();
    const sdkOutput = new PassThrough();
    let guestBuffer = '';

    this.child.stdout?.on('data', (chunk) => {
      guestBuffer += chunk.toString();
      const lines = guestBuffer.split('\n');
      guestBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) {
          sdkInput.write(trimmed + '\n');
        }
      }
    });

    sdkOutput.on('data', (data) => {
      const msg = data.toString();
      if (this.child?.stdin?.writable) this.child.stdin.write(msg);
    });

    this.connection = new ClientSideConnection(
      (agent) => ({
        sessionUpdate: async (params: any) => {
          logger.info(`[UAA_NOTIF] ${JSON.stringify(params)}`);
          
          // RECURSIVE SCAN for text/thought chunks
          const findContent = (obj: any) => {
            if (!obj || typeof obj !== 'object') return;
            
            // Look for Gemini-style update
            if (obj.sessionUpdate === 'agent_message_chunk' && obj.content?.text) {
              this.accumulatedResponse += obj.content.text;
            } else if (obj.sessionUpdate === 'agent_thought_chunk' && obj.content?.text) {
              this.accumulatedThought += obj.content.text;
            }
            
            // Look for Codex-style turn update
            if (obj.turn?.items) {
              for (const item of obj.turn.items) {
                if (item.type === 'message' && item.text) {
                  // Only add if not already present (simplified deduplication)
                  if (!this.accumulatedResponse.includes(item.text)) {
                    this.accumulatedResponse += item.text;
                  }
                }
              }
            }

            // Recurse into objects/arrays
            for (const key in obj) {
              if (typeof obj[key] === 'object') findContent(obj[key]);
            }
          };

          findContent(params);
        },
        async requestPermission(params) { return { outcome: 'approved' }; },
        async readTextFile(params) { throw new Error('Not implemented'); },
        async writeTextFile(params) { throw new Error('Not implemented'); },
        async createTerminal(params) { throw new Error('Not implemented'); },
        extMethod: async (m, p) => ({}),
        extNotification: async (m, p) => {}
      }),
      ndJsonStream(Writable.toWeb(sdkOutput) as any, Readable.toWeb(sdkInput) as any)
    );

    await new Promise(r => setTimeout(r, 2000));
    await this.connection.initialize({ protocolVersion: 1, capabilities: {}, clientInfo: { name: 'Kyberion', version: '1.0.0' } });
    
    try { await this.connection.extMethod(this.dialect.authenticate, { methodId: this.authMethod, type: this.authMethod }); } catch (e) {}

    const sessionRes: any = await this.connection.extMethod(this.dialect.newSession, { 
      cwd: process.cwd(), 
      workingDirectory: process.cwd(),
      mcpServers: [] 
    });

    // ROBUST ID EXTRACTION: Check all known locations
    this.acpSessionId = sessionRes.sessionId || sessionRes.threadId || sessionRes.thread?.id;
    
    if (!this.acpSessionId) {
      throw new Error(`Failed to extract session ID from response: ${JSON.stringify(sessionRes)}`);
    }
    logger.info(`[UAA] Ready. ID: ${this.acpSessionId}`);

    // Gemini often needs a specific model via set_model if default is busy
    try {
      // @ts-ignore
      await this.connection.extMethod('session/set_model', {
        sessionId: this.acpSessionId,
        modelId: 'gemini-2.5-flash'
      });
    } catch (e) {}
  }

  public async ask(text: string): Promise<AgentResponse> {
    if (!this.connection || !this.acpSessionId) throw new Error('Agent not booted.');
    this.accumulatedResponse = '';
    this.accumulatedThought = '';
    
    // @ts-ignore
    const response: any = await this.connection.extMethod(this.dialect.prompt, {
      sessionId: this.acpSessionId,
      threadId: this.acpSessionId,
      prompt: [{ type: 'text', text }],
      content: [{ type: 'text', text }],
      input: [{ type: 'text', text }]
    });

    logger.info(`[UAA_RESULT] ${JSON.stringify(response)}`); // DEBUG: Watch response structure

    // If accumulatedResponse is empty, try to extract from the result object
    let finalText = this.accumulatedResponse;
    if (!finalText && response.turn?.content) {
      finalText = (response.turn.content as any[])
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }

    return {
      text: finalText,
      thought: this.accumulatedThought,
      stopReason: (response as any).stopReason || 'completed'
    };
  }

  public async shutdown(): Promise<void> {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}

export class GeminiAdapter extends BaseACPAdapter {
  constructor() { 
    super('gemini', ['--acp'], {
      authenticate: 'authenticate',
      newSession: 'session/new',
      prompt: 'session/prompt'
    }, 'oauth-personal'); 
  }
}

/**
 * Non-ACP implementation for Codex using stable CLI 'exec' mode.
 */
export class CodexAdapter implements AgentAdapter {
  public async boot(): Promise<void> {
    logger.info('[UAA] Codex (Exec mode) ready.');
  }

  public async ask(text: string): Promise<AgentResponse> {
    logger.info(`[UAA] Codex Executing: "${text}"`);
    const { spawnSync } = await import('node:child_process');
    
    try {
      // Pass the text as a single argument to npx/codex exec
      const res = spawnSync('npx', ['codex', 'exec', '--json', text], {
        encoding: 'utf8',
        env: process.env,
        shell: false 
      });

      if (res.error) throw res.error;
      if (res.status !== 0) {
        logger.error(`[UAA] Codex Exit Code: ${res.status}`);
        logger.error(`[UAA] Codex Stderr: ${res.stderr}`);
        return { text: '', stopReason: 'error' };
      }

      const parsed = JSON.parse(res.stdout);
      return {
        text: parsed.message || parsed.content || res.stdout,
        thought: parsed.thought,
        stopReason: 'completed'
      };
    } catch (e: any) {
      logger.error(`[UAA] Codex Exec failed: ${e.message}`);
      return { text: '', stopReason: 'error' };
    }
  }

  public async shutdown(): Promise<void> {}
}

export class AgentFactory {
  public static create(provider: 'gemini' | 'codex'): AgentAdapter {
    switch (provider) {
      case 'gemini': return new GeminiAdapter();
      case 'codex': return new CodexAdapter();
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}
