import { runtimeStatePath } from './foundation/runtime-state-roots.js';
import { pathResolver } from './path-resolver.js';
import { safeChmodSync, safeExecResult, safeExistsSync, safeMkdir } from './secure-io.js';
import { resolveAgentDesktopBin } from './tool/tool-binary-resolvers.js';

/**
 * Governed bridge to the optional `agent-desktop` managed tool runtime.
 *
 * The binary is the Vercel Labs AX-tree computer-use CLI. Kyberion never
 * requires it: every capability check fails closed to `TOOL_UNAVAILABLE`
 * when the runtime is absent, and all invocations go through this module so
 * the subcommand surface stays allowlisted, the runtime state directory is
 * redirected into the governed runtime floor (refmaps and traces contain
 * screen content), and sessions are namespaced per caller.
 */

const AGENT_DESKTOP_HOME_SUBPATH = runtimeStatePath('desktopAx.agentDesktopHome').physicalPath;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

/**
 * Subcommands the bridge may invoke — mutating vs observation is the
 * caller's governance concern. Headed/physical-input commands (`hover`,
 * `drag`, `mouse-*`, `double/triple-click`, `key-down/up`) stay excluded:
 * upstream refuses them without `--headed`, and physical input already has
 * a governed channel (marks + CGEvent) that carries its own approvals.
 */
const ALLOWED_COMMANDS = new Set([
  'snapshot',
  'find',
  'get',
  'is',
  'click',
  'right-click',
  'type',
  'press',
  'scroll',
  'scroll-to',
  'set-value',
  'select',
  'clear',
  'focus',
  'toggle',
  'check',
  'uncheck',
  'expand',
  'collapse',
  'list-windows',
  'list-apps',
  'list-displays',
  'list-surfaces',
  'list-notifications',
  'session',
  'version',
]);

export interface AgentDesktopAvailability {
  available: boolean;
  bin?: string;
  version?: string;
  detail?: string;
}

export interface AgentDesktopDisposition {
  delivery?: string;
  retry?: string;
}

export interface AgentDesktopEnvelope {
  ok: boolean;
  command?: string;
  data?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
  disposition?: AgentDesktopDisposition;
}

export type AgentDesktopResult =
  | { ok: true; envelope: AgentDesktopEnvelope }
  | {
      ok: false;
      code: string;
      message: string;
      disposition?: AgentDesktopDisposition;
      envelope?: AgentDesktopEnvelope;
    };

function agentDesktopHome(): string {
  const home = pathResolver.rootResolve(AGENT_DESKTOP_HOME_SUBPATH);
  safeMkdir(home, { recursive: true, mode: 0o700 });
  try {
    // agent-desktop refuses a state dir readable by group/other; the runtime
    // floor inherits permissive defaults, so enforce owner-only explicitly.
    safeChmodSync(home, 0o700);
  } catch {
    // Non-fatal on platforms without POSIX chmod semantics.
  }
  return home;
}

/** Resolve the governed binary path, or null when the tool runtime is absent. */
export function agentDesktopBinPath(): string | null {
  try {
    const bin = resolveAgentDesktopBin();
    return bin && safeExistsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** Capability probe — cheap, no side effects beyond the state directory mkdir. */
export function agentDesktopAvailability(): AgentDesktopAvailability {
  const bin = agentDesktopBinPath();
  if (!bin) {
    return {
      available: false,
      detail:
        'agent-desktop runtime is not installed; install via `pnpm tool:setup -- --tool agent_desktop --apply` or set KYBERION_AGENT_DESKTOP_BIN',
    };
  }
  const probe = safeExecResult(bin, ['version'], {
    env: agentDesktopEnv(),
    timeoutMs: 15_000,
    maxOutputMB: 1,
  });
  if (probe.status !== 0) {
    return {
      available: false,
      bin,
      detail: `agent-desktop probe failed: ${probe.stderr.trim() || `exit ${probe.status}`}`,
    };
  }
  // `version` prints a JSON envelope ({ok,data:{version,os,target}}); surface
  // the version field when present, else the trimmed output.
  const envelope = parseEnvelope(probe.stdout);
  const version =
    envelope?.data && typeof envelope.data === 'object'
      ? ((envelope.data as Record<string, unknown>).version as string | undefined)
      : undefined;
  return { available: true, bin, version: version ?? probe.stdout.trim() ?? 'unknown' };
}

function agentDesktopEnv(sessionId?: string): Record<string, string | undefined> {
  return {
    ...process.env,
    // An external managed binary never inherits Kyberion's role authority —
    // SYSTEM_ROLE stays cleared so the child cannot act under our identity.
    SYSTEM_ROLE: '',
    AGENT_DESKTOP_HOME: agentDesktopHome(),
    ...(sessionId ? { AGENT_DESKTOP_SESSION: sessionId } : {}),
  };
}

function parseEnvelope(stdout: string): AgentDesktopEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? (parsed as AgentDesktopEnvelope) : null;
  } catch {
    return null;
  }
}

