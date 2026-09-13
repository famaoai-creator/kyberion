import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
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

  it('bounds declared request size and keeps sensitive behavior behind auth/handoff', () => {
    expect(validatePersonalWorkbenchContentLength('10')).toBe(10);
    expect(() => validatePersonalWorkbenchContentLength('not-a-number')).toThrow();
    const source = readTextFile(pathResolver.rootResolve('scripts/personal-workbench/server.ts'));
    expect(source).toContain("option(args, '--tier') || 'personal'");
    expect(source).toContain("req.headers['x-pw-token']");
    expect(source).toContain('requires_human_approval: true');
    expect(source).not.toContain('node:fs');
  });

  it('keeps external personal actions behind explicit approval', async () => {
    const context = {
      session_id: 'pwb-test',
      artifact_ref: 'active/shared/tmp/personal-workbench',
      viewer_principal: 'personal-test',
      scope: { scope_kind: 'tenant' as const, tier: 'personal' as const, tenant_slug: 'test' },
    };
    await expect(
      executePersonalWorkbenchAction({
        action: 'email',
        payload: { to: 'person@example.com', body_markdown: 'hello' },
        context,
        evidenceRef: 'active/shared/tmp/personal-workbench/handoff.json',
      })
    ).rejects.toThrow('email sending requires explicit human approval');
    await expect(
      executePersonalWorkbenchAction({
        action: 'calendar',
        payload: {
          summary: 'Call',
          start: '2026-09-14T10:00:00+09:00',
          end: '2026-09-14T10:30:00+09:00',
        },
        context,
        evidenceRef: 'active/shared/tmp/personal-workbench/handoff.json',
      })
    ).rejects.toThrow('calendar changes requires explicit human approval');
  });
});
