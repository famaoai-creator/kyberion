import path from 'node:path';
import { dispatchA2UI, type A2UIMessage } from './a2ui.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';

export interface ComputerSurfacePatch {
  sessionId: string;
  executor: 'browser' | 'terminal' | 'system';
  status: string;
  latestAction: string;
  target?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
  screenshotPath?: string;
  actionCount?: number;
  updatedAt?: string;
}

const COMPUTER_SURFACE_ID = 'computer-surface';
const COMPUTER_SESSION_DIR = pathResolver.shared('runtime/computer/sessions');
let computerSurfaceCreated = false;

function computerSessionPath(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) {
    throw new Error(`[RESOURCE_PATH_SCOPE] invalid computer session id: ${sessionId}`);
  }
  return assertSafeRepositoryPath(path.join(COMPUTER_SESSION_DIR, `${sessionId}.json`), {
    allowMissingLeaf: true,
  });
}

export function buildComputerSurfaceMessages(patch: ComputerSurfacePatch): A2UIMessage[] {
  computerSessionPath(patch.sessionId);
  const messages: A2UIMessage[] = [];
  if (!computerSurfaceCreated) {
    messages.push({
      createSurface: {
        surfaceId: COMPUTER_SURFACE_ID,
        catalogId: 'computer-surface',
        title: 'Computer Surface',
      },
    });
    computerSurfaceCreated = true;
  }

  messages.push({
    updateDataModel: {
      surfaceId: COMPUTER_SURFACE_ID,
      data: {
        sessionId: patch.sessionId,
        executor: patch.executor,
        status: patch.status,
        latestAction: patch.latestAction,
        target: patch.target || '',
        detail: patch.detail || '',
        metadata: patch.metadata || {},
        screenshotPath: patch.screenshotPath || '',
        actionCount: patch.actionCount || 0,
        updatedAt: patch.updatedAt || new Date().toISOString(),
      },
    },
  });

  return messages;
}

export function emitComputerSurfacePatch(patch: ComputerSurfacePatch): void {
  persistComputerSession(patch);
  for (const message of buildComputerSurfaceMessages(patch)) {
    dispatchA2UI(message);
  }
}

function persistComputerSession(patch: ComputerSurfacePatch): void {
  if (!safeExistsSync(COMPUTER_SESSION_DIR)) {
    safeMkdir(COMPUTER_SESSION_DIR, { recursive: true });
  }

  const sessionPath = computerSessionPath(patch.sessionId);
  safeWriteFile(
    sessionPath,
    JSON.stringify(
      {
        id: patch.sessionId,
        executor: patch.executor,
        status: patch.status,
        latestAction: patch.latestAction,
        target: patch.target || '',
        detail: patch.detail || '',
        metadata: patch.metadata || {},
        screenshotPath: patch.screenshotPath || '',
        actionCount: patch.actionCount || 0,
        updatedAt: patch.updatedAt || new Date().toISOString(),
      },
      null,
      2
    )
  );
}