/**
 * agent-desktop generates its own session ids (`session start` returns
 * `data.session_id`); the caller's session id is recorded as the session
 * `--name`. This map keeps the caller→runtime session association in-process —
 * a cold start simply mints a fresh session, and refs stay fail-closed because
 * they are already scoped to their allocating snapshot namespace.
 */
const sessionIdsByCaller = new Map<string, string>();

/**
 * Ensure an agent-desktop session exists for the caller's session id and
 * return the runtime session id to place in `AGENT_DESKTOP_SESSION`.
 */
export function ensureAgentDesktopSession(sessionId: string): AgentDesktopResult & {
  runtimeSessionId?: string;
} {
  const bin = agentDesktopBinPath();
  if (!bin) {
    return {
      ok: false,
      code: 'TOOL_UNAVAILABLE',
      message: 'agent-desktop runtime is not installed',
    };
  }
  const cached = sessionIdsByCaller.get(sessionId);
  if (cached) return { ok: true, envelope: { ok: true }, runtimeSessionId: cached };
  const started = safeExecResult(bin, ['session', 'start', '--name', sessionId], {
    env: agentDesktopEnv(),
    timeoutMs: 15_000,
    maxOutputMB: 1,
  });
  const envelope = parseEnvelope(started.stdout);
  const runtimeSessionId =
    envelope?.data && typeof envelope.data === 'object'
      ? (envelope.data as Record<string, unknown>).session_id
      : undefined;
  if (started.status !== 0 || !envelope?.ok || typeof runtimeSessionId !== 'string') {
    return {
      ok: false,
      code: 'SESSION_UNAVAILABLE',
      message:
        envelope?.error?.message ??
        started.stderr.trim() ??
        `session start exited ${started.status}`,
    };
  }
  sessionIdsByCaller.set(sessionId, runtimeSessionId);
  registerDrainHook();
  return { ok: true, envelope, runtimeSessionId };
}

/**
 * Seal the runtime session(s) associated with a caller id and evict the
 * mapping. `session end` takes the minted runtime id; when the in-process
 * map misses (e.g. a fresh Kyberion process cleaning up older sessions),
 * sessions are resolved by their `--name` label instead. The host daemon
 * stops serving an ended session and exits on its own idle clock.
 */
export function endAgentDesktopSession(sessionId: string): AgentDesktopResult {
  const bin = agentDesktopBinPath();
  if (!bin) {
    return {
      ok: false,
      code: 'TOOL_UNAVAILABLE',
      message: 'agent-desktop runtime is not installed',
    };
  }
  const runtimeIds = new Set<string>();
  const cached = sessionIdsByCaller.get(sessionId);
  if (cached) runtimeIds.add(cached);
  if (runtimeIds.size === 0) {
    const listed = safeExecResult(bin, ['session', 'list'], {
      env: agentDesktopEnv(),
      timeoutMs: 15_000,
      maxOutputMB: 2,
    });
    const envelope = parseEnvelope(listed.stdout);
    const sessions =
      envelope?.data && typeof envelope.data === 'object'
        ? (envelope.data as Record<string, unknown>).sessions
        : undefined;
    if (Array.isArray(sessions)) {
      for (const entry of sessions) {
        const record = entry as Record<string, unknown>;
        if (
          record.name === sessionId &&
          typeof record.session_id === 'string' &&
          !record.ended_at
        ) {
          runtimeIds.add(record.session_id);
        }
      }
    }
    if (runtimeIds.size === 0) {
      sessionIdsByCaller.delete(sessionId);
      return { ok: true, envelope: { ok: true } };
    }
  }
  let lastError: string | undefined;
  for (const runtimeId of runtimeIds) {
    const ended = safeExecResult(bin, ['session', 'end', runtimeId], {
      env: agentDesktopEnv(),
      timeoutMs: 15_000,
      maxOutputMB: 1,
    });
    const envelope = parseEnvelope(ended.stdout);
    if (ended.status !== 0 || envelope?.ok === false) {
      lastError = envelope?.error?.message ?? ended.stderr.trim() ?? `exit ${ended.status}`;
    }
  }
  sessionIdsByCaller.delete(sessionId);
  return lastError
    ? { ok: false, code: 'SESSION_END_FAILED', message: lastError }
    : { ok: true, envelope: { ok: true } };
}

