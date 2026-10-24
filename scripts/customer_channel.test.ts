import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from '@agent/core/authority';
import { rootDir } from '@agent/core/path-resolver';
import * as initialIO from '@agent/core/secure-io';

/**
 * D8 + B2 on a fresh fixture root, through the real paths: the governed
 * binding writer, the real `sendToCustomer` approval gate and approval store,
 * the worker-event stream and the tenant-scoped outbound reader.
 */
vi.mock('@agent/core/reasoning/reasoning-bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/reasoning/reasoning-bootstrap')>()),
  installReasoningBackendsForService: vi.fn(() => false),
}));

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/customer-channel-' + process.pid);
const TENANT = 'cc-acme';
const OTHER = 'cc-other';
const SUSPENDED = 'cc-suspended';
const BODY_MARKER = 'Confidential quote 7,654,321 JPY';
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const savedRoot = process.env.KYBERION_ROOT;

let cli: typeof import('./customer_channel.js');
let io: typeof import('@agent/core/secure-io');

const bindingsFile = (tenant: string) =>
  path.join(ROOT, 'customer', tenant, 'connections', 'channel-bindings.json');
const readBindings = (tenant: string) =>
  JSON.parse(
    initialContext('ecosystem_architect', () =>
      String(io.safeReadFile(bindingsFile(tenant), { encoding: 'utf8' }))
    )
  ) as { bindings: Array<Record<string, unknown>> };

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"customer-channel-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    copy('knowledge/product/orchestration');
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('@agent/core/secure-io');
  cli = await import('./customer_channel.js');
  expect((await import('@agent/core/path-resolver')).rootDir()).toBe(ROOT);
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const [tenant, status] of [
    [TENANT, 'active'],
    [OTHER, 'active'],
    [SUSPENDED, 'suspended'],
  ]) {
    io.safeWriteFile(
      path.join(ROOT, `knowledge/personal/tenants/${tenant}.json`),
      JSON.stringify({ tenant_slug: tenant, display_name: tenant, status, assigned_role: 'owner' })
    );
  }
  for (const key of keys) delete process.env[key];
}, 120_000);

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

