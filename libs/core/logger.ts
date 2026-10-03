/**
 * Structured Logger - provides leveled, structured logging for skills.
 *
 * Canonical console engine for Kyberion CLI output: level thresholds,
 * quiet gating, consecutive-duplicate compression and the diagnostic line
 * format all live here so every emitter shares one behavior. See
 * knowledge/product/governance/logging-policy.md.
 */

import { nowIso } from './foundation/time.js';
import { getRegisteredEnvText } from './foundation/env.js';

export const LOG_LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface LoggerOptions {
  level?: string;
  json?: boolean;
}

export type ConsoleStream = 'stdout' | 'stderr';

export function isQuietProcess(): boolean {
  return (
    getRegisteredEnvText('LOG_LEVEL') === 'silent' ||
    process.argv.includes('--quiet') ||
    process.argv.includes('--json')
  );
}

/** Resolve the active level threshold; levels below it are dropped. */
export function resolveLogThreshold(explicit?: string): number {
  return LOG_LEVELS[explicit || getRegisteredEnvText('LOG_LEVEL') || 'info'] ?? LOG_LEVELS.info;
}

// --- consecutive-duplicate compression -----------------------------------
// When the same logical message (same key) is emitted back-to-back on one
// stream, later copies are buffered as a count. The streak ends when a
// different line is written (or the process exits), producing a single
// "(repeated ×N)" marker instead of N identical lines. warn/error lines are
// never compressed — anomalies must stay loud.

interface RepeatState {
  key: string;
  count: number;
  marker: (count: number) => string;
}

const repeatState = new Map<ConsoleStream, RepeatState>();
let exitFlushRegistered = false;

function writeLine(stream: ConsoleStream, line: string): void {
  if (stream === 'stdout') {
    process.stdout.write(line + '\n');
  } else {
    process.stderr.write(line + '\n');
  }
}

function flushRepeat(stream: ConsoleStream): void {
  const state = repeatState.get(stream);
  if (!state) return;
  repeatState.delete(stream);
  if (state.count > 1) writeLine(stream, state.marker(state.count));
}

/** Flush any pending "repeated ×N" marker on both streams (safe to call anytime). */
export function flushRepeatMarkers(): void {
  flushRepeat('stdout');
  flushRepeat('stderr');
}

// One process-wide 'exit' listener shared by every evaluation of this module.
// Re-evaluating it (vi.resetModules, bundler duplicates) previously added a
// fresh listener per instance — 11 instances tripped MaxListenersExceeded on
// `process`. Each instance now enrolls its flusher in a global set instead.
const EXIT_FLUSH_KEY = Symbol.for('@kyberion/logger-exit-flush');

function registerExitFlush(): void {
  if (exitFlushRegistered) return;
  exitFlushRegistered = true;
  const scope = globalThis as { [EXIT_FLUSH_KEY]?: Set<() => void> };
  let flushers = scope[EXIT_FLUSH_KEY];
  if (!flushers) {
    const created = new Set<() => void>();
    flushers = created;
    scope[EXIT_FLUSH_KEY] = created;
    process.once('exit', () => {
      for (const flush of created) {
        try {
          flush();
        } catch {
          // One instance failing to flush must not drop the others' markers.
        }
      }
    });
  }
  flushers.add(flushRepeatMarkers);
}

export interface EmitOptions {
  /** Logical identity of the message; identical keys on the same stream compress. */
  key?: string;
  /** Set false to disable compression (warn/error do this by default at call sites). */
  dedup?: boolean;
  /** Marker rendered once when a repeat streak ends. Default reprints the line count. */
  marker?: (count: number) => string;
}

/**
 * Write one fully-rendered line, compressing consecutive duplicates.
 * `key` identifies the logical message; when it matches the previous emit on
 * the same stream, the line is counted instead of written. A different line
 * (or process exit) flushes a single repeat marker.
 */
export function emitConsoleLine(
  stream: ConsoleStream,
  line: string,
  options: EmitOptions = {}
): void {
  const dedup = options.dedup !== false && options.key !== undefined;
  registerExitFlush();
  const state = repeatState.get(stream);
  if (dedup && state && state.key === options.key) {
    state.count += 1;
    return;
  }
  flushRepeat(stream);
  writeLine(stream, line);
  if (dedup) {
    repeatState.set(stream, {
      key: options.key!,
      count: 1,
      // `count` is total occurrences including the already-printed line, so
      // every emitter's marker reads "repeated ×N" with the same meaning.
      marker: options.marker ?? ((count) => `[${nowIso()}] … (previous line repeated ×${count})`),
    });
  }
}

// --- diagnostic format -----------------------------------------------------
// warn/error convention: one line that an LLM or human can act on directly.
// [component] what — why | next: <action> | evidence: <path>

export interface DiagnosticInput {
  component: string;
  what: string;
  why?: string;
  next?: string;
  evidence?: string;
}

export function formatDiagnostic(diag: DiagnosticInput): string {
  let line = `[${diag.component}] ${diag.what}`;
  if (diag.why) line += ` — ${diag.why}`;
  if (diag.next) line += ` | next: ${diag.next}`;
  if (diag.evidence) line += ` | evidence: ${diag.evidence}`;
  return line;
}

// --- named structured logger ----------------------------------------------

export function createLogger(name: string, options: LoggerOptions = {}) {
  // Resolve the threshold per call when no explicit level was pinned, so a
  // mid-run LOG_LEVEL change affects already-constructed loggers the same way
  // it affects the core.ts facade.
  const levelAt = () => resolveLogThreshold(options.level);
  const json = options.json || getRegisteredEnvText('LOG_FORMAT') === 'json';

  function _format(lvl: string, msg: string, data: any) {
    const ts = nowIso();
    if (json) {
      return JSON.stringify({ ts, level: lvl, skill: name, msg, ...data });
    }
    const prefix = `[${ts}] [${lvl.toUpperCase()}] [${name}]`;
    if (data && Object.keys(data).length > 0) {
      return `${prefix} ${msg} ${JSON.stringify(data)}`;
    }
    return `${prefix} ${msg}`;
  }

  function _log(lvl: string, msg: string, data: any) {
    if (isQuietProcess() && lvl !== 'error') return;
    const rank = LOG_LEVELS[lvl] ?? LOG_LEVELS.info;
    if (rank < levelAt()) return;
    const line = _format(lvl, msg, data);
    // Anomalies are always written immediately and never compressed.
    if (lvl === 'debug' || lvl === 'info') {
      emitConsoleLine('stderr', line, {
        key: `${lvl} ${name} ${msg} ${JSON.stringify(data ?? null)}`,
        marker: (count) =>
          `[${nowIso()}] [${lvl.toUpperCase()}] [${name}] … (repeated above ×${count})`,
      });
    } else {
      emitConsoleLine('stderr', line, { dedup: false });
    }
  }

  return {
    debug: (msg: string, data?: any) => _log('debug', msg, data),
    info: (msg: string, data?: any) => _log('info', msg, data),
    warn: (msg: string, data?: any) => _log('warn', msg, data),
    error: (msg: string, data?: any) => _log('error', msg, data),
    child: (childName: string) => createLogger(`${name}:${childName}`, options),
  };
}