/**
 * Best-effort drain of every runtime session this process minted, followed
 * by `session gc`. Registered once on process exit when the first session
 * is minted — the upstream command host otherwise lingers until its own
 * idle timeout, and unsealed manifests outlive the caller. SafeExec is
 * synchronous, so this also runs inside an `exit` handler.
 */
export function drainAgentDesktopSessions(): void {
  for (const callerId of [...sessionIdsByCaller.keys()]) {
    try {
      endAgentDesktopSession(callerId);
    } catch {
      // Best-effort: never throw out of an exit path.
    }
  }
  try {
    gcAgentDesktopSessions();
  } catch {
    // Best-effort.
  }
}

let drainHookRegistered = false;
function registerDrainHook(): void {
  if (drainHookRegistered || typeof process?.once !== 'function') return;
  drainHookRegistered = true;
  process.once('exit', drainAgentDesktopSessions);
}

/** Remove ended / provably-stale session manifests from the runtime floor. */
export function gcAgentDesktopSessions(): AgentDesktopResult {
  const bin = agentDesktopBinPath();
  if (!bin) {
    return {
      ok: false,
      code: 'TOOL_UNAVAILABLE',
      message: 'agent-desktop runtime is not installed',
    };
  }
  const result = safeExecResult(bin, ['session', 'gc'], {
    env: agentDesktopEnv(),
    timeoutMs: 30_000,
    maxOutputMB: 2,
  });
  const envelope = parseEnvelope(result.stdout);
  if (result.status !== 0 || envelope?.ok === false) {
    return {
      ok: false,
      code: 'SESSION_GC_FAILED',
      message:
        envelope?.error?.message ?? result.stderr.trim() ?? `session gc exited ${result.status}`,
    };
  }
  return { ok: true, envelope: envelope ?? { ok: true } };
}

export interface AgentDesktopCallOptions {
  sessionId?: string;
  timeoutMs?: number;
  /** Skip the automatic session bootstrap (observation commands that do not need one). */
  requireSession?: boolean;
  /** Internal: set by the session-eviction retry so it can fire at most once. */
  _sessionRetried?: boolean;
}

/**
 * Invoke an allowlisted agent-desktop subcommand and return the parsed JSON
 * envelope. Never throws for process/envelope failures — callers classify the
 * structured result instead. `AGENT_DESKTOP_SESSION` scopes the snapshot
 * namespace to the caller's session id.
 */
export function runAgentDesktopCommand(
  args: string[],
  options: AgentDesktopCallOptions = {}
): AgentDesktopResult {
  const bin = agentDesktopBinPath();
  if (!bin) {
    return {
      ok: false,
      code: 'TOOL_UNAVAILABLE',
      message: 'agent-desktop runtime is not installed',
    };
  }
  const command = args[0];
  if (!command || !ALLOWED_COMMANDS.has(command)) {
    return {
      ok: false,
      code: 'COMMAND_NOT_ALLOWED',
      message: `agent-desktop subcommand is not allowlisted: ${command ?? '(none)'}`,
    };
  }
  let runtimeSessionId: string | undefined;
  if (options.sessionId && options.requireSession !== false) {
    const session = ensureAgentDesktopSession(options.sessionId);
    if (!session.ok) return session;
    runtimeSessionId = session.runtimeSessionId;
  }
  let result = safeExecResult(bin, args, {
    env: agentDesktopEnv(runtimeSessionId),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputMB: MAX_ENVELOPE_BYTES / (1024 * 1024),
  });
  const envelope = parseEnvelope(result.stdout);
  if (!envelope) {
    return {
      ok: false,
      code: 'ENVELOPE_MALFORMED',
      message:
        result.stderr.trim() ||
        `agent-desktop produced no JSON envelope (exit ${result.status ?? 'signal'})`,
    };
  }
  if (envelope.ok === false || envelope.error) {
    const code = String(envelope.error?.code ?? 'ACTION_FAILED');
    // A cached session id can go stale (runtime gc / idle expiry). Evict and
    // re-mint once — a genuinely absent session is not a retryable guess.
    if (
      options.sessionId &&
      runtimeSessionId &&
      !options._sessionRetried &&
      /SESSION/i.test(code)
    ) {
      sessionIdsByCaller.delete(options.sessionId);
      const session = ensureAgentDesktopSession(options.sessionId);
      if (session.ok && session.runtimeSessionId !== runtimeSessionId) {
        return runAgentDesktopCommand(args, { ...options, _sessionRetried: true });
      }
    }
    return {
      ok: false,
      code,
      message: String(envelope.error?.message ?? `agent-desktop ${command} failed`),
      disposition: envelope.disposition,
      envelope,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      code: 'ACTION_FAILED',
      message: result.stderr.trim() || `agent-desktop ${command} exited ${result.status}`,
      envelope,
    };
  }
  return { ok: true, envelope };
}
