import { logger } from './core';
import { ptyEngine } from './pty-engine';
import { dispatchA2UI } from './a2ui';
import { getAgentManifest, isActuatorAllowed } from './agent-manifest';
import { touchManagedProcess, spawnManagedProcess, stopManagedProcess } from './managed-process';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable, PassThrough } from 'node:stream';

/** Whitelist environment variables passed to child agent processes */
const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM',
  'NODE_ENV', 'NODE_PATH', 'NVM_DIR', 'NVM_BIN',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MISSION_ID', 'MISSION_ROLE',
  // SSL/Proxy
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];

function sanitizeEnvForChild(env: NodeJS.ProcessEnv): Record<string, string> {
  const safe: Record<string, string> = { FORCE_COLOR: '0', TERM: 'dumb' };
  for (const key of ENV_WHITELIST) {
    if (env[key]) safe[key] = env[key] as string;
  }
  return safe;
}

// Dynamic import for ESM-only @agentclientprotocol/sdk
let _acpSdk: { ClientSideConnection: any; ndJsonStream: any } | null = null;
async function getACPSdk() {
  if (!_acpSdk) {
    _acpSdk = await import('@agentclientprotocol/sdk');
  }
  return _acpSdk;
}

/**
 * ACP Mediator v5.2 (Model-Aware)
 * Communicates with Agent CLIs using the official Agent Client Protocol SDK.
 * Supports dynamic model selection via unstable_setSessionModel.
 */

export interface ACPMediatorOptions {
  threadId: string;
  bootCommand: string;
  bootArgs: string[];
  modelId?: string;
  systemPrompt?: string;
  cwd?: string;
}

export interface ProviderUsageSummary {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw?: Record<string, unknown>;
  lastUpdatedAt?: number;
}

export class ACPMediator {
  private child: ChildProcess | null = null;
  private connection: any = null;
  private acpSessionId: string | null = null;
  private accumulatedResponse: string = '';
  private processedA2UIOffsets: Set<number> = new Set();
  private booted: boolean = false;
  private systemPromptSent: boolean = false;
  private logBuffer: { ts: number; type: string; content: string }[] = [];
  private static readonly MAX_LOG_ENTRIES = 200;
  private runtimeResourceId: string;
  private usage: ProviderUsageSummary = {};

  constructor(private options: ACPMediatorOptions) {
    this.runtimeResourceId = `acp:${options.threadId}`;
  }

  private log(type: string, content: string): void {
    this.logBuffer.push({ ts: Date.now(), type, content });
    if (this.logBuffer.length > ACPMediator.MAX_LOG_ENTRIES) {
      this.logBuffer = this.logBuffer.slice(-ACPMediator.MAX_LOG_ENTRIES);
    }
  }

  /** Get recent terminal log entries */
  public getLog(limit = 50): { ts: number; type: string; content: string }[] {
    return this.logBuffer.slice(-limit);
  }

  public getRuntimeInfo(): { pid?: number; sessionId: string | null; usage: ProviderUsageSummary; supportsSoftRefresh: boolean } {
    return {
      pid: this.child?.pid,
      sessionId: this.acpSessionId,
      usage: { ...this.usage },
      supportsSoftRefresh: true,
    };
  }

  private updateUsageFromPayload(payload: unknown): void {
    const usage = extractUsageSummary(payload);
    if (!usage) return;
    this.usage = {
      inputTokens: usage.inputTokens ?? this.usage.inputTokens,
      outputTokens: usage.outputTokens ?? this.usage.outputTokens,
      totalTokens: usage.totalTokens ?? this.usage.totalTokens,
      raw: usage.raw ?? this.usage.raw,
      lastUpdatedAt: Date.now(),
    };
  }

  private async establishSession(): Promise<void> {
    logger.info('[ACP_MEDIATOR] Establishing Session...');
    const sessionRes = await this.connection.newSession({
      cwd: this.options.cwd || process.cwd(),
      mcpServers: []
    });
    this.acpSessionId = sessionRes.sessionId;
    logger.info(`[ACP_MEDIATOR] Ready. Session: ${this.acpSessionId}`);

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
    this.systemPromptSent = false;
  }

