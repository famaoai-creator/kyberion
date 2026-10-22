import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeRmSync,
} from '@agent/core/secure-io';
import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
  FIRST_JOB_TEST_SESSION_KEY,
  FIRST_JOB_TEST_ISSUER,
  FIRST_JOB_TEST_SUBJECT,
} from './fixtures/first-job-approval-fixture.js';

// Real policy, secure IO, lease, registry, authorization, and journal projection.
const sourceRoot = process.cwd();
const root = path.join(
  sourceRoot,
  'active/shared/tmp/people-management-integration-' + process.pid
);
const tenant = 'people-fixture';
const organizationId = 'people-operations';
const screenshot = path.join(
  root,
  'active/shared/artifacts/confidential/' + tenant + '/people-browser.png'
);
let authority: typeof import('@agent/core/authority');
let agents: typeof import('@agent/core/organization/organization-agent-management');
let members: typeof import('@agent/core/organization/member-management');
let participants: typeof import('@agent/core/organization/organization-participants');
const auth = {
  memberId: 'owner',
  actorId: 'user:owner',
  tenantSlug: tenant,
  allowedOrganizationIds: 'all' as const,
  allowedProjectIds: 'all' as const,
};
const principal = { memberId: 'owner', allowedTenantSlugs: [tenant] };
const owner = <T>(run: () => T) =>
  authority.withExecutionContext('sovereign_concierge', run, undefined, tenant);

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  const manifest = 'libs/actuators/browser-actuator/manifest.json';
  safeMkdir(path.dirname(path.join(root, manifest)), { recursive: true });
  safeWriteFile(
    path.join(root, manifest),
    safeReadFile(path.join(sourceRoot, manifest), { encoding: 'utf8' })
  );
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const key of [
    'MISSION_ID',
    'SYSTEM_ROLE',
    'KYBERION_SUDO',
    'KYBERION_TENANT',
    'KYBERION_ORGANIZATION',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('MISSION_ROLE', 'sovereign_concierge');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign_concierge');
  vi.resetModules();
  authority = await import('@agent/core/authority');
  const registry = await import('@agent/core/organization/member-registry');
  const tenants = await import('@agent/core/organization/tenant-governance');
  const organizations = await import('@agent/core/organization/organization-management');
  const identity = await import('@agent/core/agent/agent-identity');
  agents = await import('@agent/core/organization/organization-agent-management');
  members = await import('@agent/core/organization/member-management');
  participants = await import('@agent/core/organization/organization-participants');
  owner(() =>
    tenants.mutateTenant({
      verb: 'create',
      slug: tenant,
      displayName: 'Synthetic people fixture',
      apply: true,
      actor: 'integration-fixture',
    })
  );
  owner(() => registry.writeMemberProfile(syntheticFirstJobOwner(tenant)));
  owner(() =>
    organizations.createManagedOrganization({
      organizationId,
      tenantSlug: tenant,
      tier: 'confidential',
      name: 'Operations',
    })
  );
  identity.resetAgentIdentityServiceForTests(
    'active/shared/tmp/people-identities/identities.jsonl'
  );
}, 60_000);

afterAll(() => {
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  if (safeExistsSync(screenshot)) {
    const evidence = path.join(
      sourceRoot,
      'active/shared/tmp/people-browser-evidence-' + process.pid + '.png'
    );
    safeWriteFile(evidence, safeReadFile(screenshot, { encoding: null }));
    process.stdout.write('PEOPLE_BROWSER_SCREENSHOT ' + evidence + '\n');
  }
  safeRmSync(root, { recursive: true, force: true });
});

