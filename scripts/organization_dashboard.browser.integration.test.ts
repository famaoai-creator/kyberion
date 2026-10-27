import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  seedFirstJobTestRoot,
  syntheticFirstJobOwner,
  FIRST_JOB_TEST_SESSION_KEY,
  FIRST_JOB_TEST_ISSUER,
  FIRST_JOB_TEST_SUBJECT,
} from './fixtures/first-job-approval-fixture.js';

// Same real-store, synthetic-approval boundary as organization_people.integration.test.ts.
// Never point this probe at the installation's data, identities or browser sessions.
const sourceRoot = process.cwd();
const root = path.join(
  sourceRoot,
  'active/shared/tmp/organization-dashboard-browser-' + process.pid
);
const tenant = 'dashboard-fixture';
const organizationId = 'dashboard-operations';
const projectA = 'PRJ-DASH-A';
const projectB = 'PRJ-DASH-B';
const evidenceRoot = path.join(
  sourceRoot,
  'active/shared/tmp/public/shared/org-dashboard/browser-evidence'
);
let authority: typeof import('@agent/core/authority');
let serverStopped = true;
const owner = <T>(body: () => T) =>
  authority.withExecutionContext('sovereign_concierge', body, undefined, tenant);

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  const manifest = 'libs/actuators/browser-actuator/manifest.json';
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
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_PROJECT_ID',
    'KYBERION_TIER',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('MISSION_ROLE', 'sovereign_concierge');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign_concierge');
  vi.stubEnv('KYBERION_SESSION_SECRET', FIRST_JOB_TEST_SESSION_KEY);
  vi.stubEnv('KYBERION_OIDC_ISSUER', FIRST_JOB_TEST_ISSUER);
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'synthetic-dashboard-fixture');
  vi.resetModules();
  authority = await import('@agent/core/authority');
  const tenants = await import('@agent/core/organization/tenant-governance');
  const members = await import('@agent/core/organization/member-registry');
  const organizations = await import('@agent/core/organization/organization-management');
  const projects = await import('@agent/core/project/project-management');
  const work = await import('@agent/core/workforce/work-coordination');
  owner(() => {
    tenants.mutateTenant({
      verb: 'create',
      slug: tenant,
      displayName: 'Synthetic dashboard fixture',
      apply: true,
      actor: 'integration-fixture',
    });
    members.writeMemberProfile(syntheticFirstJobOwner(tenant));
    organizations.createManagedOrganization({
      organizationId,
      tenantSlug: tenant,
      tier: 'confidential',
      name: 'Synthetic dashboard organization',
    });
    for (const project of [projectA, projectB])
      projects.createManagedProject({
        project_id: project,
        name: project,
        summary: 'Synthetic dashboard verification',
        tier: 'confidential',
        tenant_slug: tenant,
        organization_id: organizationId,
      });
    for (const row of [
      {
        id: 'mine-blocked',
        project: projectA,
        member: 'owner',
        status: 'blocked' as const,
        title: '本人の停滞した仕事',
      },
      {
        id: 'colleague-review',
        project: projectA,
        member: 'alice',
        status: 'review' as const,
        title: '同僚の確認待ちの仕事',
      },
      {
        id: 'sibling-ready',
        project: projectB,
        member: 'owner',
        status: 'ready' as const,
        title: '別プロジェクトの着手可能な仕事',
      },
    ])
      work.createWorkItem({
        itemId: row.id,
        title: row.title,
        description: 'Synthetic only',
        projectId: row.project,
        status: row.status,
        assigneeUserId: row.member,
        context: {
          tenant_slug: tenant,
          organization_id: organizationId,
          project_id: row.project,
          work_shape: 'solution_project',
        },
      });
  });
}, 60_000);

afterAll(() => {
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  const shots = path.join(root, 'active/shared/artifacts/confidential/' + tenant);
  for (const name of [
    'desktop.png',
    'mobile.png',
    'project-restricted.png',
    'unavailable.png',
    'result.json',
  ]) {
    const file = path.join(shots, name);
    if (safeExistsSync(file)) {
      safeWriteFile(path.join(evidenceRoot, name), safeReadFile(file, { encoding: null }));
      process.stdout.write('DASHBOARD_BROWSER_SCREENSHOT ' + path.join(evidenceRoot, name) + '\n');
    }
  }
  if (!serverStopped) throw new Error('Owned server has not exited; retaining its fixture.');
  safeRmSync(root, { recursive: true, force: true });
});

