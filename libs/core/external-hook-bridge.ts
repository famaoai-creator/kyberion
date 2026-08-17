/**
 * DH-16: adapt external hook configuration into LifecycleHookEngine.
 *
 * The bridge is intentionally a parser/registration layer. It does not
 * import provider SDKs or execute commands itself; command execution remains
 * behind LifecycleHookEngine's secure-io boundary. Claude Code's grouped
 * event format and Codex-style normalized `hooks[]` format converge on the
 * same governed matcher/decision surface.
 */

import {
  LifecycleHookEngine,
  type LifecycleHookEvent,
  type LifecycleHookRegistration,
} from './lifecycle-hook-engine.js';

export type ExternalHookSource = 'claude-code' | 'codex';

export interface ExternalHookBridgeResult {
  registered: number;
  /** Unregister hooks, then drain fires that were already in progress. */
  dispose: () => Promise<void>;
}

const EVENT_MAP: Record<string, LifecycleHookEvent> = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PostToolUseFailure: 'post_tool_use_failure',
  UserPromptSubmit: 'user_prompt_submit',
  Stop: 'stop',
  StopFailure: 'stop_failure',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  Notification: 'notification',
  before_agent_start: 'before_agent_start',
  pre_tool_use: 'pre_tool_use',
  post_tool_use: 'post_tool_use',
  post_tool_use_failure: 'post_tool_use_failure',
  user_prompt_submit: 'user_prompt_submit',
  stop: 'stop',
  stop_failure: 'stop_failure',
  session_start: 'session_start',
  session_end: 'session_end',
  subagent_start: 'subagent_start',
  subagent_stop: 'subagent_stop',
  pre_compact: 'pre_compact',
  post_compact: 'post_compact',
  notification: 'notification',
  tool_call: 'pre_tool_use',
  tool_result: 'post_tool_use',
  agent_start: 'before_agent_start',
  agent_end: 'task_settled',
};

interface ExternalHookCommand {
  type?: string;
  command?: string | string[];
  timeout?: number;
  timeout_ms?: number;
}

interface ExternalHookGroup {
  matcher?: string;
  hooks?: ExternalHookCommand[];
}

interface NormalizedExternalHook {
  event: LifecycleHookEvent;
  matcher?: string;
  command: string | string[];
  timeoutMs?: number;
}

function eventFor(value: unknown): LifecycleHookEvent | undefined {
  return typeof value === 'string' ? EVENT_MAP[value] : undefined;
}

function commandFor(command: unknown): string | string[] | undefined {
  if (typeof command === 'string' && command.trim()) return command;
  if (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === 'string' && part.trim())
  ) {
    return command as string[];
  }
  return undefined;
}

function collectClaudeHooks(config: Record<string, unknown>): NormalizedExternalHook[] {
  const collected: NormalizedExternalHook[] = [];
  for (const [externalEvent, value] of Object.entries(config)) {
    const event = eventFor(externalEvent);
    if (!event || !Array.isArray(value)) continue;
    for (const group of value) {
      if (!group || typeof group !== 'object') continue;
      const typedGroup = group as ExternalHookGroup;
      if (!Array.isArray(typedGroup.hooks)) continue;
      for (const hook of typedGroup.hooks) {
        if (!hook || typeof hook !== 'object') continue;
        if (hook.type && hook.type !== 'command') continue;
        const command = commandFor(hook.command);
        if (!command) continue;
        collected.push({
          event,
          ...(typedGroup.matcher ? { matcher: typedGroup.matcher } : {}),
          command,
          ...(hook.timeout || hook.timeout_ms
            ? { timeoutMs: hook.timeout || hook.timeout_ms }
            : {}),
        });
      }
    }
  }
  return collected;
}

function collectNormalizedHooks(config: Record<string, unknown>): NormalizedExternalHook[] {
  const source = Array.isArray(config.hooks) ? config.hooks : [];
  const collected: NormalizedExternalHook[] = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const event = eventFor(record.event ?? record.hook_event ?? record.name);
    const command = commandFor(record.command);
    if (!event || !command) continue;
    collected.push({
      event,
      ...(typeof record.matcher === 'string' ? { matcher: record.matcher } : {}),
      command,
      ...(typeof record.timeout_ms === 'number'
        ? { timeoutMs: record.timeout_ms }
        : typeof record.timeout === 'number'
          ? { timeoutMs: record.timeout }
          : {}),
    });
  }
  return collected;
}

function toArgv(command: string | string[]): string[] {
  if (Array.isArray(command)) return command;
  // Claude's command hook is a shell command by contract. Keep the shell
  // explicit so the engine still owns process creation and timeout policy.
  return process.platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', command]
    : ['/bin/sh', '-c', command];
}

/** Register an external hook config and return one disposer for the batch. */
export function registerExternalLifecycleHooks(
  engine: LifecycleHookEngine,
  config: Record<string, unknown>,
  source: ExternalHookSource
): ExternalHookBridgeResult {
  const hooks =
    source === 'claude-code' ? collectClaudeHooks(config) : collectNormalizedHooks(config);
  const disposers: Array<() => void> = [];
  hooks.forEach((hook, index) => {
    const registration: LifecycleHookRegistration = {
      id: `external:${source}:${index}`,
      event: hook.event,
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      command: toArgv(hook.command),
      ...(hook.timeoutMs ? { timeoutMs: hook.timeoutMs } : {}),
    };
    disposers.push(engine.register(registration));
  });
  return {
    registered: disposers.length,
    dispose: async () => {
      for (const dispose of disposers.reverse()) dispose();
      await engine.whenIdle();
    },
  };
}
