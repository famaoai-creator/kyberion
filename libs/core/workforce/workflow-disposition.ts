/**
 * Workflow Disposition — human choice on a blocked child WorkItem.
 *
 * Absorbed from PiBot's retry / skip / reassign / accept card. Persistence is
 * through the WorkItem recovery path (not approval-store binary settle).
 *
 * @see knowledge/product/architecture/pibot-absorption-model.md
 */

import { getWorkItem, updateWorkItem, type WorkItem } from './work-coordination.js';

export const WORKFLOW_DISPOSITIONS = ['retry', 'skip', 'reassign', 'accept'] as const;
export type WorkflowDisposition = (typeof WORKFLOW_DISPOSITIONS)[number];

export function isWorkflowDisposition(value: unknown): value is WorkflowDisposition {
  return (
    typeof value === 'string' && (WORKFLOW_DISPOSITIONS as readonly string[]).includes(value)
  );
}

export interface WorkflowDispositionResult {
  item: WorkItem;
  disposition: WorkflowDisposition;
  /** When skip targets a verification step, dependents must not auto-proceed. */
  dependents_blocked: boolean;
}

export interface ApplyWorkflowDispositionInput {
  itemId: string;
  disposition: WorkflowDisposition;
  actorId: string;
  /** Required for reassign — written as assigneePeerId. */
  newOwnerId?: string;
  note?: string;
  /**
   * When true, this WorkItem is a verification / recheck step. Skipping it
   * stops the repair chain (PiBot verdict_recheck_skipped).
   */
  verificationStep?: boolean;
  rootDir?: string;
}

/**
 * Apply a durable disposition via WorkItem status / assignee updates.
 * Unknown actions are refused. Skip on a verification step returns
 * dependents_blocked=true so callers stop repair appends.
 */
export function applyWorkflowDisposition(
  input: ApplyWorkflowDispositionInput
): WorkflowDispositionResult {
  if (!isWorkflowDisposition(input.disposition)) {
    throw new Error(
      `[POLICY_VIOLATION] Unknown workflow disposition: ${String(input.disposition)}`
    );
  }

  const current = getWorkItem(input.itemId, input.rootDir ? { rootDir: input.rootDir } : {});
  if (!current) {
    throw new Error(`[POLICY_VIOLATION] WorkItem not found: ${input.itemId}`);
  }
  if (current.status !== 'blocked' && current.status !== 'review') {
    throw new Error(
      `[POLICY_VIOLATION] Workflow disposition requires a blocked or review WorkItem (got ${current.status})`
    );
  }

  const note = input.note?.trim();
  const meta: Record<string, unknown> = {
    ...(current.metadata || {}),
    workflow_disposition: input.disposition,
    workflow_disposition_at: new Date().toISOString(),
    workflow_disposition_by: input.actorId,
    ...(note ? { workflow_disposition_note: note } : {}),
  };

  switch (input.disposition) {
    case 'retry': {
      const item = updateWorkItem({
        itemId: input.itemId,
        status: 'ready',
        metadata: meta,
        ...(input.rootDir ? { rootDir: input.rootDir } : {}),
      });
      return { item, disposition: 'retry', dependents_blocked: false };
    }
    case 'skip': {
      const item = updateWorkItem({
        itemId: input.itemId,
        status: 'done',
        metadata: {
          ...meta,
          skipped: true,
          ...(input.verificationStep ? { verification_skipped: true } : {}),
        },
        ...(input.rootDir ? { rootDir: input.rootDir } : {}),
      });
      return {
        item,
        disposition: 'skip',
        dependents_blocked: Boolean(input.verificationStep),
      };
    }
    case 'reassign': {
      const newOwnerId = String(input.newOwnerId ?? '').trim();
      if (!newOwnerId) {
        throw new Error('[POLICY_VIOLATION] reassign requires newOwnerId');
      }
      const item = updateWorkItem({
        itemId: input.itemId,
        status: 'ready',
        assigneePeerId: newOwnerId,
        metadata: meta,
        ...(input.rootDir ? { rootDir: input.rootDir } : {}),
      });
      return { item, disposition: 'reassign', dependents_blocked: false };
    }
    case 'accept': {
      const item = updateWorkItem({
        itemId: input.itemId,
        status: 'done',
        metadata: {
          ...meta,
          settlement: 'human_verified',
        },
        ...(input.rootDir ? { rootDir: input.rootDir } : {}),
      });
      return { item, disposition: 'accept', dependents_blocked: false };
    }
  }
}
