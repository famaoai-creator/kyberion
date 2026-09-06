/**
 * I/O used by foundational JSON and catalog helpers.
 *
 * Foundation helpers are intentionally unusable until secure-io has installed
 * the governed implementation. A raw filesystem fallback here would let a
 * direct foundation import bypass tier, tenant, size, and audit checks.
 */
export interface FoundationIo {
  loadJson<T>(filePath: string, options?: FoundationReadOptions): T;
  loadJsonIfPresent<T>(filePath: string, options?: FoundationReadOptions): T | null;
  appendFile(filePath: string, content: string): void;
  exists(filePath: string): boolean;
  readFile(filePath: string, options?: FoundationReadOptions): string;
  stat(filePath: string): { mtimeMs: number; size: number };
  writeFile(filePath: string, content: string): void;
}

export interface FoundationReadOptions {
  maxSizeMB?: number;
  label?: string;
}

// Keep the registration stable across test module resets. This is a registry
// of the already-governed implementation, never a filesystem fallback.
const FOUNDATION_IO_REGISTRY_KEY = Symbol.for('kyberion.foundation.io');

function foundationIoRegistry(): { current?: FoundationIo } {
  const globals = globalThis as typeof globalThis & {
    [FOUNDATION_IO_REGISTRY_KEY]?: { current?: FoundationIo };
  };
  return (globals[FOUNDATION_IO_REGISTRY_KEY] ??= {});
}

export function registerFoundationIo(io: FoundationIo): void {
  foundationIoRegistry().current = io;
}

export function getFoundationIo(): FoundationIo {
  const foundationIo = foundationIoRegistry().current;
  if (!foundationIo) {
    throw new Error('secure_foundation_io_not_registered');
  }
  return foundationIo;
}
