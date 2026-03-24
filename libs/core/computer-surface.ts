import { dispatchA2UI, type A2UIMessage } from './a2ui.js';

export interface ComputerSurfacePatch {
  sessionId: string;
  executor: 'browser' | 'terminal' | 'system';
  status: string;
  latestAction: string;
  target?: string;
  detail?: string;
  screenshotPath?: string;
  actionCount?: number;
  updatedAt?: string;
}

const COMPUTER_SURFACE_ID = 'computer-surface';
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
        screenshotPath: patch.screenshotPath || '',
        actionCount: patch.actionCount || 0,
        updatedAt: patch.updatedAt || new Date().toISOString(),
      },
    },
  });

  return messages;
}

export function emitComputerSurfacePatch(patch: ComputerSurfacePatch): void {
  for (const message of buildComputerSurfaceMessages(patch)) {
    dispatchA2UI(message);
  }
}
