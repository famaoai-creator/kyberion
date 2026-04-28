import { logger } from './core.js';
import { safeExistsSync, safeReaddir, safeReadFile } from './secure-io.js';
import { spawnManagedProcess, stopManagedProcess, touchManagedProcess } from './managed-process.js';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable, PassThrough } from 'node:stream';
import * as path from 'node:path';

const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'NODE_ENV',
  'NVM_DIR', 'NVM_BIN', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MISSION_ID', 'MISSION_ROLE', 'KYBERION_PERSONA',
  'CODEX_HOME',
  // SSL/Proxy
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
];
function safeEnv(): NodeJS.ProcessEnv {
  // Locally a relaxed map; cast at the boundary so callers see ProcessEnv
  // (Next 15 augmentation requires NODE_ENV; we treat that as opaque here).
  const env: Record<string, string> = { FORCE_COLOR: '0', TERM: 'dumb' };
  for (const k of ENV_WHITELIST) { if (process.env[k]) env[k] = process.env[k] as string; }
  return env as unknown as NodeJS.ProcessEnv;
}

/** Walk up from cwd to find the project root (contains AGENTS.md) */
function resolveProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (safeExistsSync(path.join(dir, 'AGENTS.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const PROJECT_ROOT = resolveProjectRoot();

async function getACPSdk() {
  return await import('@agentclientprotocol/sdk');
}

/**
 * Universal Agent Adapter (UAA) v1.5
 * Truly Universal: Handles deeply nested ID structures and complex turn lifecycles.
 */

export interface AgentResponse {
  text: string;
  thought?: string;
  stopReason: string;
  trace?: Array<{ enhancer: string; action: string; details?: string }>;
}

export interface AgentAskOptions extends Record<string, unknown> {
  phase?: 'onboarding' | 'recovery' | 'alignment' | 'execution' | 'review';
  intentId?: string;
  tags?: string[];
  responseMimeType?: 'text/plain' | 'application/json';
}

/**
 * Interface for model-specific enhancements (Add-ons).
 */
export interface AgentEnhancer {
  name: string;
  onBeforeAsk?(prompt: string, options?: AgentAskOptions): Promise<{ prompt: string; options?: AgentAskOptions }>;
  onAfterAsk?(response: AgentResponse): Promise<AgentResponse>;
}

export interface AgentAdapter {
  boot(): Promise<void>;
  ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse>;
  shutdown(): Promise<void>;
  getRuntimeInfo?(): Record<string, unknown>;
  refreshContext?(): Promise<{ mode: 'soft' | 'stateless'; sessionId?: string | null; threadId?: string | null }>;
  addEnhancer?(enhancer: AgentEnhancer): void;
}

function registerEnhancer(enhancers: AgentEnhancer[], enhancer: AgentEnhancer): void {
  enhancers.push(enhancer);
  logger.info(`[UAA] Enhancer added: ${enhancer.name}`);
}

function summarizePromptForLog(prompt: string, maxChars = 200): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars)}...`;
}

function isSafeReadOnlyPermissionTitle(title: string): boolean {
  const normalized = title.toLowerCase();
  const allowPatterns = [
    /\bread\b/,
    /\bsearch\b/,
    /\blist\b/,
    /\bview\b/,
    /\binspect\b/,
    /\bfetch\b/,
  ];
  const denyPatterns = [
    /\bwrite\b/,
    /\bedit\b/,
    /\bdelete\b/,
    /\bremove\b/,
    /\bcreate\b/,
    /\bexecute\b/,
    /\brun\b/,
    /\bapply\b/,
    /\bpatch\b/,
  ];
  if (denyPatterns.some((pattern) => pattern.test(normalized))) return false;
  return allowPatterns.some((pattern) => pattern.test(normalized));
}

async function applyEnhancersBeforeAsk(
  enhancers: AgentEnhancer[],
  prompt: string,
  options?: AgentAskOptions,
  trace: Array<{ enhancer: string; action: string; details?: string }> = []
): Promise<{ prompt: string; options: AgentAskOptions }> {
  let currentPrompt = prompt;
  let currentOptions: AgentAskOptions = { ...options };
  for (const enhancer of enhancers) {
    if (!enhancer.onBeforeAsk) continue;
    const originalPrompt = currentPrompt;
    const enhanced = await enhancer.onBeforeAsk(currentPrompt, currentOptions);
    currentPrompt = enhanced.prompt;
    currentOptions = { ...currentOptions, ...(enhanced.options || {}) };
    
    if (currentPrompt !== originalPrompt) {
      trace.push({ 
        enhancer: enhancer.name, 
        action: 'modify_prompt', 
        details: `Diff: ${currentPrompt.length - originalPrompt.length} chars` 
      });
    }
  }
  return { prompt: currentPrompt, options: currentOptions };
}

async function applyEnhancersAfterAsk(
  enhancers: AgentEnhancer[], 
  response: AgentResponse
): Promise<AgentResponse> {
  let next = response;
  const trace = next.trace || [];
  for (const enhancer of enhancers) {
    if (!enhancer.onAfterAsk) continue;
    next = await enhancer.onAfterAsk(next);
    trace.push({ enhancer: enhancer.name, action: 'modify_response' });
  }
  next.trace = trace;
  return next;
}

interface ACPDialect {
  authenticate: string;
  newSession: string;
  prompt: string;
}

abstract class BaseACPAdapter implements AgentAdapter {
  protected child: ChildProcess | null = null;
  protected connection: any = null;
  protected acpSessionId: string | null = null;
  protected accumulatedResponse: string = '';
  protected accumulatedThought: string = '';
  protected runtimeResourceId: string | null = null;
  protected usageSummary: Record<string, unknown> | null = null;
  protected enhancers: AgentEnhancer[] = [];

  constructor(
    protected bootCommand: string,
    protected bootArgs: string[],
    protected dialect: ACPDialect,
    protected authMethod: string = 'oauth-personal'
  ) {}

  public addEnhancer(enhancer: AgentEnhancer): void {
    registerEnhancer(this.enhancers, enhancer);
  }

  public async boot(): Promise<void> {
    logger.info(`[UAA] Spawning: ${this.bootCommand} ${this.bootArgs.join(' ')}`);
    this.runtimeResourceId = `adapter:${this.bootCommand}`;
    const managed = spawnManagedProcess({
      resourceId: this.runtimeResourceId,
      kind: 'agent',
      ownerId: this.bootCommand,
      ownerType: 'agent-adapter',
      command: this.bootCommand,
      args: this.bootArgs,
      shutdownPolicy: 'manual',
      spawnOptions: {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeEnv(),
      },
      metadata: {
        bootCommand: this.bootCommand,
        bootArgs: this.bootArgs,
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
        if (trimmed.startsWith('{')) {
          sdkInput.write(trimmed + '\n');
          touchManagedProcess(this.runtimeResourceId);
        }
      }
    });

    sdkOutput.on('data', (data) => {
      const msg = data.toString();
      if (this.child?.stdin?.writable) this.child.stdin.write(msg);
      touchManagedProcess(this.runtimeResourceId);
    });

    const { ClientSideConnection, ndJsonStream } = await getACPSdk();
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
        async requestPermission(params) {
          const title = (params.toolCall?.title || '').toLowerCase();
          if (isSafeReadOnlyPermissionTitle(title)) {
            return { outcome: 'approved' as const };
          }
          logger.warn(`[UAA_PERMISSION] Auto-denied non-read operation: ${params.toolCall?.title}`);
          return { outcome: 'denied' as const };
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

  public async ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse> {
    if (!this.connection || !this.acpSessionId) throw new Error('Agent not booted.');

    const trace: Array<{ enhancer: string; action: string; details?: string }> = [];
    const enhanced = await applyEnhancersBeforeAsk(this.enhancers, prompt, options || {}, trace);

    this.accumulatedResponse = '';
    this.accumulatedThought = '';

    
    // @ts-ignore
    const response: any = await this.connection.extMethod(this.dialect.prompt, {
      sessionId: this.acpSessionId,
      threadId: this.acpSessionId,
      prompt: [{ type: 'text', text: enhanced.prompt }],
      content: [{ type: 'text', text: enhanced.prompt }],
      input: [{ type: 'text', text: enhanced.prompt }],
      ...enhanced.options
    });
    this.usageSummary = extractUsageSummary(response);

    logger.info(`[UAA_RESULT] ${JSON.stringify(response)}`); // DEBUG: Watch response structure

    // If accumulatedResponse is empty, try to extract from the result object
    let finalText = this.accumulatedResponse;
    if (!finalText && response.turn?.content) {
      finalText = (response.turn.content as any[])
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('\n');
    }

    const agentResponse: AgentResponse = {
      text: finalText,
      thought: this.accumulatedThought,
      stopReason: (response as any).stopReason || 'completed',
      trace
    };
    return applyEnhancersAfterAsk(this.enhancers, agentResponse);
  }

  public async shutdown(): Promise<void> {
    if (this.child) {
      stopManagedProcess(this.runtimeResourceId, this.child);
      this.child = null;
    }
    this.runtimeResourceId = null;
  }

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      pid: this.child?.pid,
      sessionId: this.acpSessionId,
      usage: this.usageSummary,
      supportsSoftRefresh: true,
    };
  }

  public async refreshContext(): Promise<{ mode: 'soft'; sessionId?: string | null }> {
    if (!this.connection) throw new Error('Agent not booted.');
    const sessionRes: any = await this.connection.extMethod(this.dialect.newSession, {
      cwd: process.cwd(),
      workingDirectory: process.cwd(),
      mcpServers: []
    });
    this.acpSessionId = sessionRes.sessionId || sessionRes.threadId || sessionRes.thread?.id;
    return { mode: 'soft', sessionId: this.acpSessionId };
  }
}

export interface GeminiAdapterOptions {
  model?: string;
}

export class GeminiAdapter extends BaseACPAdapter {
  private options: GeminiAdapterOptions;

  constructor(options?: GeminiAdapterOptions) { 
    super('gemini', ['--acp'], {
      authenticate: 'authenticate',
      newSession: 'session/new',
      prompt: 'session/prompt'
    }, 'oauth-personal'); 
    this.options = options || {};

    // Auto-apply Gemini Add-ons for Pro models
    if (this.options.model?.includes('pro') || !this.options.model) {
      this.addEnhancer(new GeminiPhaseAwareInstructionEnhancer());
      this.addEnhancer(new GeminiWisdomEnhancer());
      this.addEnhancer(new GeminiJsonModeEnforcer());
    }
  }

  public async boot(): Promise<void> {
    await super.boot();
    const targetModel = this.options.model || process.env.KYBERION_GEMINI_MODEL || 'gemini-2.5-flash';
    try {
      // @ts-ignore
      await this.connection?.extMethod('session/set_model', {
        sessionId: this.acpSessionId,
        modelId: targetModel,
      });
    } catch (_) {}
  }
}

/**
 * Gemini-specific Add-on: Adjusts system behavior based on mission phase.
 */
export class GeminiPhaseAwareInstructionEnhancer implements AgentEnhancer {
  public name = 'GeminiPhaseAwareInstructionEnhancer';

  public async onBeforeAsk(prompt: string, options?: AgentAskOptions): Promise<{ prompt: string; options?: AgentAskOptions }> {
    if (!options?.phase) return { prompt, options };

    const phaseInstructions: Record<string, string> = {
      alignment: 'Focus on understanding intent, clarifying ambiguity, and defining clear success criteria.',
      execution: 'Prioritize surgical, deterministic code changes. Follow AGENTS.md strictly. Test before finality.',
      review: 'Critically analyze changes for regressions, security leaks, and architectural consistency.',
    };

    const instruction = phaseInstructions[options.phase];
    if (instruction) {
      const enhancedPrompt = `
<phase_directive phase="${options.phase}">
${instruction}
</phase_directive>

${prompt}`;
      return { prompt: enhancedPrompt, options };
    }

    return { prompt, options };
  }
}

/**
 * Gemini-specific Add-on: Enforces JSON mode for structured tasks.
 */
export class GeminiJsonModeEnforcer implements AgentEnhancer {
  public name = 'GeminiJsonModeEnforcer';

  public async onBeforeAsk(prompt: string, options?: AgentAskOptions): Promise<{ prompt: string; options?: AgentAskOptions }> {
    // If the task implies structured output (ADF, manifest, etc.), ensure JSON mode
    const structuredTriggers = [/\badf\b/i, /\bmanifest\b/i, /\bschema\b/i, /\bjson\b/i];
    const isStructured = structuredTriggers.some(t => t.test(prompt)) || options?.responseMimeType === 'application/json';

    if (isStructured) {
      const enhancedOptions = { 
        ...options, 
        responseMimeType: 'application/json' as const 
      };
      const enhancedPrompt = `${prompt}\n\nIMPORTANT: Return valid JSON ONLY. No markdown wrappers.`;
      return { prompt: enhancedPrompt, options: enhancedOptions };
    }

    return { prompt, options };
  }
}

/**
 * Gemini-specific Add-on: Loads "Wisdom" from the evolution history 
 * to leverage Gemini's large context window for self-improvement.
 */
export class GeminiWisdomEnhancer implements AgentEnhancer {
  public name = 'GeminiWisdomEnhancer';

  public async onBeforeAsk(prompt: string, options?: AgentAskOptions): Promise<{ prompt: string; options?: AgentAskOptions }> {
    const wisdomDir = path.join(PROJECT_ROOT, 'knowledge/public/evolution');
    let wisdomContext = '';

    try {
      if (safeExistsSync(wisdomDir)) {
        const files = safeReaddir(wisdomDir);
        // Keep deterministic lesson order to avoid response drift between runs.
        const mdFiles = files
          .filter((f) => f.endsWith('.md'))
          .sort((a, b) => a.localeCompare(b))
          .slice(-5);
        
        for (const file of mdFiles) {
          const content = safeReadFile(path.join(wisdomDir, file), { encoding: 'utf8' }) as string;
          wisdomContext += `\n--- Lesson from ${file} ---\n${content}\n`;
        }
      }
    } catch (e) {
      logger.warn(`[GeminiEnhancer] Failed to load wisdom: ${e}`);
    }

    if (wisdomContext) {
      const enhancedPrompt = `
<wisdom_context>
The following are lessons learned from previous evolutions and missions. 
Use these to avoid past mistakes and align with the ecosystem standards:
${wisdomContext}
</wisdom_context>

User Request:
${prompt}`;
      
      return { prompt: enhancedPrompt, options };
    }

    return { prompt, options };
  }
}

export interface CodexExecutionEnhancerOptions {
  maxContractChars?: number;
}

/**
 * Codex-specific Add-on: injects repository execution contract context.
 * Codex tends to perform better on coding tasks when concrete repo rules are explicit.
 */
export class CodexExecutionEnhancer implements AgentEnhancer {
  public name = 'CodexExecutionEnhancer';
  private cachedContext: string | null = null;

  constructor(private options: CodexExecutionEnhancerOptions = {}) {}

  public async onBeforeAsk(prompt: string, options?: AgentAskOptions): Promise<{ prompt: string; options?: AgentAskOptions }> {
    const context = this.loadExecutionContext();
    if (!context) return { prompt, options };

    const enhancedPrompt = `
<codex_execution_context>
${context}
</codex_execution_context>

User Request:
${prompt}`;
    return { prompt: enhancedPrompt, options };
  }

  private loadExecutionContext(): string {
    if (this.cachedContext !== null) return this.cachedContext;
    const maxChars = this.options.maxContractChars || 4000;
    const agentsPath = path.join(PROJECT_ROOT, 'AGENTS.md');
    if (!safeExistsSync(agentsPath)) {
      this.cachedContext = '';
      return this.cachedContext;
    }
    try {
      const agents = safeReadFile(agentsPath, { encoding: 'utf8' }) as string;
      const header = [
        'Repository execution contract (excerpt):',
        '- Follow AGENTS.md repository rules.',
        '- Prefer non-destructive deterministic operations.',
        '- Preserve existing unrelated changes.',
      ].join('\n');
      const excerpt = agents.slice(0, maxChars).trim();
      this.cachedContext = `${header}\n\n${excerpt}`;
      return this.cachedContext;
    } catch (error: any) {
      logger.warn(`[CodexEnhancer] Failed to load AGENTS.md context: ${error?.message || String(error)}`);
      this.cachedContext = '';
      return this.cachedContext;
    }
  }
}

/**
 * Non-ACP implementation for Codex using stable CLI 'exec' mode.
 */
export class CodexAdapter implements AgentAdapter {
  protected enhancers: AgentEnhancer[] = [];

  constructor() {
    this.addEnhancer(new CodexExecutionEnhancer());
  }

  public addEnhancer(enhancer: AgentEnhancer): void {
    registerEnhancer(this.enhancers, enhancer);
  }

  public async boot(): Promise<void> {
    logger.info('[UAA] Codex (Exec mode) ready.');
  }

  public async ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse> {
    const trace: Array<{ enhancer: string; action: string; details?: string }> = [];
    const enhanced = await applyEnhancersBeforeAsk(this.enhancers, prompt, options, trace);
    logger.info(`[UAA] Codex Executing prompt: "${summarizePromptForLog(enhanced.prompt)}"`);
    const { spawnSync } = await import('node:child_process');
    
    try {
      // Pass the text as a single argument to npx/codex exec
      const res = spawnSync('npx', ['codex', 'exec', '--json', enhanced.prompt], {
        encoding: 'utf8',
        env: safeEnv(),
        shell: false 
      });

      if (res.error) throw res.error;
      if (res.status !== 0) {
        logger.error(`[UAA] Codex Exit Code: ${res.status}`);
        logger.error(`[UAA] Codex Stderr: ${res.stderr}`);
        return { text: '', stopReason: 'error', trace };
      }

      const parsed = JSON.parse(res.stdout);
      const agentResponse: AgentResponse = {
        text: parsed.message || parsed.content || res.stdout,
        thought: parsed.thought,
        stopReason: 'completed',
        trace
      };
      return applyEnhancersAfterAsk(this.enhancers, agentResponse);
    } catch (e: any) {
      logger.error(`[UAA] Codex Exec failed: ${e.message}`);
      return { text: '', stopReason: 'error', trace };
    }
  }

  public async shutdown(): Promise<void> {}

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      supportsSoftRefresh: false,
      stateless: true,
    };
  }

  public async refreshContext(): Promise<{ mode: 'stateless' }> {
    return { mode: 'stateless' };
  }
}

type BuiltinAgentProvider = 'gemini' | 'codex' | 'claude';

export interface CodexAppServerAdapterOptions {
  model?: string;
  modelProvider?: string;
  cwd?: string;
  systemPrompt?: string;
  approvalPolicy?: any;
  timeoutMs?: number;
  approvalMode?: 'strict' | 'relaxed';
  sandboxMode?: 'workspace-write' | 'read-only' | 'danger-full-access';
  networkAccess?: boolean;
  writableRoots?: string[];
}

/**
 * Codex App Server Adapter (JSON-RPC over stdio).
 */
export class CodexAppServerAdapter implements AgentAdapter {
  private options: CodexAppServerAdapterOptions;
  private child: ChildProcess | null = null;
  private runtimeResourceId: string | null = null;
  private buffer = '';
  private nextId = 1;
  private pendingRequests: Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timeout?: ReturnType<typeof setTimeout> }> = new Map();
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private pendingTurn: { turnId: string; resolve: (res: AgentResponse) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
  private accumulatedText = '';
  private sawAgentDelta = false;
  private logBuffer: { ts: number; type: string; content: string }[] = [];
  private earlyTurnResults: Map<string, { text: string; stopReason: string }> = new Map();
  private projectRoot: string = PROJECT_ROOT;
  private usageSummary: Record<string, unknown> | null = null;
  private enhancers: AgentEnhancer[] = [];

  constructor(options?: CodexAppServerAdapterOptions) {
    this.options = options || {};
    this.addEnhancer(new CodexExecutionEnhancer());
  }

  public addEnhancer(enhancer: AgentEnhancer): void {
    registerEnhancer(this.enhancers, enhancer);
  }

  public getLog(limit = 50): { ts: number; type: string; content: string }[] {
    return this.logBuffer.slice(-limit);
  }

  private getSandboxMode(): 'workspace-write' | 'read-only' | 'danger-full-access' {
    return this.options.sandboxMode || 'workspace-write';
  }

  private buildSandboxPolicy():
    | { type: 'dangerFullAccess' }
    | { type: 'readOnly'; networkAccess: boolean }
    | {
        type: 'workspaceWrite';
        writableRoots?: string[];
        networkAccess: boolean;
        excludeTmpdirEnvVar: boolean;
        excludeSlashTmp: boolean;
      } {
    const sandboxMode = this.getSandboxMode();
    if (sandboxMode === 'danger-full-access') {
      return { type: 'dangerFullAccess' };
    }
    if (sandboxMode === 'read-only') {
      return {
        type: 'readOnly',
        networkAccess: this.options.networkAccess ?? true,
      };
    }
    return {
      type: 'workspaceWrite',
      writableRoots: this.options.writableRoots,
      networkAccess: this.options.networkAccess ?? true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  public async boot(): Promise<void> {
    const cwd = this.options.cwd || process.cwd();
    logger.info(`[UAA] Codex App Server booting (cwd: ${cwd})`);

    this.runtimeResourceId = `codex-app-server:${cwd}`;
    const managed = spawnManagedProcess({
      resourceId: this.runtimeResourceId,
      kind: 'agent',
      ownerId: cwd,
      ownerType: 'agent-adapter',
      command: 'npx',
      args: ['codex', 'app-server', '--listen', 'stdio://'],
      shutdownPolicy: 'manual',
      spawnOptions: {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeEnv(),
      },
      metadata: { cwd },
    });
    this.child = managed.child;

    this.child.stdout?.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr?.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) logger.warn(`[UAA_CODEX_ERR] ${msg}`);
      if (this.runtimeResourceId) touchManagedProcess(this.runtimeResourceId);
    });
    this.child.on('exit', (code, signal) => {
      const err = new Error(`Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      for (const pending of this.pendingRequests.values()) {
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.reject(err);
      }
      this.pendingRequests.clear();
      if (this.pendingTurn) {
        clearTimeout(this.pendingTurn.timeout);
        this.pendingTurn.reject(err);
        this.pendingTurn = null;
      }
    });

    const bootTimeoutMs = this.options.timeoutMs ?? 20000;
    await this.sendRequest('initialize', {
      clientInfo: { name: 'Kyberion', version: '1.0.0' },
      capabilities: { experimentalApi: false, optOutNotificationMethods: [] },
    }, bootTimeoutMs);

    const approvalMode = this.options.approvalMode || 'strict';
    const sandboxMode = this.getSandboxMode();

    const threadRes: any = await this.sendRequest('thread/start', {
      model: this.options.model ?? undefined,
      modelProvider: this.options.modelProvider ?? undefined,
      cwd,
      approvalPolicy: this.options.approvalPolicy ?? (approvalMode === 'relaxed' ? 'never' : 'on-request'),
      sandbox: sandboxMode,
      developerInstructions: this.options.systemPrompt ?? undefined,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }, bootTimeoutMs);

    this.threadId = threadRes?.thread?.id || threadRes?.threadId || null;
    if (!this.threadId) {
      throw new Error(`Codex app-server thread/start missing thread id: ${JSON.stringify(threadRes)}`);
    }
    logger.info(`[UAA] Codex App Server ready. Thread: ${this.threadId}`);
  }

  public async ask(prompt: string, options?: AgentAskOptions): Promise<AgentResponse> {
    if (!this.threadId) throw new Error('Codex app-server not booted.');
    if (this.pendingTurn) throw new Error('Codex app-server is already processing a turn.');

    const trace: Array<{ enhancer: string; action: string; details?: string }> = [];
    const enhanced = await applyEnhancersBeforeAsk(this.enhancers, prompt, options, trace);

    this.accumulatedText = '';
    this.sawAgentDelta = false;
    this.logBuffer.push({ ts: Date.now(), type: 'prompt', content: enhanced.prompt });

    const turnRes: any = await this.sendRequest('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: enhanced.prompt, text_elements: [] }],
      model: this.options.model ?? undefined,
      cwd: this.options.cwd ?? undefined,
      sandboxPolicy: this.buildSandboxPolicy(),
      ...enhanced.options,
    }, this.options.timeoutMs ?? 20000);

    const turnId = turnRes?.turn?.id || turnRes?.turnId;
    if (turnId) this.currentTurnId = turnId;

    if (!turnId) {
      throw new Error(`Codex app-server turn/start missing turn id: ${JSON.stringify(turnRes)}`);
    }

    const early = this.earlyTurnResults.get(turnId);
    if (early) {
      this.earlyTurnResults.delete(turnId);
      return applyEnhancersAfterAsk(this.enhancers, { text: early.text, stopReason: early.stopReason, trace });
    }

    const timeoutMs = this.options.timeoutMs ?? 300000;
    const raw = await new Promise<AgentResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTurn = null;
        reject(new Error('Codex app-server turn timed out.'));
      }, timeoutMs);
      this.pendingTurn = { turnId, resolve, reject, timeout };
    });
    return applyEnhancersAfterAsk(this.enhancers, raw);
  }

  public async shutdown(): Promise<void> {
    if (this.child) {
      if (this.runtimeResourceId) stopManagedProcess(this.runtimeResourceId, this.child);
      this.child = null;
    }
    this.runtimeResourceId = null;
  }

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      pid: this.child?.pid,
      threadId: this.threadId,
      usage: this.usageSummary,
      supportsSoftRefresh: true,
    };
  }

  public async refreshContext(): Promise<{ mode: 'soft'; threadId?: string | null }> {
    if (!this.child) throw new Error('Codex app-server not booted.');
    const cwd = this.options.cwd || process.cwd();
    const approvalMode = this.options.approvalMode || 'strict';
    const sandboxMode = this.getSandboxMode();
    const threadRes: any = await this.sendRequest('thread/start', {
      model: this.options.model ?? undefined,
      modelProvider: this.options.modelProvider ?? undefined,
      cwd,
      approvalPolicy: this.options.approvalPolicy ?? (approvalMode === 'relaxed' ? 'never' : 'on-request'),
      sandbox: sandboxMode,
      developerInstructions: this.options.systemPrompt ?? undefined,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }, this.options.timeoutMs ?? 20000);
    this.threadId = threadRes?.thread?.id || threadRes?.threadId || null;
    return { mode: 'soft', threadId: this.threadId };
  }

  private handleStdout(chunk: Buffer): void {
    if (this.runtimeResourceId) touchManagedProcess(this.runtimeResourceId);
    this.buffer += chunk.toString();
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx >= 0) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        try {
          const msg = JSON.parse(line);
          this.handleMessage(msg);
        } catch (e: any) {
          logger.warn(`[UAA_CODEX_PARSE] Failed to parse JSON: ${e.message}`);
        }
      }
      newlineIdx = this.buffer.indexOf('\n');
    }
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const hasMethod = Object.prototype.hasOwnProperty.call(msg, 'method');
    const hasResult = Object.prototype.hasOwnProperty.call(msg, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(msg, 'error');

    if (hasId && (hasResult || hasError)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (pending.timeout) clearTimeout(pending.timeout);
        if (hasError) {
          const errMsg = msg.error?.message || 'Codex app-server error';
          pending.reject(new Error(errMsg));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (hasMethod && hasId) {
      void this.handleServerRequest(msg);
      return;
    }

    if (hasMethod) {
      this.handleNotification(msg);
    }
  }

  private handleNotification(msg: any): void {
    const method = msg.method;
    const params = msg.params || {};

    if (method === 'item/agentMessage/delta') {
      if (this.threadId && params.threadId && params.threadId !== this.threadId) return;
      if (this.currentTurnId && params.turnId && params.turnId !== this.currentTurnId) return;
      if (typeof params.delta === 'string') {
        this.sawAgentDelta = true;
        this.accumulatedText += params.delta;
      }
      return;
    }

    if (method === 'rawResponseItem/completed') {
      if (this.threadId && params.threadId && params.threadId !== this.threadId) return;
      if (this.currentTurnId && params.turnId && params.turnId !== this.currentTurnId) return;
      if (!this.sawAgentDelta && params.item?.type === 'message' && params.item?.role === 'assistant') {
        const content = Array.isArray(params.item?.content) ? params.item.content : [];
        const text = content
          .filter((c: any) => c?.type === 'output_text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('');
        if (text) this.accumulatedText += text;
      }
      const usage = extractUsageSummary(params);
      if (usage) this.usageSummary = usage;
      return;
    }

    if (method === 'turn/started') {
      const turnId = params.turn?.id;
      if (turnId) this.currentTurnId = turnId;
      return;
    }

    if (method === 'turn/completed') {
      const turnId = params.turn?.id;
      if (!turnId) return;

      const status = params.turn?.status || 'completed';
      const stopReason = status === 'failed' ? 'error' : (status === 'interrupted' ? 'interrupted' : 'completed');
      const finalText = this.accumulatedText;
      this.logBuffer.push({ ts: Date.now(), type: 'agent', content: finalText.slice(0, 500) });
      if (this.logBuffer.length > 200) this.logBuffer = this.logBuffer.slice(-200);
      const result = { text: finalText, stopReason };
      const usage = extractUsageSummary(params);
      if (usage) this.usageSummary = usage;

      if (this.pendingTurn && this.pendingTurn.turnId === turnId) {
        clearTimeout(this.pendingTurn.timeout);
        const resolve = this.pendingTurn.resolve;
        this.pendingTurn = null;
        resolve(result);
      } else {
        this.earlyTurnResults.set(turnId, result);
      }
      return;
    }

    if (method === 'error') {
      logger.error(`[UAA_CODEX_ERR] ${JSON.stringify(params)}`);
    }
  }

  private async handleServerRequest(msg: any): Promise<void> {
    const { id, method, params } = msg;
    const relaxed = this.options.approvalMode === 'relaxed';

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const allow = relaxed || this.isReadOnlyCommand(params);
        this.sendResponse(id, { decision: allow ? 'accept' : 'decline' });
        return;
      }
      case 'item/fileChange/requestApproval': {
        this.sendResponse(id, { decision: relaxed ? 'accept' : 'decline' });
        return;
      }
      case 'item/permissions/requestApproval': {
        this.sendResponse(id, {
          permissions: relaxed ? (params?.permissions || {}) : {},
          scope: relaxed ? 'session' : 'turn',
        });
        return;
      }
      case 'item/tool/requestUserInput': {
        this.sendResponse(id, { answers: {} });
        return;
      }
      case 'item/tool/call': {
        this.sendResponse(id, {
          success: false,
          contentItems: [{ type: 'inputText', text: 'Dynamic tool calls are not supported by Kyberion.' }],
        });
        return;
      }
      case 'mcpServer/elicitation/request': {
        this.sendResponse(id, { action: 'decline' });
        return;
      }
      case 'applyPatchApproval': {
        this.sendResponse(id, { decision: relaxed ? 'approved' : 'denied' });
        return;
      }
      case 'execCommandApproval': {
        const allow = relaxed || this.isReadOnlyParsedCommand(params);
        this.sendResponse(id, { decision: allow ? 'approved' : 'denied' });
        return;
      }
      case 'account/chatgptAuthTokens/refresh': {
        this.sendError(id, -32000, 'ChatGPT auth token refresh not supported');
        return;
      }
      default: {
        this.sendError(id, -32601, `Unsupported request: ${method}`);
      }
    }
  }

  private sendRequest<T>(method: string, params: any, timeoutMs?: number): Promise<T> {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server stdin not writable.');
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.child.stdin.write(`${payload}\n`);
    return new Promise<T>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Codex app-server request timed out (${method}).`));
        }, timeoutMs);
      }
      this.pendingRequests.set(id, { resolve, reject, timeout });
    });
  }

  private sendResponse(id: number | string, result: any): void {
    if (!this.child?.stdin?.writable) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    this.child.stdin.write(`${payload}\n`);
  }

  private sendError(id: number | string, code: number, message: string, data?: any): void {
    if (!this.child?.stdin?.writable) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } });
    this.child.stdin.write(`${payload}\n`);
  }

  private isReadOnlyCommand(params: any): boolean {
    const actions = Array.isArray(params?.commandActions) ? params.commandActions : [];
    if (actions.length === 0) return false;
    if (!this.isCwdAllowed(params?.cwd)) return false;
    return actions.every((action: any) => {
      const type = action?.type;
      if (type === 'read' || type === 'listFiles' || type === 'search') {
        return this.isPathAllowed(action?.path, params?.cwd);
      }
      return false;
    });
  }

  private isReadOnlyParsedCommand(params: any): boolean {
    const parsed = Array.isArray(params?.parsedCmd) ? params.parsedCmd : [];
    if (parsed.length === 0) return false;
    if (!this.isCwdAllowed(params?.cwd)) return false;
    return parsed.every((cmd: any) => {
      const type = cmd?.type;
      if (type === 'read') return this.isPathAllowed(cmd?.path, params?.cwd);
      if (type === 'list_files' || type === 'search') return this.isPathAllowed(cmd?.path, params?.cwd);
      return false;
    });
  }

  private isCwdAllowed(cwd?: string | null): boolean {
    if (!cwd) return true;
    return this.isWithinRoot(cwd);
  }

  private isPathAllowed(targetPath?: string | null, cwd?: string | null): boolean {
    if (!targetPath) return true;
    const base = cwd || this.options.cwd || this.projectRoot;
    const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(base, targetPath);
    return this.isWithinRoot(resolved);
  }

  private isWithinRoot(targetPath: string): boolean {
    const root = path.resolve(this.projectRoot);
    const resolved = path.resolve(targetPath);
    if (resolved === root) return true;
    return resolved.startsWith(root + path.sep);
  }

}

/**
 * Claude Code Adapter using stream-json mode for rich communication.
 *
 * Leverages Claude Code CLI features:
 * - --output-format stream-json: NDJSON streaming responses
 * - --system-prompt: Direct system prompt injection
 * - --allowedTools / --disallowedTools: Native tool restriction
 * - --model: Model selection (sonnet, opus, haiku)
 * - --max-budget-usd: Cost control
 * - --session-id: Session persistence
 */
export interface ClaudeAdapterOptions {
  systemPrompt?: string;
  cwd?: string;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxBudgetUsd?: number;
  sessionId?: string;
  permissionMode?: 'default' | 'plan' | 'auto' | 'bypassPermissions';
}

// Map Kyberion actuator names to Claude Code tool names
const ACTUATOR_TO_CLAUDE_TOOLS: Record<string, string[]> = {
  'file-actuator': ['Read', 'Write', 'Edit', 'Glob'],
  'system-actuator': ['Bash'],
  'browser-actuator': ['WebFetch', 'WebSearch'],
  'code-actuator': ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
  'network-actuator': ['WebFetch', 'WebSearch'],
};

export class ClaudeAdapter implements AgentAdapter {
  private options: ClaudeAdapterOptions;
  private logBuffer: { ts: number; type: string; content: string }[] = [];
  private usageSummary: Record<string, unknown> | null = null;

  constructor(options?: ClaudeAdapterOptions) {
    this.options = options || {};
  }

  public getLog(limit = 50): { ts: number; type: string; content: string }[] {
    return this.logBuffer.slice(-limit);
  }

  public async boot(): Promise<void> {
    logger.info(`[UAA] Claude Code ready (model: ${this.options.model || 'default'}, session: ${this.options.sessionId || 'new'})`);
  }

  public async ask(text: string): Promise<AgentResponse> {
    logger.info(`[UAA] Claude asking: "${text.slice(0, 80)}..."`);
    this.logBuffer.push({ ts: Date.now(), type: 'prompt', content: text });
    const { spawnSync } = await import('node:child_process');

    try {
      const args = ['-p', text, '--output-format', 'json'];

      if (this.options.systemPrompt) {
        args.push('--system-prompt', this.options.systemPrompt);
      }
      if (this.options.model) {
        args.push('--model', this.options.model);
      }
      if (this.options.maxBudgetUsd) {
        args.push('--max-budget-usd', String(this.options.maxBudgetUsd));
      }
      if (this.options.sessionId) {
        args.push('--session-id', this.options.sessionId);
      }
      if (this.options.permissionMode) {
        args.push('--permission-mode', this.options.permissionMode);
      }

      // Tool restrictions from manifest
      if (this.options.allowedTools && this.options.allowedTools.length > 0) {
        args.push('--allowedTools', ...this.options.allowedTools);
      }
      if (this.options.disallowedTools && this.options.disallowedTools.length > 0) {
        args.push('--disallowedTools', ...this.options.disallowedTools);
      }

      const res = spawnSync('claude', args, {
        encoding: 'utf8',
        env: safeEnv(),
        cwd: this.options.cwd || process.cwd(),
        shell: false,
        timeout: 300000, // 5 min for complex tasks
      });

      if (res.error) throw res.error;

      const output = (res.stdout || '').trim();
      if (res.stderr) this.logBuffer.push({ ts: Date.now(), type: 'stderr', content: res.stderr.trim() });
      this.logBuffer.push({ ts: Date.now(), type: 'agent', content: output.slice(0, 500) });
      if (this.logBuffer.length > 200) this.logBuffer = this.logBuffer.slice(-200);
      try {
        const parsed = JSON.parse(output);
        this.usageSummary = extractUsageSummary(parsed);
        return {
          text: parsed.result || parsed.content || parsed.message || output,
          thought: parsed.thought,
          stopReason: res.status === 0 ? 'completed' : 'error',
        };
      } catch (_) {
        // Fallback: treat as plain text
        return { text: output || res.stderr || '', stopReason: res.status === 0 ? 'completed' : 'error' };
      }
    } catch (e: any) {
      logger.error(`[UAA] Claude failed: ${e.message}`);
      return { text: '', stopReason: 'error' };
    }
  }

  public async shutdown(): Promise<void> {}

  public getRuntimeInfo(): Record<string, unknown> {
    return {
      sessionId: this.options.sessionId || null,
      usage: this.usageSummary,
      supportsSoftRefresh: false,
      stateless: !this.options.sessionId,
    };
  }

  /**
   * Convert Kyberion actuator restrictions to Claude Code tool names.
   */
  static resolveToolRestrictions(
    allowedActuators: string[],
    deniedActuators: string[]
  ): { allowedTools: string[]; disallowedTools: string[] } {
    const allowedTools: Set<string> = new Set();
    const disallowedTools: Set<string> = new Set();

    if (allowedActuators.length > 0) {
      for (const actuator of allowedActuators) {
        const tools = ACTUATOR_TO_CLAUDE_TOOLS[actuator];
        if (tools) tools.forEach(t => allowedTools.add(t));
      }
    }

    for (const actuator of deniedActuators) {
      const tools = ACTUATOR_TO_CLAUDE_TOOLS[actuator];
      if (tools) tools.forEach(t => disallowedTools.add(t));
    }

    return {
      allowedTools: allowedTools.size > 0 ? Array.from(allowedTools) : [],
      disallowedTools: Array.from(disallowedTools),
    };
  }
}

export class AgentFactory {
  public static create(provider: BuiltinAgentProvider): AgentAdapter {
    const factory = AGENT_ADAPTER_FACTORIES[provider];
    if (!factory) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    return factory();
  }
}

type AgentAdapterFactory = () => AgentAdapter;

function createCodexAdapterFromEnv(): AgentAdapter {
  const mode = (process.env.KYBERION_CODEX_MODE || 'app-server').toLowerCase();
  if (mode === 'exec' || mode === 'legacy') return new CodexAdapter();
  return new CodexAppServerAdapter({
    model: process.env.KYBERION_CODEX_MODEL,
    modelProvider: process.env.KYBERION_CODEX_MODEL_PROVIDER,
    approvalMode: (process.env.KYBERION_CODEX_APPROVAL || 'strict').toLowerCase() === 'relaxed' ? 'relaxed' : 'strict',
  });
}

const AGENT_ADAPTER_FACTORIES: Record<BuiltinAgentProvider, AgentAdapterFactory> = {
  gemini: () => new GeminiAdapter(),
  codex: () => createCodexAdapterFromEnv(),
  claude: () => new ClaudeAdapter(),
};

function extractUsageSummary(payload: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const usage = (current as any).usage;
    if (usage && typeof usage === 'object') {
      return usage as Record<string, unknown>;
    }
    for (const value of Object.values(current as Record<string, unknown>)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}