type Out = Record<string, unknown>;
const run = (argv: string[]) => cli.runCustomerChannel(argv) as Out;
const exitOf = (argv: string[]): string => {
  try {
    run(argv);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${argv.join(' ')} to fail`);
};

describe('customer-channel bind / unbind / list (D8, real paths)', () => {
  it('refuses an unregistered or suspended tenant and malformed options; writes nothing', () => {
    for (const tenant of ['cc-nobody', SUSPENDED, '../etc']) {
      expect(exitOf(['bind', '--tenant', tenant, '--surface', 'slack', '--channel', 'C1'])).toMatch(
        /CUSTOMER_BINDING_TENANT/u
      );
    }
    for (const extra of [
      ['--surface', 'fax', '--channel', 'C1'],
      ['--surface', 'slack', '--channel', 'C 1'],
      ['--surface', 'slack', '--channel', 'C1', '--mode', 'operator'],
      ['--surface', 'slack', '--channel', 'C1', '--language', 'japanese!'],
      ['--surface', 'slack', '--channel', 'C1', '--name', 'a\u0007b'],
    ]) {
      expect(exitOf(['bind', '--tenant', TENANT, ...extra]), extra.join(' ')).toMatch(
        /CUSTOMER_BINDING_INVALID/u
      );
    }
    expect(exitOf(['bind', '--tenant', TENANT, '--surface', 'slack'])).toMatch(/--channel/u);
    expect(exitOf(['bind', '--tenant', TENANT, '--token', 'x'])).toMatch(/unknown argument/u);
    expect(io.safeExistsSync(bindingsFile(TENANT))).toBe(false);
    expect(io.safeExistsSync(bindingsFile(SUSPENDED))).toBe(false);
  });

  it('creates, updates, deactivates and reactivates a schema-valid binding, audited', async () => {
    const { auditChain } = await import('@agent/core/governance/audit-chain');
    const record = vi.spyOn(auditChain, 'record');
    const created = run([
      'bind',
      '--tenant',
      TENANT,
      '--surface',
      'slack',
      '--channel',
      'C-ACME',
      '--name',
      'Ms. CTO',
      '--org',
      'Acme',
      '--language',
      'ja',
      '--mode',
      'requirements_hearing',
    ]);
    expect(created).toMatchObject({
      tenant_slug: TENANT,
      change: 'created',
      file: `customer/${TENANT}/connections/channel-bindings.json`,
    });
    expect(readBindings(TENANT).bindings).toEqual([
      {
        surface: 'slack',
        channel_id: 'C-ACME',
        counterpart: { name: 'Ms. CTO', org: 'Acme' },
        language: 'ja',
        mode: 'requirements_hearing',
        active: true,
      },
    ]);
    const core = await import('@agent/core/customer-channel-binding');
    const { findTenantCustomerChannelBinding } = core;
    // Inbound routing (bridges) reads every tenant registry entry.
    const resolveCustomerBinding = (surface: string, channel: string) =>
      initialContext('mission_controller', () => core.resolveCustomerBinding(surface, channel));
    expect(resolveCustomerBinding('slack', 'C-ACME')?.tenantSlug).toBe(TENANT);

    expect(
      run([
        'bind',
        '--tenant',
        TENANT,
        '--surface',
        'slack',
        '--channel',
        'C-ACME',
        '--org',
        'Acme Inc',
      ])
    ).toMatchObject({
      change: 'updated',
      binding: { counterpart: { name: 'Ms. CTO', org: 'Acme Inc' } },
    });
    expect(
      run(['bind', '--tenant', TENANT, '--surface', 'slack', '--channel', 'C-ACME'])
    ).toMatchObject({ change: 'unchanged' });

    // A channel belongs to one tenant: inbound routing takes the first match.
    expect(
      exitOf(['bind', '--tenant', OTHER, '--surface', 'slack', '--channel', 'C-ACME'])
    ).toMatch(/CUSTOMER_BINDING_CONFLICT/u);

    expect(
      run(['unbind', '--tenant', TENANT, '--surface', 'slack', '--channel', 'C-ACME'])
    ).toMatchObject({ change: 'deactivated', binding: { active: false } });
    expect(findTenantCustomerChannelBinding(TENANT, 'slack', 'C-ACME')).toBeNull();
    expect(resolveCustomerBinding('slack', 'C-ACME')).toBeNull();
    expect(
      exitOf(['unbind', '--tenant', TENANT, '--surface', 'slack', '--channel', 'C-NONE'])
    ).toMatch(/not bound/u);
    // Free again: the other tenant may take it, and the first one cannot reactivate it now.
    expect(
      run(['bind', '--tenant', OTHER, '--surface', 'slack', '--channel', 'C-ACME'])
    ).toMatchObject({ change: 'created' });
    expect(
      exitOf(['bind', '--tenant', TENANT, '--surface', 'slack', '--channel', 'C-ACME'])
    ).toMatch(/CUSTOMER_BINDING_CONFLICT/u);
    run(['unbind', '--tenant', OTHER, '--surface', 'slack', '--channel', 'C-ACME']);
    expect(
      run(['bind', '--tenant', TENANT, '--surface', 'slack', '--channel', 'C-ACME'])
    ).toMatchObject({
      change: 'reactivated',
      binding: { active: true, mode: 'requirements_hearing' },
    });

    expect(run(['list', '--tenant', TENANT])).toMatchObject({
      tenant_slug: TENANT,
      bindings: [expect.objectContaining({ channel_id: 'C-ACME', active: true })],
    });
    expect(run(['list', '--tenant', SUSPENDED])).toEqual({ tenant_slug: SUSPENDED, bindings: [] });

    // Every change is in the audit chain, scoped to the tenant.
    const changes = record.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.action === 'customer_channel_binding' && entry.tenantSlug === TENANT)
      .map((entry) => (entry.metadata as { change?: string }).change);
    expect(changes).toEqual(['created', 'updated', 'unchanged', 'deactivated', 'reactivated']);
    record.mockRestore();
  });

  it('refuses to overwrite a bindings file that does not validate', () => {
    initialContext('mission_controller', () =>
      io.safeWriteFile(bindingsFile(OTHER), JSON.stringify({ bindings: [{ surface: 'fax' }] }))
    );
    expect(exitOf(['bind', '--tenant', OTHER, '--surface', 'slack', '--channel', 'C-2'])).toMatch(
      /CUSTOMER_BINDING_FILE_INVALID/u
    );
    expect(readBindings(OTHER)).toEqual({ bindings: [{ surface: 'fax' }] });
  });
});

describe('customer_channel_binding_store on the real guard', () => {
  it("writes only its bound tenant's channel-bindings.json, nothing else under customer/", async () => {
    const authority = await import('@agent/core/authority');
    const role = 'customer_channel_binding_store';
    const asStore = (fn: () => unknown, tenant = TENANT) =>
      authority.withExecutionContext(role, fn, undefined, tenant);
    // The bound tenant's bindings file is writable (rewritten unchanged).
    const current = JSON.stringify(readBindings(TENANT));
    asStore(() => io.safeWriteFile(bindingsFile(TENANT), current));
    const denied = /CUSTOMER_CHANNEL_BINDING_STORE_SCOPE/u;
    expect(() =>
      asStore(() =>
        io.safeWriteFile(path.join(ROOT, 'customer', TENANT, 'connections', 'slack.json'), '{}')
      )
    ).toThrow(denied);
    expect(() =>
      asStore(() => io.safeWriteFile(path.join(ROOT, 'customer', TENANT, 'profile.json'), '{}'))
    ).toThrow(denied);
    expect(() =>
      asStore(() => io.safeWriteFile(path.join(ROOT, 'active/shared/runtime/x.json'), '{}'))
    ).toThrow(denied);
    // Another tenant's bindings file: outside the tenant-bound grant.
    expect(() =>
      asStore(() => io.safeWriteFile(bindingsFile(OTHER), JSON.stringify({ bindings: [] })))
    ).toThrow();
    // Tenant-bound: never without a tenant.
    expect(() => authority.withExecutionContext(role, () => undefined)).toThrow(
      /ROLE_TENANT_SCOPE_REQUIRED/u
    );
  });
});

describe('customer outbound approvals carry ids only (B2, real gate)', () => {
  it('keeps the message out of the shared approval store and worker events, and the approval binds it', async () => {
    const core = await import('@agent/core/customer-channel-binding');
    const { openDeal } = await import('@agent/core/deal-store');
    const { sendDealDocumentToCustomer } = await import('@agent/core/deal-documents');
    const { listApprovalRequests, decideApprovalRequest } =
      await import('@agent/core/governance/approval-store');
    const { getDefaultWorkerEventStream } =
      await import('@agent/core/workforce/worker-event-stream');
    const streamed: string[] = [];
    const unsubscribe = getDefaultWorkerEventStream().subscribe((event) => {
      streamed.push(JSON.stringify(event));
    });

    const binding = core.findTenantCustomerChannelBinding(TENANT, 'slack', 'C-ACME')!;
    expect(binding).not.toBeNull();
    const deal = initialContext(
      'mission_controller',
      () => openDeal({ tenantSlug: TENANT, surface: 'slack', channelId: 'C-ACME', summary: 'x' }),
      undefined,
      TENANT
    );
    const docPath = path.join(ROOT, 'customer', TENANT, 'deals', deal.deal_id, 'quote-v1.md');
    const body = `# Quote\n\n${BODY_MARKER}\n`;
    initialContext('mission_controller', () => io.safeWriteFile(docPath, body));
    const sha = createHash('sha256').update(body, 'utf8').digest('hex');
    const deliver = vi.fn(async () => undefined);
    const send = () =>
      initialContext(
        'mission_controller',
        () =>
          sendDealDocumentToCustomer({
            binding,
            dealId: deal.deal_id,
            kind: 'quote',
            version: 1,
            hasHuman: true,
            deliver,
          }),
        undefined,
        TENANT
      );

    const held = await send();
    expect(held).toMatchObject({ sent: false, status: 'approval_pending' });
    const requests = () =>
      initialContext('surface_runtime', () => listApprovalRequests({ storageChannels: ['slack'] }));
    const heldId = (held as { approvalRequestId?: string }).approvalRequestId;
    const request = requests().find((item) => item.id === heldId)!;
    expect(request.status).toBe('pending');
    // Unscoped readers (approval CLI, Slack approval UI, dashboards) and the
    // worker-event stream never see the message.
    expect(JSON.stringify(requests())).not.toContain(BODY_MARKER);
    expect(streamed.some((line) => line.includes(BODY_MARKER))).toBe(false);
    expect(String(request.title)).toContain(deal.deal_id);
    const command = `customer-channel outbound --tenant ${TENANT} --source deals/${deal.deal_id}/quote-v1.md --sha256 ${sha}`;
    expect(String(request.summary)).toContain(command);

    // The approver reads it through the tenant-scoped command.
    expect(
      run([
        'outbound',
        '--tenant',
        TENANT,
        '--source',
        `deals/${deal.deal_id}/quote-v1.md`,
        '--sha256',
        sha,
      ])
    ).toMatchObject({ sha256: sha, matches_approval: true, text: body });
    expect(
      exitOf(['outbound', '--tenant', OTHER, '--source', `deals/${deal.deal_id}/quote-v1.md`])
    ).toMatch(/no readable outbound content/u);
    expect(
      exitOf(['outbound', '--tenant', TENANT, '--source', 'connections/channel-bindings.json'])
    ).toMatch(/no readable outbound content/u);
    expect(
      exitOf(['outbound', '--tenant', SUSPENDED, '--source', `deals/${deal.deal_id}/quote-v1.md`])
    ).toMatch(/no readable outbound content/u);

    decideApprovalRequest('mission_controller', {
      channel: 'slack',
      requestId: request.id,
      decision: 'approved',
      decidedBy: 'user:boss',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      payloadHash: request.accountability?.payloadHash,
      effectBinding: request.accountability?.effectBinding,
    });

    // An edited document is other text: the approval does not cover it.
    initialContext('mission_controller', () => io.safeWriteFile(docPath, `${body}PS\n`));
    const edited = await send();
    expect(edited.sent).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(
      run([
        'outbound',
        '--tenant',
        TENANT,
        '--source',
        `deals/${deal.deal_id}/quote-v1.md`,
        '--sha256',
        sha,
      ])
    ).toMatchObject({ matches_approval: false });

    // The exact approved text goes out.
    initialContext('mission_controller', () => io.safeWriteFile(docPath, body));
    const sent = await send();
    expect(sent).toMatchObject({ sent: true, status: 'sent' });
    expect(deliver).toHaveBeenCalledWith(body);
    expect(JSON.stringify(requests())).not.toContain(BODY_MARKER);
    expect(streamed.some((line) => line.includes(BODY_MARKER))).toBe(false);
    unsubscribe();
  }, 60_000);
});

