import { expect, it, vi } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';

const f = useOnboardingAuthorityFixture();

it('uses installed owner consent for a real standalone PR boundary and respects revocation', async () => {
  const authority = await import('../authority.js');
  const runtime = await import('./onboarding-authority-runtime.js');
  const github = await import('../vcs/github.js');
  const io = await import('../secure-io.js');
  f.run(() => {
    const request = f.request();
    f.approve(request.request_id);
    f.api.applyOnboardingAuthority(f.principal, { kind: 'person' }, request.request_id);
  });
  let mutations = 0;
  let repository = 'https://github.com/fixture/repo';
  const runner = (bin: string, args: string[]) => {
    let stdout = '';
    if (bin === 'git') {
      if (args[0] === 'remote') stdout = repository + '.git';
      if (args[0] === 'rev-parse') stdout = 'a'.repeat(40);
      if (args[0] === 'symbolic-ref') stdout = 'feature';
    } else if (args[0] === 'repo')
      stdout = JSON.stringify({ nameWithOwner: 'fixture/repo', url: repository });
    else if (args[0] === 'api') stdout = JSON.stringify({ sha: 'a'.repeat(40) });
    else if (args[0] === 'pr' && args[1] === 'create') {
      mutations++;
      stdout = repository + '/pull/7';
    }
    return { status: 0, stdout, stderr: '' };
  };
  const create = (id: string) => {
    vi.stubEnv('SYSTEM_ROLE', 'chronos_mirror_v2');
    try {
      return authority.withExecutionContext('chronos_operator', () =>
        runtime.withInstalledOnboardingAuthority(id, () => {
          expect(authority.resolveRole()).toBe('chronos_operator');
          expect(() =>
            io.safeReadFile(f.root + '/knowledge/personal/agent-identity.json')
          ).toThrow();
          return github.ghPrCreate(
            {
              cwd: f.root,
              title: 'Synthetic review',
              body: 'Public fixture',
              head: 'feature',
              base: 'main',
            },
            runner
          );
        })
      );
    } finally {
      vi.stubEnv('SYSTEM_ROLE', 'concierge');
    }
  };
  expect(create('standalone-first').status).toBe(0);
  expect(mutations).toBe(1);
  repository = 'https://github.com/fixture/other';
  expect(() => create('standalone-wrong-target')).toThrow();
  expect(mutations).toBe(1);
  repository = 'https://github.com/fixture/repo';
  f.run(() => {
    const input = { ...f.input(), mode: 'revoke' as const };
    const request = f.request(input);
    f.approve(request.request_id);
    f.api.applyOnboardingAuthority(f.principal, { kind: 'person' }, request.request_id);
  });
  expect(() => create('standalone-revoked')).toThrow();
  expect(mutations).toBe(1);
});
