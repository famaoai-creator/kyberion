import { appendJsonLine } from './foundation/json.js';
import { getRegisteredEnvBool, getRegisteredEnvText, isVitestProcess } from './foundation/env.js';
import { setLogFileSink, type LogRecord } from './logger.js';
import { nowIso } from './foundation/time.js';
import * as nodePath from 'node:path';
import { sharedLogsProcess } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeStat,
  safeMoveSync,
} from './secure-io.js';

export type ProcessLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<ProcessLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface ProcessLogEntry {
  ts: string;
  level: ProcessLogLevel;
  name: string;
  msg: string;
  meta?: unknown;
}

export interface ProcessLoggerOptions {
  minLevel?: ProcessLogLevel;
  maxSizeBytes?: number;
  maxRotations?: number;
  sink?: (entry: ProcessLogEntry) => void;
}

const REGISTRY = new Map<string, ProcessLogger>();

export class ProcessLogger {
  readonly name: string;
  private readonly minLevel: number;
  private readonly maxSizeBytes: number;
  private readonly maxRotations: number;
  private readonly sink: (entry: ProcessLogEntry) => void;

  constructor(name: string, options: ProcessLoggerOptions = {}) {
    this.name = name;
    this.minLevel = LEVEL_RANK[options.minLevel ?? 'debug'];
    this.maxSizeBytes = options.maxSizeBytes ?? 10 * 1024 * 1024;
    this.maxRotations = options.maxRotations ?? 5;

    if (options.sink) {
      this.sink = options.sink;
    } else {
      this.sink = (entry) => this.writeToFile(entry);
    }
  }

  private logFilePath(): string {
    return assertSafeRepositoryPath(sharedLogsProcess(`${this.name}.log`), {
      allowMissingLeaf: true,
    });
  }

  private writeToFile(entry: ProcessLogEntry): void {
    try {
      const filePath = this.logFilePath();
      const dir = nodePath.dirname(filePath);
      safeMkdir(dir, { recursive: true });
      this.maybeRotate(filePath);
      appendJsonLine(filePath, entry);
    } catch {
      // silently swallow write errors so the logger never throws
    }
  }

  private maybeRotate(filePath: string): void {
    if (!safeExistsSync(filePath)) return;
    try {
      const stat = safeStat(filePath);
      if (stat.size < this.maxSizeBytes) return;
      // Rotate: .log.N → .log.N+1, .log → .log.1
      for (let i = this.maxRotations - 1; i >= 1; i--) {
        const src = `${filePath}.${i}`;
        const dest = `${filePath}.${i + 1}`;
        if (safeExistsSync(src)) safeMoveSync(src, dest);
      }
      safeMoveSync(filePath, `${filePath}.1`);
    } catch {
      // rotation failure is non-fatal
    }
  }

  private emit(level: ProcessLogLevel, msg: string, meta?: unknown): void {
    if (LEVEL_RANK[level] < this.minLevel) return;
    const entry: ProcessLogEntry = {
      ts: nowIso(),
      level,
      name: this.name,
      msg,
      ...(meta !== undefined ? { meta } : {}),
    };
    this.sink(entry);
  }

  debug(msg: string, meta?: unknown): void {
    this.emit('debug', msg, meta);
  }

  info(msg: string, meta?: unknown): void {
    this.emit('info', msg, meta);
  }

  warn(msg: string, meta?: unknown): void {
    this.emit('warn', msg, meta);
  }

  error(msg: string, meta?: unknown): void {
    this.emit('error', msg, meta);
  }
}

export function createProcessLogger(
  name: string,
  options: ProcessLoggerOptions = {}
): ProcessLogger {
  const existing = REGISTRY.get(name);
  if (existing) return existing;
  const log = new ProcessLogger(name, options);
  REGISTRY.set(name, log);
  return log;
}

export function resetProcessLoggerRegistry(): void {
  REGISTRY.clear();
}

/**
 * Stream name for this process's log file: the entry script's basename
 * (`dist/scripts/run_doctor.js` → `run_doctor`), so each command keeps its own
 * rotated file under `active/shared/logs/process/`.
 */
export function processLogNameFromArgv(argv: readonly string[] = process.argv): string {
  const entry = argv[1] ? nodePath.basename(argv[1]).replace(/\.(c|m)?(j|t)s$/u, '') : '';
  const safe = entry.replace(/[^A-Za-z0-9._-]/gu, '_').replace(/^\.+/u, '');
  return safe || 'node';
}

function toProcessLogLevel(level: string): ProcessLogLevel {
  if (level === 'success') return 'info';
  return level in LEVEL_RANK ? (level as ProcessLogLevel) : 'info';
}

/**
 * Tee every logger line of this process into
 * `active/shared/logs/process/<entry>.log` (JSONL, size-rotated). Skipped in
 * tests and when `KYBERION_PROCESS_LOG` is `0`/`false`/`off`.
 */
export function installProcessLogFileSink(): void {
  if (getRegisteredEnvBool('KYBERION_PROCESS_LOG', { defaultValue: true }) === false) return;
  if (isVitestProcess() || getRegisteredEnvText('NODE_ENV') === 'test') return;
  let log: ProcessLogger | null = null;
  setLogFileSink((record: LogRecord) => {
    // Resolve lazily: launchers such as run_built.mjs rewrite argv before import.
    log ??= createProcessLogger(processLogNameFromArgv());
    const missionId = getRegisteredEnvText('MISSION_ID');
    const meta = {
      pid: process.pid,
      emitter: record.name,
      ...(missionId ? { mission: missionId } : {}),
      ...(record.data !== undefined ? { data: record.data } : {}),
    };
    log[toProcessLogLevel(record.level)](record.msg, meta);
  });
}