describe('customer escalations carry ids only (real notifyOperator / ops alert)', () => {
  it('keeps the customer message out of operator notifications and ops alerts; the operator reads it in the tenant', async () => {
    const MARKER = 'Our secret merger with Initech';
    const { registerReasoningBackend } = await import('@agent/core/reasoning/reasoning-backend');
    const restore = registerReasoningBackend({
      name: 'escalation-fake',
      prompt: async () => `We will confirm. [NEEDS_OPERATOR] Customer asks about ${MARKER}`,
    } as never);
    const notifications = await import('@agent/core/surface/operator-notifications');
    const notify = vi.spyOn(notifications, 'notifyOperator');
    const { getDefaultWorkerEventStream } =
      await import('@agent/core/workforce/worker-event-stream');
    const streamed: string[] = [];
    const unsubscribe = getDefaultWorkerEventStream().subscribe((event) => {
      streamed.push(JSON.stringify(event));
    });
    try {
      const core = await import('@agent/core/customer-channel-binding');
      const { runCustomerConversation } = await import('@agent/core/customer-conversation');
      const binding = core.findTenantCustomerChannelBinding(TENANT, 'slack', 'C-ACME')!;
      const text = `Can you tell us about ${MARKER}?`;
      const result = await initialContext(
        'mission_controller',
        () => runCustomerConversation({ binding, text }),
        undefined,
        TENANT
      );
      expect(result.escalated).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(notify).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(notify.mock.calls)).not.toContain(MARKER);
      expect(streamed.some((line) => line.includes(MARKER))).toBe(false);

      // Nothing outside the tenant's own deal record holds the message.
      const leaks: string[] = [];
      const walk = (dir: string): void => {
        for (const name of io.safeReaddir(dir)) {
          const file = path.join(dir, name);
          if (file.startsWith(path.join(ROOT, 'customer', TENANT, 'deals'))) continue;
          if (file.startsWith(path.join(ROOT, 'knowledge'))) continue;
          const stat = io.safeLstat(file);
          if (stat.isDirectory()) walk(file);
          else if (
            stat.isFile() &&
            String(io.safeReadFile(file, { encoding: 'utf8' })).includes(MARKER)
          )
            leaks.push(path.relative(ROOT, file));
        }
      };
      initialContext('ecosystem_architect', () => walk(ROOT));
      expect(leaks).toEqual([]);

      const sha = createHash('sha256').update(text, 'utf8').digest('hex');
      const body = String((notify.mock.calls[0][1] as { body?: string }).body);
      const command = `customer-channel question --tenant ${TENANT} --deal ${result.deal.deal_id} --sha256 ${sha}`;
      expect(body).toContain(command);
      expect(
        run(['question', '--tenant', TENANT, '--deal', result.deal.deal_id, '--sha256', sha])
      ).toMatchObject({ message: text, reply: 'We will confirm.' });
      expect(
        exitOf(['question', '--tenant', OTHER, '--deal', result.deal.deal_id, '--sha256', sha])
      ).toMatch(/no customer message/u);
    } finally {
      unsubscribe();
      notify.mockRestore();
      restore();
    }
  }, 60_000);
});