describe('people management through real secure IO', () => {
  it('creates a member, reads uniqueness inputs, and rejects a duplicate external identity', async () => {
    const result = await members.createManagedMember(principal, {
      memberId: 'alice',
      displayName: 'Alice',
      tenantSlug: tenant,
      role: 'operator',
    });
    expect(result.member.member_id).toBe('alice');
    await members.updateManagedMember(principal, {
      memberId: 'alice',
      externalIdentity: { issuer: 'https://people.example', subject: 'alice' },
    });
    await expect(
      members.updateManagedMember(principal, {
        memberId: 'owner',
        externalIdentity: { issuer: 'https://people.example', subject: 'alice' },
      })
    ).rejects.toThrow();
    expect(
      (await members.listManagedMembers(principal, tenant)).map((row) => row.member_id)
    ).toContain('alice');
  });
  it('issues, activates, transfers accountability, and suspends with lease IO enabled', async () => {
    const issued = await agents.issueManagedOrganizationAgent(auth, {
      organizationId,
      slug: 'helper',
      accountableHumanId: 'user:owner',
    });
    const active = await agents.changeManagedOrganizationAgentLifecycle(auth, {
      nhiId: issued.nhi_id,
      action: 'activate',
      expectedVersion: issued.version,
    });
    expect(active.lifecycle_status).toBe('active');
    const reassigned = await agents.reassignManagedOrganizationAgentAccountable(auth, {
      nhiId: issued.nhi_id,
      accountableHumanId: 'user:alice',
      reason: 'Synthetic transfer',
      expectedVersion: active.version,
    });
    expect(reassigned.accountable_human_id).toBe('user:alice');
    const suspended = await agents.changeManagedOrganizationAgentLifecycle(auth, {
      nhiId: issued.nhi_id,
      action: 'suspend',
      expectedVersion: reassigned.version,
    });
    expect(suspended.lifecycle_status).toBe('suspended');
    expect(
      await agents.showManagedOrganizationAgent(
        { ...auth, allowedOrganizationIds: ['other-org'] },
        issued.nhi_id
      )
    ).toBeNull();
  });

  it('assigns plural responsibilities through real policy and schema validation', async () => {
    const assigned = await participants.setOrganizationParticipant(auth, {
      organizationId,
      actor: 'user:alice',
      roleIds: ['operator', 'reviewer'],
    });
    expect(assigned.participant.role_ids).toEqual(['operator', 'reviewer']);
    expect(
      (await participants.listOrganizationParticipants(auth, organizationId)).find(
        (row) => row.actor === 'user:alice'
      )?.role_ids
    ).toHaveLength(2);
    await participants.removeOrganizationParticipant(auth, {
      organizationId,
      actor: 'user:alice',
      expectedVersion: assigned.version,
    });
  });

  it.skipIf(process.env.KYBERION_TEST_CONCIERGE_BROWSER !== '1')(
    'uses the actual Concierge and governed browser with synthetic approvals',
    async () => {
      const io = await import('@agent/core/secure-io');
      const authn = await import('@agent/core/authn-providers');
      const approvals = await import('@agent/core/governance/approval-store');
      const external = await import('@agent/core/governance/external-operation');
      const browser = await import('../libs/actuators/browser-actuator/src/index.js');
      const canonicalJournal = path.join(
        root,
        'active/shared/coordination/identity/agent-identities.jsonl'
      );
      owner(() => {
        io.safeMkdir(path.dirname(canonicalJournal), { recursive: true });
        io.safeWriteFile(
          canonicalJournal,
          io.safeReadFile(path.join(root, 'active/shared/tmp/people-identities/identities.jsonl'), {
            encoding: 'utf8',
          })
        );
      });
      vi.stubEnv('KYBERION_SESSION_SECRET', FIRST_JOB_TEST_SESSION_KEY);
      vi.stubEnv('KYBERION_OIDC_ISSUER', FIRST_JOB_TEST_ISSUER);
      vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'synthetic-people-fixture');
      const token = authn.mintBrowserSessionToken({
        idpIssuer: FIRST_JOB_TEST_ISSUER,
        subject: FIRST_JOB_TEST_SUBJECT,
        ttlSeconds: 600,
      }).token;
      const appRoot = path.join(sourceRoot, 'presence/displays/concierge');
      const port = 19280 + (process.pid % 1000);
      const origin = 'http://127.0.0.1:' + port;
      const sessionId = 'people-browser-' + process.pid;
      const server = owner(() =>
        io.safeSpawn(
          process.execPath,
          [path.join(appRoot, 'server/local-server.ts'), '--port', String(port)],
          { cwd: appRoot, env: { ...process.env, KYBERION_ROOT: root } }
        )
      );
      let serverLog = '';
      server.stdout?.on('data', (chunk) => {
        serverLog += String(chunk);
      });
      server.stderr?.on('data', (chunk) => {
        serverLog += String(chunk);
      });
      let context: Record<string, unknown> = {};
      let sequence = 0;
      const run = async (
        type: 'capture' | 'control' | 'apply',
        op: string,
        params: Record<string, unknown>
      ) => {
        const input = {
          action: 'pipeline' as const,
          session_id: sessionId,
          options: {
            headless: true,
            keep_alive: true,
            navigation_policy: { allowed_origins: [origin], allow_private_network: true },
          },
          context,
          steps: [{ type, op, params: { max_retries: 0, ...params } }],
        };
        const invocationId = sessionId + '-' + ++sequence;
        const perform = () =>
          owner(() =>
            external.withExternalOperationAuthority(
              () => ({
                agentId: 'synthetic-browser-probe',
                tenantSlug: tenant,
                invocationId,
                hasHuman: false,
              }),
              () =>
                external.withExplicitExternalApprovalRequest(
                  {
                    operationId: 'browser:' + op,
                    requestScope: { scope_kind: 'tenant', tenant_slug: tenant },
                    reviewArtifacts: (effect) => {
                      const directory = path.join(
                        root,
                        'active/shared/artifacts/personal/' + tenant + '/people-browser'
                      );
                      io.safeMkdir(directory, { recursive: true });
                      const file = path.join(directory, invocationId + '.json');
                      io.safeWriteFile(file, JSON.stringify(effect));
                      return [file];
                    },
                  },
                  () => browser.handleAction(input)
                )
            )
          );
        let result = await perform();
        // Fixture-only decisions: real approval store, no live principal or state.
        for (let attempt = 0; result.status !== 'succeeded' && attempt < 3; attempt++) {
          const pending = owner(() =>
            approvals.listApprovalRequests({
              status: 'pending',
              storageChannels: ['external-operation'],
            })
          );
          if (!pending.length) break;
          for (const request of pending)
            owner(() =>
              approvals.decideApprovalRequest('mission_controller', {
                channel: request.channel,
                storageChannel: request.storageChannel,
                requestId: request.id,
                decision: 'approved',
                decidedBy: 'user:owner',
                decidedByType: 'human',
                authenticated: true,
                authMethod: 'terminal_attested',
                deciderIdentitySource: 'server_resolved',
                presentedDigest: approvals.computeApprovalPresentedDigest(request),
                payloadHash: request.accountability?.payloadHash,
                effectBinding: request.accountability?.effectBinding,
              })
            );
          result = await perform();
        }
        expect(result.status, JSON.stringify(result)).toBe('succeeded');
        context = result.context ?? context;
        return result;
      };
      const read = async (script: string) =>
        (await run('capture', 'evaluate', { script: '(' + script + ')()', export_as: 'probe' }))
          .context?.probe;
      const waitFor = async (script: string) => {
        try {
          await vi.waitFor(async () => expect(await read(script)).toBeTruthy(), {
            timeout: 10_000,
            interval: 300,
          });
        } catch {
          throw new Error(
            'Browser condition timed out: ' +
              script +
              '\n' +
              JSON.stringify(
                await read('() => ({ url: location.href, body: document.body.innerText })')
              ) +
              '\nServer: ' +
              serverLog
          );
        }
      };
      try {
        await vi.waitFor(
          async () => {
            if (server.exitCode !== null) throw new Error(serverLog);
            const ready = await fetch(origin + '/signin');
            expect(ready.ok, serverLog).toBe(true);
          },
          { timeout: 10_000, interval: 100 }
        );
        const headers = { Authorization: 'Bearer ' + token };
        const response = await fetch(origin + '/api/me', { headers });
        expect(response.status, await response.clone().text()).toBe(200);
        const preflight = await fetch(origin + '/api/management/participants', {
          method: 'POST',
          headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
          body: '{}',
        });
        expect(preflight.status, 'explicit same-origin guard: ' + (await preflight.text())).toBe(
          400
        );
        const next = '/management?tenant=' + tenant + '&organization_id=' + organizationId;
        await run('control', 'open_tab', {
          tab_id: 'main',
          url: origin + '/signin?next=' + encodeURIComponent(next),
        });
        await run('apply', 'fill', { selector: 'input[type=password]', text: token });
        await run('apply', 'click', { selector: 'button.action-button' });
        await waitFor(
          '() => !!document.querySelector("section[aria-label=\\"People and responsibilities\\"] select")'
        );
        expect(await read('() => document.body.innerText')).toContain('Synthetic diagnostic owner');
        await run('capture', 'evaluate', {
          script:
            '(() => { window.peopleProbeResponses = []; const actual = window.fetch.bind(window); window.fetch = async (...args) => { const response = await actual(...args); if (String(args[0]).includes("/api/management/participants")) window.peopleProbeResponses.push({ status: response.status, body: await response.clone().text() }); return response; }; })()',
        });
        await run('capture', 'evaluate', {
          script:
            '(() => { const e = document.querySelector("section[aria-label=\\"People and responsibilities\\"] select"); e.value = "user:owner"; e.dispatchEvent(new Event("change", { bubbles: true })); })()',
        });
        await run('apply', 'click', {
          selector: '.management-role-picker label:nth-of-type(1) input',
        });
        await run('apply', 'click', {
          selector: '.management-role-picker label:nth-of-type(2) input',
        });
        await run('apply', 'click', {
          selector:
            'section[aria-label="People and responsibilities"] > section:first-child .management-editor button',
        });
        await run('apply', 'click', {
          selector: '[role=region].management-editor button:first-of-type',
        });
        await waitFor('() => !document.querySelector("[role=region].management-editor")');
        const rows = await fetch(
          origin +
            '/api/management/participants?tenant=' +
            tenant +
            '&organization_id=' +
            organizationId,
          { headers }
        ).then((r) => r.json());
        expect(rows.ok, JSON.stringify(rows)).toBe(true);
        await waitFor('() => !!document.querySelector(".management-role-picker")');
        await run('capture', 'screenshot', { path: screenshot, fullPage: true });
        expect(
          rows.participants.find((row: { actor: string }) => row.actor === 'user:owner'),
          JSON.stringify(rows) +
            '\n' +
            (await read('() => document.body.innerText')) +
            '\nHTTP: ' +
            JSON.stringify(await read('() => window.peopleProbeResponses'))
        ).toBeDefined();
        expect(
          rows.participants.find((row: { actor: string }) => row.actor === 'user:owner').role_ids
        ).toHaveLength(2);
        expect(rows.agents.some((row: { nhi_id: string }) => row.nhi_id.endsWith('/helper'))).toBe(
          true
        );
        const denied = await fetch(
          origin +
            '/api/management/participants?tenant=foreign-fixture&organization_id=' +
            organizationId,
          { headers }
        );
        expect(denied.status).toBe(403);
      } finally {
        await browser.closeBrowserSession(sessionId);
        server.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          if (server.exitCode !== null) resolve();
          else {
            server.once('exit', () => resolve());
            setTimeout(() => {
              server.kill('SIGKILL');
              resolve();
            }, 3000).unref();
          }
        });
      }
    },
    180_000
  );
});