  public async boot(): Promise<void> {
    if (this.booted) return;
    logger.info(`[ACP_MEDIATOR] Spawning ACP Agent: ${this.options.bootCommand}`);

    const managed = spawnManagedProcess({
      resourceId: this.runtimeResourceId,
      kind: 'agent',
      ownerId: this.options.threadId,
      ownerType: 'acp-mediator',
      command: this.options.bootCommand,
      args: this.options.bootArgs,
      shutdownPolicy: 'manual',
      spawnOptions: {
        cwd: this.options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sanitizeEnvForChild(process.env),
      },
      metadata: {
        providerCommand: this.options.bootCommand,
        providerArgs: this.options.bootArgs,
      },
    });
    this.child = managed.child;

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
          this.log('in', trimmed);
          touchManagedProcess(this.runtimeResourceId);
        } else if (trimmed) {
          logger.info(`[ACP_TEXT_IN] ${trimmed}`);
          this.log('text', trimmed);
          touchManagedProcess(this.runtimeResourceId);
        }
      }
    });

    this.child.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      logger.info(`[ACP_STDERR] ${msg}`);
      this.log('stderr', msg);
      touchManagedProcess(this.runtimeResourceId);
    });

    sdkOutput.on('data', (chunk) => {
      const msg = chunk.toString();
      logger.info(`[ACP_JSON_OUT] ${msg.trim()}`);
      this.log('out', msg.trim());
      this.child?.stdin?.write(msg);
    });

    const { ClientSideConnection, ndJsonStream } = await getACPSdk();
    this.connection = new ClientSideConnection(
      (agent: any) => ({
        sessionUpdate: async (params: any) => {
          logger.info(`[ACP_NOTIF] ${JSON.stringify(params)}`);
          this.updateUsageFromPayload(params);
          if (params.update?.sessionUpdate === 'agent_message_chunk') {
            const text = params.update.content?.text || '';
            this.accumulatedResponse += text;
            logger.info(`[ACP_AGENT_SAYS] ${text}`);
            this.log('agent', text);

            // A2UI Extraction: scan accumulated response for embedded UI payloads
            const A2UI_PATTERN = /```a2ui\n([\s\S]*?)```|>>A2UI(\{[\s\S]*?\})<</g;
            let match;
            while ((match = A2UI_PATTERN.exec(this.accumulatedResponse)) !== null) {
              if (this.processedA2UIOffsets.has(match.index)) continue;
              try {
                const jsonStr = match[1] || match[2];
                const a2uiPacket = JSON.parse(jsonStr);
                logger.info(`[A2UI_EXTRACTED] Detected UI Surface: ${a2uiPacket.surfaceId || 'unknown'}`);
                this.processedA2UIOffsets.add(match.index);

                dispatchA2UI(a2uiPacket);
              } catch (_) {
                // Partial JSON at chunk boundary - wait for next chunk
              }
            }
          }
        },
        async requestPermission(params: any) {
          const title = (params.toolCall?.title || '').toLowerCase();

          // Actuator restriction: check manifest whitelist/blacklist
          const manifest = getAgentManifest(this.options.threadId);
          if (manifest) {
            // Extract actuator name from tool call title (e.g., "run_shell_command" → system, "read_file" → file)
            const actuatorMap: Record<string, string> = {
              'shell': 'system-actuator', 'command': 'system-actuator', 'exec': 'system-actuator',
              'file': 'file-actuator', 'read_file': 'file-actuator', 'write_file': 'file-actuator',
              'browser': 'browser-actuator', 'navigate': 'browser-actuator',
              'network': 'network-actuator', 'fetch': 'network-actuator', 'curl': 'network-actuator',
            };
            for (const [keyword, actuator] of Object.entries(actuatorMap)) {
              if (title.includes(keyword) && !isActuatorAllowed(manifest, actuator)) {
                logger.error(`[ACP_PERMISSION] DENIED by manifest: ${this.options.threadId} cannot use ${actuator} (tool: ${title})`);
                return { outcome: 'denied' as const };
              }
            }
          }

          // Block explicitly dangerous operations
          const dangerousPatterns = ['rm -rf', 'format', 'drop table', 'delete', 'eval(', 'exec('];
          if (dangerousPatterns.some(p => title.includes(p))) {
            logger.error(`[ACP_PERMISSION] BLOCKED dangerous operation: ${title}`);
            return { outcome: 'denied' as const };
          }

          // Allow safe operations
          const safePatterns = ['read', 'search', 'list', 'view', 'get', 'ls', 'cat', 'grep', 'find', 'git status', 'git log', 'git diff'];
          if (safePatterns.some(p => title.includes(p))) {
            return { outcome: 'approved' as const };
          }

          logger.info(`[ACP_PERMISSION] Approved: ${title}`);
          return { outcome: 'approved' as const };
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

    await this.establishSession();

    // System prompt will be prepended to the first ask() call
    // instead of sent as a separate prompt during boot.
    // This avoids boot hanging when the API has capacity issues.

    this.booted = true;
    logger.info('[ACP_MEDIATOR] Session established.');
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

    // Prepend system prompt on first ask
    if (!this.systemPromptSent && this.options.systemPrompt) {
      enrichedPrompt = `[System Instructions]\n${this.options.systemPrompt}\n\n[User Request]\n${enrichedPrompt}`;
      this.systemPromptSent = true;
    }

    this.accumulatedResponse = '';
    this.processedA2UIOffsets.clear();
    this.log('prompt', enrichedPrompt.slice(0, 200));
    logger.info(`[ACP_MEDIATOR] Asking: "${enrichedPrompt.slice(0, 100)}..."`);

    const response = await this.connection.prompt({
      sessionId: this.acpSessionId,
      prompt: [{ type: 'text', text: enrichedPrompt }]
    });
    this.updateUsageFromPayload(response);
    return this.accumulatedResponse || `(No text, stopReason: ${response.stopReason})`;
  }

  public async refreshContext(): Promise<{ mode: 'soft'; sessionId: string | null }> {
    if (!this.connection) throw new Error('Not booted.');
    this.accumulatedResponse = '';
    this.processedA2UIOffsets.clear();
    await this.establishSession();
    return { mode: 'soft', sessionId: this.acpSessionId };
  }

  public async shutdown(): Promise<void> {
    if (this.child) {
      stopManagedProcess(this.runtimeResourceId, this.child);
      this.child = null;
    }
    this.booted = false;
    this.connection = null;
    this.acpSessionId = null;
  }
}

function extractUsageSummary(payload: unknown): ProviderUsageSummary | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const usage = (current as any).usage;
    if (usage && typeof usage === 'object') {
      const inputTokens = coerceNumber(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens);
      const outputTokens = coerceNumber(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens);
      const totalTokens = coerceNumber(usage.totalTokens ?? usage.total_tokens) ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
      return {
        inputTokens,
        outputTokens,
        totalTokens,
        raw: usage as Record<string, unknown>,
      };
    }
    for (const value of Object.values(current as Record<string, unknown>)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
