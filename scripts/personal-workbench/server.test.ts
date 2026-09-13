import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { isLocalPadOriginAllowed } from '../lib/local-artifact-pad.js';
import {
  main,
  PERSONAL_WORKBENCH_DEFAULT_PORT,
  validatePersonalWorkbenchContentLength,
} from './server.js';
import { executePersonalWorkbenchAction } from './actions.js';

describe('personal workbench', () => {
  it('validates configuration in public dry-run mode', async () => {
    const result = await main(['--dry-run', '--tier', 'public'], { dryRun: true });
    expect(result).toMatchObject({
      ok: true,
      mode: 'dry-run',
      port: PERSONAL_WORKBENCH_DEFAULT_PORT,
      listening: false,
    });
  });

  it('requires a tenant for personal operation', async () => {
    await expect(main(['--dry-run'], { dryRun: true })).rejects.toThrow(
      'requires server-side KYBERION_TENANT scope'
    );
  });

  it('bounds declared request size and keeps capture proposal-only', () => {
    expect(validatePersonalWorkbenchContentLength('10')).toBe(10);
    expect(() => validatePersonalWorkbenchContentLength('not-a-number')).toThrow();
    const source = readTextFile(pathResolver.rootResolve('scripts/personal-workbench/server.ts'));
    expect(source).toContain("option(args, '--tier') || 'personal'");
    expect(source).toContain("req.headers['x-pw-token']");
    expect(source).toContain('isLocalPadOriginAllowed');
    expect(source).toContain('requires_human_approval: true');
    expect(source).toContain('Capture stores proposals only');
    expect(source).not.toContain('node:fs');
    expect(source).not.toContain("action: 'knowledge'");
    expect(source).not.toContain('id="approval"');
  });

  it('allows only localhost origins', () => {
    expect(isLocalPadOriginAllowed(undefined)).toBe(true);
    expect(isLocalPadOriginAllowed('http://127.0.0.1:8154')).toBe(true);
    expect(isLocalPadOriginAllowed('http://localhost:8154')).toBe(true);
    expect(isLocalPadOriginAllowed('https://evil.example')).toBe(false);
  });

  it('keeps email draft-only and blocks calendar mutation from the pad', async () => {
    const context = {
      session_id: 'pwb-test',
      artifact_ref: 'active/shared/tmp/personal-workbench',
      viewer_principal: 'personal-test',
      scope: { scope_kind: 'tenant' as const, tier: 'personal' as const, tenant_slug: 'test' },
    };
    await expect(
      executePersonalWorkbenchAction({
        action: 'calendar',
        payload: {
          summary: 'Call',
          start: '2026-09-14T10:00:00+09:00',
          end: '2026-09-14T10:30:00+09:00',
        },
        approved: true,
        context,
        evidenceRef: 'active/shared/tmp/personal-workbench/handoff.json',
      })
    ).rejects.toThrow('calendar changes are not executed from personal-workbench');

    await expect(
      executePersonalWorkbenchAction({
        action: 'knowledge',
        payload: { summary: 'decision note' },
        context,
        evidenceRef: 'active/shared/tmp/personal-workbench/missing-handoff.json',
      })
    ).rejects.toThrow('knowledge enqueue requires an existing evidence handoff file');

    const actionsSource = readTextFile(
      pathResolver.rootResolve('scripts/personal-workbench/actions.ts')
    );
    expect(actionsSource).toContain('draft_mode: true');
    expect(actionsSource).toContain('approved: false');
    expect(actionsSource).not.toContain('createCalendarEvent');
  });
});
