import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

const fixture = vi.hoisted(() => ({ root: '', viewer: undefined as unknown }));
vi.mock('@agent/core/profile-root', () => ({ resolveActiveProfileRoot: () => fixture.root }));
vi.mock('../../../../lib/api-guard', () => ({ requireConciergeMutationAccess: vi.fn(() => null) }));
vi.mock('../../../../lib/viewer-context', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/viewer-context')>(
    '../../../../lib/viewer-context'
  );
  return { ...actual, resolveConciergeViewer: vi.fn(() => fixture.viewer) };
});
vi.mock('../../../../lib/i18n', async () => {
  const actual =
    await vi.importActual<typeof import('../../../../lib/i18n')>('../../../../lib/i18n');
  return { ...actual, conciergeText: vi.fn((key: string) => key) };
});

import { POST } from '../route';
import { GET } from './route';
import {
  _setAvatarScriptRunnerForTests,
  type AvatarScriptRunner,
} from '../../../../lib/avatar-generation-jobs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3]);
const owner = {
  context: {
    role: 'localadmin',
    source: 'loopback',
    principalId: 'human:concierge-localadmin',
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
  },
};

function post(body: unknown) {
  return POST({
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as NextRequest);
}
function get(query = '') {
  return GET({
    nextUrl: new URL(`http://localhost/api/setup/avatar-generation${query}`),
  } as unknown as NextRequest);
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function writeGeneratedSet() {
  const dir = path.join(fixture.root, 'avatar');
  safeMkdir(dir, { recursive: true });
  safeWriteFile(path.join(dir, 'neutral.png'), PNG);
  safeWriteFile(
    path.join(dir, 'avatar-profile.json'),
    JSON.stringify({ version: 1, images: { neutral: 'neutral.png' }, provider_id: 'gemini_image' })
  );
}

describe('concierge avatar generation job flow', () => {
  let runner: ReturnType<typeof vi.fn<AvatarScriptRunner>>;

  beforeEach(() => {
    fixture.root = pathResolver.sharedTmp(`concierge-avatar-job-${process.pid}`);
    fixture.viewer = owner;
    safeMkdir(fixture.root, { recursive: true });
    safeWriteFile(path.join(fixture.root, 'avatar.png'), PNG);
    runner = vi.fn<AvatarScriptRunner>();
    _setAvatarScriptRunnerForTests(runner);
  });
  afterEach(() => {
    _setAvatarScriptRunnerForTests(null);
    safeRmSync(fixture.root, { recursive: true, force: true });
  });

  it('plans the provider for the consent dialog without sending anything', async () => {
    runner.mockResolvedValue({
      status: 0,
      stderr: '',
      stdout: `noise\nAVATAR_PLAN ${JSON.stringify({
        plan: {
          provider_id: 'gemini_image',
          display_name: 'Google Gemini API',
          data_egress: 'cloud',
          requires_consent: true,
          interactive_handoff: false,
        },
      })}`,
    });
    const body = await (await get()).json();
    expect(body).toMatchObject({
      ok: true,
      photo_available: true,
      plan: {
        provider_id: 'gemini_image',
        display_name: 'Google Gemini API',
        data_egress: 'cloud',
      },
      avatar: null,
    });
    expect(runner.mock.calls[0]![0]).toContain('--plan');
    expect(runner.mock.calls[0]![0]).not.toContain('--consent-provider');
  });

  it('refuses to start without a confirmed consent', async () => {
    expect((await post({ action: 'avatar_generate' })).status).toBe(400);
    expect(
      (await post({ action: 'avatar_generate', consent: { provider_id: 'gemini_image' } })).status
    ).toBe(400);
    expect(
      (
        await post({
          action: 'avatar_generate',
          consent: { provider_id: '../x', confirmed: true },
        })
      ).status
    ).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it('denies a token viewer', async () => {
    fixture.viewer = { context: { ...owner.context, source: 'token' } };
    const res = await post({
      action: 'avatar_generate',
      consent: { provider_id: 'gemini_image', confirmed: true },
    });
    expect(res.status).toBe(403);
    expect(runner).not.toHaveBeenCalled();
  });

  it('runs the job with the consent bound to the owner principal, then reports success', async () => {
    let finish: (value: Awaited<ReturnType<AvatarScriptRunner>>) => void = () => undefined;
    runner.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const started = await post({
      action: 'avatar_generate',
      consent: { provider_id: 'gemini_image', confirmed: true },
    });
    expect(started.status).toBe(202);
    const { job } = await started.json();
    expect(job.status).toBe('running');
    const args = runner.mock.calls[0]![0];
    expect(args).toEqual(
      expect.arrayContaining([
        '--bridge-preference',
        'gemini_image',
        '--consent-provider',
        'gemini_image',
        '--consent-granted-by',
        'human:concierge-localadmin',
      ])
    );
    expect(args[args.indexOf('--input-photo') + 1]).toBe(
      pathResolver.toRepoRelative(path.join(fixture.root, 'avatar.png'))
    );
    // A second run is refused while the first is running.
    expect(
      (
        await post({
          action: 'avatar_generate',
          consent: { provider_id: 'gemini_image', confirmed: true },
        })
      ).status
    ).toBe(409);

    writeGeneratedSet();
    finish({
      status: 0,
      stderr: '',
      stdout: `AVATAR_SET_RESULT ${JSON.stringify({ status: 'succeeded', provider_id: 'gemini_image' })}`,
    });
    await flush();
    const status = await (await get(`?job=${job.id}`)).json();
    expect(status).toMatchObject({
      ok: true,
      job: { id: job.id, status: 'succeeded', provider_id: 'gemini_image' },
      avatar: { images: { neutral: '/api/me/avatar/neutral' }, adopted: false },
    });
  });

  it('reports a host hand-off and a consent refusal as distinct outcomes', async () => {
    runner.mockResolvedValueOnce({
      status: 100,
      stderr: '',
      stdout: `AVATAR_SET_RESULT ${JSON.stringify({ status: 'handoff' })}`,
    });
    const handoff = await (
      await post({
        action: 'avatar_generate',
        consent: { provider_id: 'host_agent', confirmed: true },
      })
    ).json();
    await flush();
    expect((await (await get(`?job=${handoff.job.id}`)).json()).job).toMatchObject({
      status: 'handoff',
      handoff_manifest: 'active/shared/tmp/avatar-set-handoff.json',
    });

    runner.mockResolvedValueOnce({
      status: 1,
      stderr: '[avatar:generate] Avatar generation failed: [IMAGE_REFERENCE_EGRESS_DENIED] x',
      stdout: '',
    });
    const refused = await (
      await post({
        action: 'avatar_generate',
        consent: { provider_id: 'gemini_image', confirmed: true },
      })
    ).json();
    await flush();
    const job = (await (await get(`?job=${refused.job.id}`)).json()).job;
    expect(job).toMatchObject({ status: 'failed', reason: 'consent_denied' });
    expect(JSON.stringify(job)).not.toContain('IMAGE_REFERENCE');
  });

  it('treats exit 0 without a success verdict as a failure', async () => {
    runner.mockResolvedValue({ status: 0, stderr: '', stdout: 'done' });
    const { job } = await (
      await post({
        action: 'avatar_generate',
        consent: { provider_id: 'local_flux', confirmed: true },
      })
    ).json();
    await flush();
    expect((await (await get(`?job=${job.id}`)).json()).job.status).toBe('failed');
    expect((await get('?job=not-a-job')).status).toBe(404);
  });

  it('adopts the generated set via the identity avatar_profile pointer', async () => {
    expect((await post({ action: 'avatar_use' })).status).toBe(409);
    writeGeneratedSet();
    safeWriteFile(path.join(fixture.root, 'my-identity.json'), JSON.stringify({ name: 'me' }));
    const res = await post({ action: 'avatar_use' });
    expect(res.status).toBe(200);
    const identity = JSON.parse(
      String(safeReadFile(path.join(fixture.root, 'my-identity.json'), { encoding: 'utf8' }))
    );
    expect(identity).toMatchObject({ name: 'me', avatar_profile: 'avatar/avatar-profile.json' });
  });
});
