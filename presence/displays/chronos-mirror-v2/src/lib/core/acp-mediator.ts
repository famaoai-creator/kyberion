import { logger } from './core';
import { ptyEngine } from './pty-engine';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { spawn, ChildProcess } from 'node:child_process';
import { Readable, Writable, PassThrough } from 'node:stream';

/**
 * ACP Mediator v5.2 (Model-Aware)
 * Communicates with Agent CLIs using the official Agent Client Protocol SDK.
 * Supports dynamic model selection via unstable_setSessionModel.
 */

export interface ACPMediatorOptions {
  threadId: string;
  bootCommand: string;
  bootArgs: string[];
  modelId?: string; // Optional: specific model to use (e.g. "gemini-2.5-flash")
}

export class ACPMediator {
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private acpSessionId: string | null = null;
  private accumulatedResponse: string = '';

  constructor(private options: ACPMediatorOptions) {}

  public async boot(): Promise<void> {
    logger.info(`[ACP_MEDIATOR] Spawning ACP Agent: ${this.options.bootCommand}`);

    this.child = spawn(this.options.bootCommand, this.options.bootArgs, {
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
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          sdkInput.write(trimmed + '\n');
          logger.info(`[ACP_JSON_IN] ${trimmed}`);
        } else if (trimmed) {
          logger.info(`[ACP_TEXT_IN] ${trimmed}`);
        }
      }
    });

    this.child.stderr?.on('data', (data) => {
      logger.info(`[ACP_STDERR] ${data.toString().trim()}`);
    });

    sdkOutput.on('data', (chunk) => {
      const msg = chunk.toString();
      logger.info(`[ACP_JSON_OUT] ${msg.trim()}`);
      this.child?.stdin?.write(msg);
    });

    this.connection = new ClientSideConnection(
      (agent) => ({
        sessionUpdate: async (params: any) => {
          logger.info(`[ACP_NOTIF] ${JSON.stringify(params)}`);
          if (params.update?.sessionUpdate === 'agent_message_chunk') {
            const text = params.update.content?.text || '';
            this.accumulatedResponse += text;
            logger.info(`[ACP_AGENT_SAYS] ${text}`);

            // A2UI Extraction: Use accumulated response to handle chunks
            const A2UI_PATTERN = /```a2ui\n([\s\S]*?)```|>>A2UI(\{[\s\S]*?\})<</g;
            let match;
            // We search in the FULL accumulated response so far
            while ((match = A2UI_PATTERN.exec(this.accumulatedResponse)) !== null) {
              try {
                const jsonStr = match[1] || match[2];
                // Check if we've already processed this exact string to avoid duplicates
                if (!(this as any)._processedA2UI) (this as any)._processedA2UI = new Set();
                if ((this as any)._processedA2UI.has(jsonStr)) continue;

                const a2uiPacket = JSON.parse(jsonStr);
                logger.info(`[A2UI_EXTRACTED] Detected UI Surface: ${a2uiPacket.surfaceId || 'unknown'}`);
                (this as any)._processedA2UI.add(jsonStr);

                const { dispatchA2UI } = await import('./a2ui');
                dispatchA2UI(a2uiPacket);
              } catch (e) {
                // If it's a partial JSON at the end of a chunk, ignore and wait for next chunk
              }
            }
          }
        },
        async requestPermission(params) {
          logger.warn(`[ACP_PERMISSION] Required for: ${params.toolCall.title}`);
          return { outcome: 'approved' as any };
        },
        async readTextFile(params) { throw new Error('Not implemented'); },
        async writeTextFile(params) { throw new Error('Not implemented'); },
        async createTerminal(params) { throw new Error('Not implemented'); },
        extMethod: async (m, p) => ({}),
        extNotification: async (m, p) => {}
      }),
      ndJsonStream(Writable.toWeb(sdkOutput) as any, Readable.toWeb(sdkInput) as any)
    );

    await new Promise(r => setTimeout(r, 2000));

    logger.info('[ACP_MEDIATOR] Negotiating protocol...');
    await this.connection.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'Kyberion', version: '1.0.0' }
    } as any);

    logger.info('[ACP_MEDIATOR] Authenticating...');
    await this.connection.authenticate({
      methodId: 'oauth-personal'
    });

    logger.info('[ACP_MEDIATOR] Establishing Session...');
    const sessionRes = await this.connection.newSession({
      cwd: process.cwd(),
      mcpServers: []
    });
    this.acpSessionId = sessionRes.sessionId;
    
    logger.info(`[ACP_MEDIATOR] Ready. Session: ${this.acpSessionId}`);

    // Dynamic Model Selection
    const targetModel = this.options.modelId || 'gemini-2.5-flash';
    try {
      logger.info(`[ACP_MEDIATOR] Setting model to: ${targetModel}`);
      // @ts-ignore
      await this.connection.unstable_setSessionModel({
        sessionId: this.acpSessionId,
        modelId: targetModel
      });
    } catch (e) {
      logger.warn(`[ACP_MEDIATOR] Model selection failed: ${e}`);
    }

    logger.info('[ACP_MEDIATOR] Letting session settle...');
    await new Promise(r => setTimeout(r, 2000));
  }

  public async ask(text: string): Promise<string> {
    if (!this.connection || !this.acpSessionId) throw new Error('Not booted.');

    // 1. Poll ISM Bus for incoming UI events before this turn
    const ismMessages = ptyEngine.popMessages(this.options.threadId, 'KYBERION-PRIME');
    let enrichedPrompt = text;

    if (ismMessages.length > 0) {
      const uiEvents = ismMessages
        .filter(m => typeof m.payload === 'object' && m.payload.type === 'a2ui_action')
        .map(m => `[UI_EVENT] User performed "${m.payload.event}" on UI. Data: ${JSON.stringify(m.payload.data)}`);
      
      if (uiEvents.length > 0) {
        logger.info(`[ACP_MEDIATOR] Enriching prompt with ${uiEvents.length} UI events.`);
        enrichedPrompt = `${uiEvents.join('\n')}\n\nUser Question: ${text}`;
      }
    }

    this.accumulatedResponse = '';
    logger.info(`[ACP_MEDIATOR] Asking Gemini: "${enrichedPrompt}"`);
    
    const response = await this.connection.prompt({
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text: enrichedPrompt }]
    });
    return this.accumulatedResponse || `(No text, stopReason: ${response.stopReason})`;
  }

  public async shutdown() {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
