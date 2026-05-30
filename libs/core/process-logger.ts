import * as nodePath from 'node:path';
import { sharedLogsProcess } from './path-resolver.js';
import {
  safeAppendFileSync,
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
    return sharedLogsProcess(`${this.name}.log`);
  }

  private writeToFile(entry: ProcessLogEntry): void {
    try {
      const filePath = this.logFilePath();
      const dir = nodePath.dirname(filePath);
      safeMkdir(dir, { recursive: true });
      this.maybeRotate(filePath);
      safeAppendFileSync(filePath, JSON.stringify(entry) + '\n');
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
      ts: new Date().toISOString(),
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

export function createProcessLogger(name: string, options: ProcessLoggerOptions = {}): ProcessLogger {
  const existing = REGISTRY.get(name);
  if (existing) return existing;
  const log = new ProcessLogger(name, options);
  REGISTRY.set(name, log);
  return log;
}

export function resetProcessLoggerRegistry(): void {
  REGISTRY.clear();
}
