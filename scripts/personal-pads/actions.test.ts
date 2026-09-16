import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeWriteFile } from '@agent/core/secure-io';
import { createLocalPadContext } from '../lib/local-artifact-pad.js';
import { executePadAction, getPadActionAvailability, getPadActionDescriptors } from './actions.js';

const context = createLocalPadContext({
  serviceId: 'personal-pads',
  sessionPrefix: 'action-test',
  artifact_ref: 'local-pads',
  viewer_principal: 'human:alice',
  tier: 'confidential',
  tenant_slug: 'tenant-a',
});

describe('personal pad action seam', () => {
  it('publishes safe action descriptors from adapters', () => {
    expect(getPadActionDescriptors('meeting-notepad').map((action) => action.id)).toEqual([
      'meeting.transcribe',
      'meeting.minutes',
    ]);
    expect(getPadActionDescriptors('screenshot-annotate')[0]).toMatchObject({
      id: 'screenshot.capture-screen',
      capability: 'os-screenshot',
    });
    expect(getPadActionDescriptors('personal-workbench').map((action) => action.id)).toEqual([
      'workbench.email-draft',
      'workbench.calendar-propose',
      'workbench.calendar-apply',
      'workbench.calendar-reconcile',
      'workbench.ocr-extract',
      'workbench.knowledge-propose',
    ]);
  });

  it('keeps working-memory read unavailable outside personal tenant scope', async () => {
    const result = await executePadAction({
      pad_id: 'daily-desk',
      action_id: 'daily.load-working-memory',
      title: '',
      body: '',
      fields: {},
      context,
      storage_root: 'active/shared/local-pads',
    });
    expect(result).toMatchObject({
      action_id: 'daily.load-working-memory',
      status: 'unavailable',
    });
  });

  it('binds working-memory reads to the viewer principal inside a tenant', async () => {
    const root = pathResolver.sharedTmp(`personal-pads-working-memory-${Date.now()}`);
    const owner = createHash('sha256').update('human:alice').digest('hex').slice(0, 24);
    safeWriteFile(
      path.join(root, 'tenant-a', 'owners', owner, 'journal.md'),
      'Alice private journal',
      { mkdir: true, encoding: 'utf8' }
    );
    const previous = process.env.KYBERION_WORKING_MEMORY_ROOT;
    process.env.KYBERION_WORKING_MEMORY_ROOT = root;
    try {
      const alice = await executePadAction({
        pad_id: 'daily-desk',
        action_id: 'daily.load-working-memory',
        title: '',
        body: '',
        fields: {},
        context: { ...context, scope: { ...context.scope, tier: 'personal' } },
        storage_root: root,
      });
      expect(alice).toMatchObject({
        draft_patch: { fields: { journal: 'Alice private journal' } },
      });
      const bob = await executePadAction({
        pad_id: 'daily-desk',
        action_id: 'daily.load-working-memory',
        title: '',
        body: '',
        fields: {},
        context: {
          ...context,
          viewer_principal: 'human:bob',
          scope: { ...context.scope, tier: 'personal' },
        },
        storage_root: root,
      });
      expect(bob).toMatchObject({ draft_patch: { fields: { journal: '' } } });
    } finally {
      if (previous === undefined) delete process.env.KYBERION_WORKING_MEMORY_ROOT;
      else process.env.KYBERION_WORKING_MEMORY_ROOT = previous;
    }
  });

  it('reads an explicitly requested historical period without falling back to another day', async () => {
    const root = pathResolver.sharedTmp(`personal-pads-working-memory-period-${Date.now()}`);
    const owner = createHash('sha256').update('human:alice').digest('hex').slice(0, 24);
    safeWriteFile(
      path.join(root, 'tenant-a', 'owners', owner, 'daily', '2026-09-01', 'journal.md'),
      'September first',
      { mkdir: true, encoding: 'utf8' }
    );
    const previous = process.env.KYBERION_WORKING_MEMORY_ROOT;
    process.env.KYBERION_WORKING_MEMORY_ROOT = root;
    try {
      const result = await executePadAction({
        pad_id: 'daily-desk',
        action_id: 'daily.load-working-memory',
        title: '',
        body: '',
        fields: { period_key: '2026-09-01' },
        context: { ...context, scope: { ...context.scope, tier: 'personal' } },
        storage_root: root,
      });
      expect(result).toMatchObject({
        draft_patch: { fields: { journal: 'September first', period_key: '2026-09-01' } },
        result: { period_key: '2026-09-01' },
      });
    } finally {
      if (previous === undefined) delete process.env.KYBERION_WORKING_MEMORY_ROOT;
      else process.env.KYBERION_WORKING_MEMORY_ROOT = previous;
    }
  });

  it('reports capability readiness without executing an action', () => {
    expect(
      getPadActionAvailability('screenshot-annotate', 'screenshot.capture-screen')
    ).toMatchObject({
      action_id: 'screenshot.capture-screen',
      status: expect.stringMatching(/ready|permission_required|unavailable/),
    });
  });

  it('rejects undeclared actions before execution', async () => {
    await expect(
      executePadAction({
        pad_id: 'memory-capture',
        action_id: 'shell.exec',
        title: '',
        body: '',
        fields: {},
        context,
        storage_root: 'active/shared/local-pads',
      })
    ).rejects.toThrow('unknown pad action');
  });

  it('dispatches typed workbench actions without a generic metadata switch', async () => {
    const result = await executePadAction({
      pad_id: 'personal-workbench',
      action_id: 'workbench.calendar-propose',
      title: '予定提案',
      body: '',
      fields: {
        calendar_summary: '設計レビュー',
        calendar_start: '2026-09-30T10:00:00+09:00',
        calendar_end: '2026-09-30T10:30:00+09:00',
      },
      context,
      storage_root: pathResolver.sharedTmp(`personal-pads-actions-${Date.now()}`),
    });
    expect(result).toMatchObject({
      action_id: 'workbench.calendar-propose',
      status: 'approval_required',
      result: { approval_request_id: expect.any(String) },
    });
    await expect(
      executePadAction({
        pad_id: 'personal-workbench',
        action_id: 'workbench.execute',
        title: '',
        body: '',
        fields: {},
        context,
        storage_root: pathResolver.sharedTmp(`personal-pads-actions-${Date.now()}`),
      })
    ).rejects.toThrow('unknown pad action');
  });

  it('keeps email drafts local and redacts implementation paths', async () => {
    const result = await executePadAction({
      pad_id: 'personal-workbench',
      action_id: 'workbench.email-draft',
      title: '下書き',
      body: '',
      fields: {
        email_to: 'alice@example.com',
        email_subject: 'レビュー',
        email_body: '確認をお願いします。',
      },
      context: { ...context, scope: { ...context.scope, tier: 'personal' } },
      storage_root: pathResolver.sharedTmp(`personal-pads-email-${Date.now()}`),
    });
    expect(result).toMatchObject({
      action_id: 'workbench.email-draft',
      status: 'succeeded',
      result: { delivery: 'local-only', draft_only: true },
    });
    expect(JSON.stringify(result)).not.toContain('active/shared');
  });
});
