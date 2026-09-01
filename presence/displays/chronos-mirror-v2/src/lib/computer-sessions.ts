import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeReaddir,
} from '@agent/core/secure-io';
import { ptyEngine } from '@agent/core/pty-engine';
import path from 'node:path';
import { parseJsonRecord, stringField, numberField } from './json-record';

export interface ComputerSessionSummary {
  id: string;
  kind: 'browser' | 'terminal' | 'system';
  status: string;
  updatedAt: string;
  pid?: number;
  target?: string;
  detail?: string;
  actionCount?: number;
  metadata?: Record<string, unknown>;
}

export interface ComputerSessionCollectionOptions {
  computerSessionDir?: string;
  browserSessionDir?: string;
}

function sessionKind(value: unknown): ComputerSessionSummary['kind'] {
  return value === 'browser' || value === 'terminal' || value === 'system' ? value : 'system';
}

function safeSessionDirectory(directory: string): string | null {
  try {
    const safeDirectory = assertSafeRepositoryPath(directory, { allowMissingLeaf: true });
    return safeExistsSync(safeDirectory) && safeLstat(safeDirectory).isDirectory()
      ? safeDirectory
      : null;
  } catch {
    return null;
  }
}

function safeSessionFile(directory: string, file: string): string | null {
  try {
    const filePath = assertSafeRepositoryPath(path.join(directory, file), {
      allowMissingLeaf: true,
    });
    return safeExistsSync(filePath) && safeLstat(filePath).isFile() ? filePath : null;
  } catch {
    return null;
  }
}

export function collectComputerSessions(
  options: ComputerSessionCollectionOptions = {}
): ComputerSessionSummary[] {
  const sessions = new Map<string, ComputerSessionSummary>();

  const governedSessionDir = safeSessionDirectory(
    options.computerSessionDir || pathResolver.resolve('active/shared/runtime/computer/sessions')
  );
  if (governedSessionDir) {
    for (const file of safeReaddir(governedSessionDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const sessionFile = safeSessionFile(governedSessionDir, file);
        if (!sessionFile) continue;
        const raw = safeReadFile(sessionFile, { encoding: 'utf8' }) as string;
        const parsed = parseJsonRecord(raw);
        if (!parsed) continue;
        const id = stringField(parsed, 'id', file.replace(/\.json$/, ''));
        sessions.set(id, {
          id,
          kind: sessionKind(parsed.executor),
          status: stringField(parsed, 'status', 'unknown'),
          updatedAt: stringField(parsed, 'updatedAt', new Date(0).toISOString()),
          target: typeof parsed.target === 'string' ? parsed.target : undefined,
          detail: stringField(parsed, 'detail', stringField(parsed, 'latestAction', '')),
          actionCount: numberField(parsed, 'actionCount', 0),
          metadata:
            parsed.metadata &&
            typeof parsed.metadata === 'object' &&
            !Array.isArray(parsed.metadata)
              ? (parsed.metadata as Record<string, unknown>)
              : {},
        });
      } catch {
        // ignore malformed computer session metadata
      }
    }
  }

  const browserSessionDir = safeSessionDirectory(
    options.browserSessionDir || pathResolver.resolve('active/shared/runtime/browser/sessions')
  );
  if (browserSessionDir) {
    for (const file of safeReaddir(browserSessionDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const sessionFile = safeSessionFile(browserSessionDir, file);
        if (!sessionFile) continue;
        const raw = safeReadFile(sessionFile, { encoding: 'utf8' }) as string;
        const parsed = parseJsonRecord(raw);
        if (!parsed) continue;
        const id = stringField(parsed, 'session_id', file.replace(/\.json$/, ''));
        if (sessions.has(id)) continue;
        sessions.set(id, {
          id,
          kind: 'browser',
          status: stringField(parsed, 'lease_status', 'unknown'),
          updatedAt: stringField(parsed, 'updated_at', new Date(0).toISOString()),
          pid:
            typeof parsed.pid === 'number' && Number.isFinite(parsed.pid) ? parsed.pid : undefined,
          target: typeof parsed.active_tab_id === 'string' ? parsed.active_tab_id : undefined,
          detail: `${numberField(parsed, 'tab_count', 0)} tabs`,
          actionCount: numberField(parsed, 'action_trail_count', 0),
        });
      } catch {
        // ignore malformed browser session metadata
      }
    }
  }

  for (const sessionId of ptyEngine.list()) {
    if (sessions.has(sessionId)) continue;
    const session = ptyEngine.get(sessionId);
    sessions.set(sessionId, {
      id: sessionId,
      kind: 'terminal',
      status: session?.status || 'unknown',
      updatedAt: new Date(session?.lastUpdated || Date.now()).toISOString(),
      pid: session?.adapter.pid,
      detail: session?.status === 'running' ? 'interactive shell' : 'terminal session',
    });
  }

  return Array.from(sessions.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
