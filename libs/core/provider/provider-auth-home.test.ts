import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  safeSymlinkSync,
  safeLinkExclusiveSync,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext } from '../authority.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import { buildProviderChildEnv } from './provider-permission-profiles.js';
import { assertIsolatedProviderHome } from './provider-auth-home.js';
const tenant = 'auth-home-tenant';
const root = pathResolver.rootResolve(
  `active/shared/tmp/confidential/${tenant}/provider-auth/vitest-${randomUUID()}`
);
const home = path.join(root, 'home');
const scoped = <T>(run: () => T) =>
  withExecutionContext('sovereign_concierge', run, 'sovereign', tenant);
beforeEach(() => vi.stubEnv('KYBERION_TIER', 'confidential'));
afterEach(() => {
  scoped(() => safeRmSync(root, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});
describe('provider auth HOME spawn fence', () => {
  it('restamps canonical child identity and refuses authority supplied in the credential environment', () =>
    withExecutionContext(
      'sovereign_concierge',
      () => {
        safeMkdir(home, { recursive: true });
        withTaskCredentialBinding(
          {
            tenantSlug: tenant,
            secrets: {},
            providerEnvironments: {
              codex: {
                HOME: home,
                KYBERION_TENANT: 'another-tenant',
                MISSION_ID: 'MSN-FOREIGN',
                KYBERION_TASK_ID: 'foreign-task',
                KYBERION_SUDO: 'true',
                KYBERION_PERSONA: 'sovereign',
                KYBERION_DELEGATED_ROLE: 'mission_controller',
                AUTHORIZED_SCOPE: 'all',
              },
            },
          },
          () => {
            const env = buildProviderChildEnv({ provider: 'codex' });
            expect(env).toMatchObject({
              KYBERION_TENANT: tenant,
              MISSION_ID: 'MSN-AUTH-HOME',
              KYBERION_TASK_ID: 'task-auth-home',
            });
            for (const key of [
              'KYBERION_SUDO',
              'KYBERION_PERSONA',
              'KYBERION_DELEGATED_ROLE',
              'AUTHORIZED_SCOPE',
            ])
              expect(env[key]).toBeUndefined();
          }
        );
      },
      'sovereign',
      tenant,
      undefined,
      { missionId: 'MSN-AUTH-HOME', taskId: 'task-auth-home' }
    ));
  it('allows a private tenant floor HOME and revalidates before every spawn', () =>
    scoped(() => {
      safeMkdir(home, { recursive: true });
      safeWriteFile(path.join(home, 'auth.json'), '{}');
      withTaskCredentialBinding(
        {
          tenantSlug: tenant,
          secrets: {},
          providerEnvironments: { codex: { HOME: home, CODEX_HOME: home, PATH: '/bin' } },
        },
        () => {
          expect(buildProviderChildEnv({ provider: 'codex' }).HOME).toBe(home);
          safeSymlinkSync(path.join(home, 'auth.json'), path.join(home, 'alias'));
          expect(() => buildProviderChildEnv({ provider: 'codex' })).toThrow(
            'CREDENTIAL_HOME_INVALID'
          );
        }
      );
    }));
  it('refuses operator/outside/other-tenant/public/legacy homes before metadata access', () => {
    for (const bad of [
      '/operator-home',
      pathResolver.rootDir(),
      pathResolver.rootResolve('active/shared/tmp/vitest-home'),
      pathResolver.rootResolve('active/shared/tmp/confidential/another-tenant/provider-auth/home'),
      pathResolver.rootResolve(`active/shared/tmp/public/${tenant}/provider-auth/home`),
    ])
      expect(() => assertIsolatedProviderHome({ HOME: bad }, tenant)).toThrow(
        'CREDENTIAL_HOME_INVALID'
      );
  });
  it('rejects symlinked ancestors, hard links and excessive tree depth', () =>
    scoped(() => {
      safeMkdir(home, { recursive: true });
      safeWriteFile(path.join(home, 'auth.json'), '{}');
      const alias = path.join(root, 'home-alias');
      safeSymlinkSync(home, alias);
      expect(() => assertIsolatedProviderHome({ HOME: alias }, tenant)).toThrow(
        'CREDENTIAL_HOME_INVALID'
      );
      safeLinkExclusiveSync(path.join(home, 'auth.json'), path.join(home, 'auth-copy.json'));
      expect(() => assertIsolatedProviderHome({ HOME: home }, tenant)).toThrow(
        'CREDENTIAL_HOME_INVALID'
      );
      safeRmSync(path.join(home, 'auth-copy.json'));
      safeMkdir(path.join(home, ...Array.from({ length: 14 }, () => 'nested')), {
        recursive: true,
      });
      expect(() => assertIsolatedProviderHome({ HOME: home }, tenant)).toThrow(
        'CREDENTIAL_HOME_INVALID'
      );
    }));
});
