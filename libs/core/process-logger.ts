export type ProcessLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ProcessLogEntry {
  ts: string;
  level: ProcessLogLevel;
  name: string;
  message: string;
  meta?: unknown;
}

export interface ProcessLoggerOptions {
  sink?: (entry: ProcessLogEntry) => void;
}

const REGISTRY = new Map<string, ProcessLogger>();

export class ProcessLogger {
  readonly name: string;
  private readonly sink: (entry: ProcessLogEntry) => void;

  constructor(name: string, options: ProcessLoggerOptions = {}) {
    this.name = name;
    this.sink = options.sink ?? ((entry) => {
      const prefix = `[${entry.name}] ${entry.level.toUpperCase()}`;
      if (entry.level === 'error') console.error(prefix, entry.message);
      else if (entry.level === 'warn') console.warn(prefix, entry.message);
      else console.log(prefix, entry.message);
    });
  }

  private emit(level: ProcessLogLevel, message: string, meta?: unknown): void {
    this.sink({ ts: new Date().toISOString(), level, name: this.name, message, meta });
  }

  debug(message: string, meta?: unknown): void {
    this.emit('debug', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.emit('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.emit('warn', message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.emit('error', message, meta);
  }
}

export function createProcessLogger(name: string, options: ProcessLoggerOptions = {}): ProcessLogger {
  const existing = REGISTRY.get(name);
  if (existing) return existing;
  const logger = new ProcessLogger(name, options);
  REGISTRY.set(name, logger);
  return logger;
}

export function resetProcessLoggerRegistry(): void {
  REGISTRY.clear();
}