it.skipIf(process.env.KYBERION_TEST_CHRONOS_BROWSER !== '1')(
  'verifies dashboard views, scope denial and responsive layout in the actual Chronos and Chromium',
  async () => {
    expect(root).toContain(
      path.join(sourceRoot, 'active/shared/tmp/organization-dashboard-browser-')
    );
    const io = await import('@agent/core/secure-io');
    const authn = await import('@agent/core/authn-providers');
    const approvals = await import('@agent/core/governance/approval-store');
    const external = await import('@agent/core/governance/external-operation');
    const browser = await import('../libs/actuators/browser-actuator/src/index.js');
    const secret = await import('@agent/core/secret/secret-guard');
    const session = await import('@agent/core/surface/surface-session-cookie');
    const token = authn.mintBrowserSessionToken({
      idpIssuer: FIRST_JOB_TEST_ISSUER,
      subject: FIRST_JOB_TEST_SUBJECT,
      ttlSeconds: 600,
    }).token;
    const restrictedToken = 'synthetic-dashboard-project-restricted-token';
    owner(() =>
      secret.secretGuard.storeConnectionDocument('chronos-access', {
        tokens: [
          {
            token_hash: createHash('sha256').update(restrictedToken).digest('hex'),
            role: 'readonly',
            tenant_slugs: [tenant],
            organization_ids: [organizationId],
            project_ids: [projectA],
            tier_access: ['confidential'],
            member_id: 'owner',
            label: 'Synthetic project viewer',
          },
        ],
      })
    );
    const appRoot = path.join(sourceRoot, 'presence/displays/chronos-mirror-v2');
    const port = 20280 + (process.pid % 1000);
    const origin = 'http://127.0.0.1:' + port;
    const server = owner(() =>
      io.safeSpawn(
        process.execPath,
        [
          path.join(appRoot, 'node_modules/next/dist/bin/next'),
          'start',
          '-H',
          '127.0.0.1',
          '-p',
          String(port),
        ],
        { cwd: appRoot, env: { ...process.env, KYBERION_ROOT: root, KYBERION_TENANT: tenant } }
      )
    );
    serverStopped = false;
    let serverLog = '';
    server.stdout?.on('data', (chunk) => {
      serverLog += String(chunk);
    });
    server.stderr?.on('data', (chunk) => {
      serverLog += String(chunk);
    });
    const sessions = new Set<string>();
    let sequence = 0;
    const contextBySession = new Map<string, Record<string, unknown>>();
    const run = async (
      sessionId: string,
      type: 'capture' | 'apply',
      op: string,
      params: Record<string, unknown>,
      mobile = false
    ) => {
      sessions.add(sessionId);
      const input = {
        action: 'pipeline' as const,
        session_id: sessionId,
        options: {
          headless: true,
          keep_alive: true,
          locale: 'ja-JP',
          viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 1100 },
          navigation_policy: { allowed_origins: [origin], allow_private_network: true },
        },
        context: contextBySession.get(sessionId) ?? {},
        steps: [{ type, op, params: { max_retries: 0, ...params } }],
      };
      const invocationId = sessionId + '-' + ++sequence;
      const perform = () =>
        owner(() =>
          external.withExternalOperationAuthority(
            () => ({
              agentId: 'synthetic-dashboard-browser',
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
                    const file = path.join(
                      root,
                      'active/shared/artifacts/personal/' + tenant + '/dashboard-approvals',
                      invocationId + '.json'
                    );
                    io.safeWriteFile(file, JSON.stringify(effect));
                    return [file];
                  },
                },
                () => browser.handleAction(input)
              )
          )
        );
      let result = await perform();
      // Only synthetic requests in this disposable fixture; runtime policy is unchanged.
      if (result.status !== 'succeeded') {
        const pending = owner(() =>
          approvals.listApprovalRequests({
            status: 'pending',
            storageChannels: ['external-operation'],
          })
        );
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
        if (pending.length) result = await perform();
      }
      expect(result.status, JSON.stringify(result) + '\nServer: ' + serverLog).toBe('succeeded');
      contextBySession.set(sessionId, result.context ?? {});
      return result;
    };
    const read = async (id: string, script: string, mobile = false) =>
      (
        await run(
          id,
          'capture',
          'evaluate',
          { script: '(' + script + ')()', export_as: 'probe' },
          mobile
        )
      ).context?.probe;
    const dashboard = `document.querySelector('[aria-label="ダッシュボードの表示範囲"]')?.closest('section')`;
    const waitDashboard = async (id: string, expected: string, mobile = false) => {
      await vi.waitFor(
        async () =>
          expect(await read(id, `() => ${dashboard}?.innerText || ''`, mobile)).toContain(expected),
        { timeout: 15_000, interval: 300 }
      );
    };
    const open = async (id: string, target: string, credential: string, mobile = false) =>
      run(
        id,
        'apply',
        'import_session_handoff',
        {
          handoff: {
            target_url: origin + target,
            cookies: [
              {
                name: credential === token ? session.SURFACE_SESSION_COOKIE : 'kyberion_token',
                value: credential,
                url: origin,
                httpOnly: true,
                sameSite: 'Lax',
              },
            ],
            local_storage: { 'kyberion.ui.locale': 'ja' },
          },
        },
        mobile
      );
    const shot = async (id: string, name: string, mobile = false) => {
      await run(
        id,
        'capture',
        'evaluate',
        {
          script: `(() => { const el = ${dashboard}; el.style.scrollMarginTop = '80px'; el.scrollIntoView({block:'start'}); })()`,
        },
        mobile
      );
      await run(
        id,
        'capture',
        'screenshot',
        {
          path: path.join(root, 'active/shared/artifacts/confidential/' + tenant, name),
          fullPage: false,
        },
        mobile
      );
    };
    try {
      await vi.waitFor(
        async () => {
          expect(server.exitCode, serverLog).toBeNull();
          expect((await fetch(origin + '/api/healthz')).ok).toBe(true);
        },
        { timeout: 15_000, interval: 200 }
      );
      const api = async (query: string, credential = token) =>
        fetch(origin + '/api/organization-dashboard?' + query, {
          headers: { Authorization: 'Bearer ' + credential },
        });
      const initial = await api('project_id=' + projectA);
      expect(initial.status, await initial.clone().text()).toBe(200);
      expect((await initial.json()).counts).toMatchObject({
        total: 2,
        blocked: 1,
        review: 1,
        ready: 0,
      });
      const desktop = 'dashboard-desktop-' + process.pid;
      await open(desktop, '/?section=home&project_id=' + projectA, token);
      await waitDashboard(desktop, '同僚の確認待ちの仕事');
      expect(await read(desktop, `() => ${dashboard}.innerText`)).toContain('閲覧者: owner');
      await run(desktop, 'apply', 'click', {
        selector: '[aria-label="ダッシュボードの表示範囲"] button:text-is("自分")',
      });
      await waitDashboard(desktop, '本人の停滞した仕事');
      expect(await read(desktop, `() => ${dashboard}.innerText`)).not.toContain(
        '同僚の確認待ちの仕事'
      );
      await run(desktop, 'apply', 'click', {
        selector: '[aria-label="ダッシュボードの表示範囲"] button:text-is("組織全体")',
      });
      await waitDashboard(desktop, '別プロジェクトの着手可能な仕事');
      expect(
        await read(
          desktop,
          `() => [...${dashboard}.querySelectorAll('.kb-metric')].map(el => ({ label: el.querySelector('.kb-metric__label').textContent, value: el.querySelector('.kb-metric__value').textContent }))`
        )
      ).toEqual([
        { label: '進行中・着手可能', value: '2' },
        { label: '停滞', value: '1' },
        { label: '確認待ち', value: '1' },
        { label: '着手可能', value: '1' },
      ]);
      await shot(desktop, 'desktop.png');
      const mobile = 'dashboard-mobile-' + process.pid;
      await open(mobile, '/?section=home&project_id=' + projectA, token, true);
      await waitDashboard(mobile, '同僚の確認待ちの仕事', true);
      const bounds = await read(
        mobile,
        `() => { const el = ${dashboard}; const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth, overflow: el.scrollWidth > el.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 }; }`,
        true
      );
      expect(bounds).toMatchObject({ viewport: 390, overflow: false, pageOverflow: false });
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
      expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
      await shot(mobile, 'mobile.png', true);
      const restricted = 'dashboard-restricted-' + process.pid;
      await open(restricted, '/?section=home&project_id=' + projectA, restrictedToken);
      await waitDashboard(restricted, '同僚の確認待ちの仕事');
      expect(
        await read(
          restricted,
          `() => [...${dashboard}.querySelectorAll('button')].find(b => b.textContent === '組織全体').disabled`
        )
      ).toBe(true);
      await shot(restricted, 'project-restricted.png');
      for (const query of [
        'mode=organization&tenant=' + tenant + '&organization_id=' + organizationId,
        'project_id=' + projectB,
        'tenant=foreign-fixture',
      ])
        expect((await api(query, restrictedToken)).status).toBe(403);
      await open(restricted, '/?section=home&project_id=' + projectB, restrictedToken);
      await waitDashboard(restricted, '件数は不明');
      expect(await read(restricted, `() => ${dashboard}.innerText`)).not.toContain(
        '同僚の確認待ちの仕事'
      );
      await shot(restricted, 'unavailable.png');
      io.safeWriteFile(
        path.join(root, 'active/shared/artifacts/confidential/' + tenant, 'result.json'),
        JSON.stringify(
          {
            synthetic: true,
            actualChronosBuild: true,
            browser: 'Chromium via browser-actuator',
            checks: [
              'project scope counts',
              'member-only switching',
              'organization switching from project-only URL',
              '390px responsive layout',
              'project-restricted organization disabled',
              'unauthorized organization/project/tenant 403',
              'failed scope hides prior rows',
            ],
          },
          null,
          2
        )
      );
    } finally {
      const closed = await Promise.allSettled(
        [...sessions].map((id) => browser.closeBrowserSession(id))
      );
      await new Promise<void>((resolve) => {
        if (server.exitCode !== null || server.signalCode !== null) return resolve();
        const force = setTimeout(() => server.kill('SIGKILL'), 3000);
        force.unref();
        server.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
        server.kill('SIGTERM');
      });
      serverStopped = true;
      const failures = closed.filter((result) => result.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          'Browser cleanup failed after server exit'
        );
    }
  },
  180_000
);
