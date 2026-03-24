import path from 'node:path';
import { dispatchA2UI, type A2UIMessage } from './a2ui.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';

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

export function buildComputerSurfaceMessages(patch: ComputerSurfacePatch): A2UIMessage[] {
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

  const sessionPath = path.join(COMPUTER_SESSION_DIR, `${patch.sessionId}.json`);
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
      2,
    ),
  );
}
