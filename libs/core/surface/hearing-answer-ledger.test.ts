// MSN-SERVER-CONCIERGE-ASK-20261108 (K1): on a surface without decision-ledger
// reads (no `ctx.ledger`, Concierge), `answerHearing` itself refuses a
// decision-ledger scenario however it arrives — the legacy inline `scenario`
// object or a `scenario_ref` — before anything is stored or any model call is
// scheduled. Hermetic: a temporary KYBERION_ROOT, modules loaded after it is set.
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const canvas = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@agent/core/surface/hearing-canvas', async (original) => {
  const actual = await original<typeof import('@agent/core/surface/hearing-canvas')>();
  return {
    ...actual,
    generateHearingCanvas: (...args: Parameters<typeof actual.generateHearingCanvas>) => {
      canvas.calls += 1;
      return actual.generateHearingCanvas(...args);
    },
  };
});
import type { HearingRouteContext } from './hearing-route-context.js';

const TENANT = 'zz-hearing-answer-ledger';
let root = '';
let service: typeof import('./hearing-session-service.js');
let storageAccess: typeof import('./hearing-storage-access.js');
let authority: typeof import('../authority.js');

beforeAll(async () => {
  const bootstrap = await import('@agent/core');
  const sourceRoot = bootstrap.pathResolver.rootDir();
  root = path.join(sourceRoot, 'active/shared/tmp', `vitest-hearing-answer-${randomUUID()}`);
  const fixture = (await import(
    /* @vite-ignore */ path.join(sourceRoot, 'scripts/fixtures/first-job-approval-fixture.ts')
  )) as { seedFirstJobTestRoot(sourceRoot: string, root: string): void };
  fixture.seedFirstJobTestRoot(sourceRoot, root);
  bootstrap.safeMkdir(path.join(root, 'knowledge/public/common'), { recursive: true });
  bootstrap.safeCopyFileSync(
    path.join(sourceRoot, 'knowledge/public/common/project_standards.json'),
    path.join(root, 'knowledge/public/common/project_standards.json')
  );
  vi.stubEnv('KYBERION_ROOT', root);
  vi.resetModules();
  service = await import('./hearing-session-service.js');
  storageAccess = await import('./hearing-storage-access.js');
  authority = await import('../authority.js');
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  const bootstrap = await import('@agent/core');
  if (root) bootstrap.safeRmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  canvas.calls = 0;
});

function context(): HearingRouteContext {
  const viewer = {
    role: 'localadmin' as const,
    tenantSlugs: [TENANT],
    organizationIds: 'all' as const,
    projectIds: 'all' as const,
    tierAccess: ['confidential' as const, 'public' as const],
    source: 'token' as const,
    principalId: 'human:answer-ledger-test',
  };
  return {
    viewer,
    owner: true,
    currentSurface: 'concierge',
    storage: () => storageAccess.hearingStorageForScope(viewer, { owner: true }),
    handoffScope: () => ({}),
    denied: (status, message) => new Error(`${status} ${message}`),
    audit: () => undefined,
    recordInScope: () => true,
    // No `ledger`: this surface may not read the decision ledger.
  };
}

const stored = (id: string) =>
  authority.withExecutionContext(
    'ecosystem_architect',
    () => storageAccess.hearingStorageForScope({ tenantSlugs: [TENANT] }, { owner: true }).load(id),
    undefined,
    TENANT
  );

const LEDGER_SCENARIO = 'decisions-case-a-product';

describe('answerHearing without ledger reads', () => {
  it('refuses an inline decision-ledger scenario before storing or scheduling the model', () => {
    const id = 'answer-' + randomUUID();
    const body = {
      text: 'goal: inline ledger scenario',
      scenario: {
        id: LEDGER_SCENARIO,
        requirements: [
          {
            id: 'DEC-1',
            label_key: 'front_desk:hearing_req_problem',
            label_source: 'tenant',
            label_text: 'Secret tenant decision label',
          },
        ],
      },
    };
    expect(() => service.answerHearing(context(), id, body, {})).toThrow(
      service.HearingLedgerUnavailableError
    );
    expect(stored(id)).toBeNull();
    expect(canvas.calls).toBe(0);
  });

  it('refuses an inline ledger scenario before its content is even validated', () => {
    // A malformed inline scenario: validateHearingScenario would reject it with
    // its own error. The ledger refusal comes first, so none of a decision
    // scenario's content is processed on this surface.
    const id = 'answer-' + randomUUID();
    const body = { text: 'goal: malformed', scenario: { id: LEDGER_SCENARIO, requirements: [] } };
    expect(() => service.answerHearing(context(), id, body, {})).toThrow(
      service.HearingLedgerUnavailableError
    );
    expect(stored(id)).toBeNull();
    expect(canvas.calls).toBe(0);
  });

  it('refuses a decision-ledger scenario_ref before storing or scheduling the model', () => {
    const id = 'answer-' + randomUUID();
    expect(() =>
      service.answerHearing(context(), id, { text: 'value', scenario_ref: LEDGER_SCENARIO }, {})
    ).toThrow(service.HearingLedgerUnavailableError);
    expect(stored(id)).toBeNull();
    expect(canvas.calls).toBe(0);
  });

  it('still answers an ordinary hearing (the model follow-up is scheduled)', async () => {
    const id = 'answer-' + randomUUID();
    const result = await service.answerHearing(context(), id, { text: 'goal: ordinary' }, {});
    expect(result.kind === 'json' && result.status).toBe(200);
    if (result.kind === 'json') result.after?.();
    expect(stored(id)?.session_id).toBe(id);
    expect(canvas.calls).toBe(1);
  });
});
