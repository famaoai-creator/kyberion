import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from '../dot/dot-charter.js';
import type { FirstJobSnapshot } from './first-job.js';
import type { FirstJobSetup } from './first-job-setup.js';
import type {
  FrontDeskExecutionMapping,
  FrontDeskExecutionProjection,
} from './front-desk-execution-contract.js';

// The first-job read model and diagnostic admission (resolveFirstJobViewer,
// the mapping narrowing, inspectFrontDeskExecution, readFirstJobSnapshot /
// readFirstJobArtifact), ported from presence-studio first-job-routes.test.ts
// when the routes moved to Concierge (Kyberion server phase 2). No HTTP: the
// Concierge route boundary is covered by
// presence/displays/concierge/src/app/api/first-job/route.test.ts. The
// charter, mapping policy, execution projection and governed artifact store
// are the same in-memory doubles the Studio suite used, so every case counts
// writes and locks; KYBERION_ROOT is a temporary root.
const state = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  mappings: [] as FrontDeskExecutionMapping[],
  writes: 0,
  locks: 0,
  loads: 0,
  revokeAt: 0,
  charterReads: 0,
  revokeCharterAt: 0,
  digest: 'a'.repeat(64),
  projections: new Map<string, FrontDeskExecutionProjection>(),
  run: vi.fn(),
  charter: undefined as DotCharter | undefined,
}));
vi.mock('../dot/dot-charter.js', async (original) => {
  const readCharter = () => {
    state.charterReads++;
    if (state.revokeCharterAt && state.charterReads >= state.revokeCharterAt && state.charter)
      state.charter.status = 'paused';
    return state.charter
      ? { path: 'dots/receipt-dot.json', charter: structuredClone(state.charter) }
      : undefined;
  };
  return {
    ...(await original<typeof import('../dot/dot-charter.js')>()),
    findDotCharter: readCharter,
    // Diagnostic admission uses the repo-only reader; retain the same revocation clock.
    findRepoDotCharter: readCharter,
  };
});
vi.mock('./channel-surface.js', () => ({ runSurfaceMessageConversation: state.run }));
vi.mock('../authority.js', async (original) => ({
  ...(await original<typeof import('../authority.js')>()),
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('../foundation/lock-utils.js', () => ({
  withLockSync: (key: string, fn: () => unknown) => {
    // The audit chain serialises its append-only log with this lock; only
    // locks around diagnostic/decision state count as a mutation here.
    if (!key.startsWith('audit-chain')) state.locks++;
    return fn();
  },
}));
vi.mock('../workforce/artifact-store.js', async (original) => ({
  ...(await original<typeof import('../workforce/artifact-store.js')>()),
  readGovernedArtifactJson: (file: string) => structuredClone(state.files.get(file) ?? null),
  writeGovernedArtifactJson: (_role: string, file: string, value: unknown) => {
    state.writes++;
    state.files.set(file, structuredClone(value));
  },
}));
vi.mock('../workforce/work-coordination.js', async (original) => ({
  ...(await original<typeof import('../workforce/work-coordination.js')>()),
  getWorkItem: () => undefined,
}));
vi.mock('./front-desk-execution-status.js', () => ({
  projectFrontDeskExecution: (
    _viewer: unknown,
    binding: { request_id: string; config_digest: string }
  ) =>
    state.mappings.length && binding.config_digest === state.digest
      ? state.projections.get(binding.request_id)
      : undefined,
}));
vi.mock('./front-desk-execution-contract.js', async (original) => ({
  ...(await original<typeof import('./front-desk-execution-contract.js')>()),
  loadFrontDeskExecutionPolicy: () => {
    state.loads++;
    if (state.revokeAt && state.loads >= state.revokeAt) state.mappings = [];
    return { version: 1, mappings: structuredClone(state.mappings) };
  },
  frontDeskMappingDigest: () => state.digest,
  getFrontDeskExecutionMapping: (binding: { mapping_id: string; config_digest: string }) =>
    binding.config_digest === state.digest
      ? structuredClone(state.mappings.find((entry) => entry.id === binding.mapping_id))
      : undefined,
}));

const sourceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-first-job-core-${randomUUID()}`);

let core: typeof import('./first-job.js');
let setupModule: typeof import('./first-job-setup.js');
let contract: typeof import('./first-job-contract.js');
let store: typeof import('./front-desk-conversation-store.js');
let execution: typeof import('./front-desk-execution-contract.js');
let locales: typeof import('../foundation/locale-normalize.js');

const id = (n = 1) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const viewer = {
  principalId: 'human:presence-studio-localadmin',
  source: 'loopback' as const,
  role: 'localadmin' as const,
  tenantSlugs: ['alpha-team'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public' as const],
};
/** What the Concierge gate hands the shared logic for the local owner (server tenant bound). */
const local = {
  ...viewer,
  organizationIds: 'all' as const,
  projectIds: 'all' as const,
};
const mapping = (): FrontDeskExecutionMapping => ({
  id: 'local-diagnostic',
  viewer: structuredClone(viewer),
  dotId: 'receipt-dot',
  exactCommand: execution.FRONT_DESK_RECEIPT_COMMAND,
  pipeline: {
    path: execution.FRONT_DESK_RECEIPT_PIPELINE,
    version: execution.FRONT_DESK_RECEIPT_VERSION,
  },
});

type Result = {
  status: number;
  error?: string;
  body?: FirstJobSnapshot & { setup?: FirstJobSetup; replayed?: boolean; mode?: string };
};
/** The diagnostic read (the route's GET sequence without HTTP). */
function read(query: Record<string, unknown> = {}): Result {
  const input = contract.parseFirstJobReadRequest(query);
  if (!input) return { status: 400 };
  const snapshot = core.readFirstJobSnapshot(local, input);
  return {
    status: 200,
    body: { ...snapshot, setup: setupModule.readFirstJobSetup(local, '', snapshot) },
  };
}
/** The fixed request (the route's POST sequence without HTTP or the gate). */
function post(body: Record<string, unknown>): Result {
  const input = contract.parseFirstJobRequest(body);
  if (!input || (input.locale !== undefined && !locales.normalizeLocale(input.locale)))
    return { status: 400, error: 'first_job_invalid_request' };
  const resolution = core.resolveFirstJobViewer(local);
  if (resolution.ready === false) return { status: 409, error: 'first_job_' + resolution.status };
  const ref = store.conversationRef(resolution.viewer);
  if (input.session_id && input.session_id !== ref.sessionId)
    return { status: 409, error: 'first_job_scope_changed' };
  const revision = input.action === 'revise' ? input.artifactRevision : undefined;
  let turn: ReturnType<typeof store.reserveConversationTurn>;
  try {
    turn = store.reserveConversationTurn(
      resolution.viewer,
      revision
        ? execution.frontDeskArtifactRevisionCommand(revision.format)
        : execution.FRONT_DESK_RECEIPT_COMMAND,
      input.request_id,
      undefined,
      locales.normalizeLocale(input.locale) ?? undefined,
      revision,
      { requireDiagnosticAdmission: true }
    );
  } catch (error) {
    if (!(error instanceof store.ConversationStoreError)) throw error;
    const invalid = ['invalid_revision', 'invalid_text'].includes(error.code);
    return {
      status: invalid ? 400 : error.code === 'invalid_history' ? 503 : 409,
      error: 'first_job_' + error.code,
    };
  }
  const reply = turn.routing?.reply;
  if (!reply) return { status: 503, error: 'first_job_admission_uncertain' };
  if (turn.created) store.completeConversationTurn(resolution.viewer, turn.id, reply);
  return {
    status: 200,
    body: {
      ...core.readFirstJobSnapshot(local, { session_id: ref.sessionId, locale: input.locale }),
      replayed: !turn.created,
      mode: turn.created ? 'intake' : 'history',
    },
  };
}

beforeAll(async () => {
  const fixture = await import('../../../scripts/fixtures/first-job-approval-fixture.js');
  fixture.seedFirstJobTestRoot(sourceRoot, root);
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_PERSONA', 'worker');
  vi.resetModules();
  core = await import('./first-job.js');
  setupModule = await import('./first-job-setup.js');
  contract = await import('./first-job-contract.js');
  store = await import('./front-desk-conversation-store.js');
  execution = await import('./front-desk-execution-contract.js');
  locales = await import('../foundation/locale-normalize.js');
}, 120_000);
afterAll(async () => {
  // Removed from the checkout's own root (the temporary root cannot delete itself).
  vi.stubEnv('KYBERION_ROOT', '');
  vi.resetModules();
  const bootstrap = await import('../secure-io.js');
  bootstrap.safeRmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
beforeEach(() => {
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_TENANT', 'alpha-team');
  state.charter = {
    kind: 'dot-charter',
    dot_id: 'receipt-dot',
    version: '1.0.0',
    title: 'Diagnostic',
    purpose: 'Diagnostic',
    status: 'active',
    scope: {
      tier: 'public',
      tenant_slug: 'alpha-team',
      organization_id: 'org-a',
      project_id: 'project-a',
    },
    goal: { statement: 'Return verified receipts' },
    attention: { triggers: [] },
    authority: {
      authority_role: 'infrastructure_sentinel',
      allowed_execution_shapes: ['pipeline'],
      allowed_pipelines: [execution.FRONT_DESK_RECEIPT_PIPELINE],
    },
    decisions: { default_decision: 'approve', escalate_channel: 'surface' },
    notification: { delivery_mode: 'inbox', deliver_to: { surface: 'surface', channel: 'inbox' } },
    runtime: { heartbeat_id: 'diagnostic', execution_mode: 'front_desk_diagnostic' },
  };
  state.files.clear();
  state.mappings = [mapping()];
  state.writes = 0;
  state.locks = 0;
  state.loads = 0;
  state.revokeAt = 0;
  state.charterReads = 0;
  state.revokeCharterAt = 0;
  state.digest = 'a'.repeat(64);
  state.projections.clear();
  state.run.mockReset();
});
afterEach(() => {
  vi.stubEnv('KYBERION_OIDC_ISSUER', '');
  vi.stubEnv('KYBERION_OIDC_CLIENT_ID', '');
  vi.stubEnv('KYBERION_SESSION_SECRET', '');
});

describe('first-job read model and diagnostic admission (no HTTP)', () => {
  it('runs inside the temporary root', () => {
    expect(path.relative(root, String(process.env.KYBERION_ROOT))).toBe('');
  });

  it('returns independent redacted setup checks before mapping, without running setup or a provider', () => {
    state.mappings = [];
    vi.stubEnv('KYBERION_OIDC_ISSUER', 'https://private-issuer.invalid');
    vi.stubEnv('KYBERION_OIDC_CLIENT_ID', 'private-client-id');
    vi.stubEnv('KYBERION_SESSION_SECRET', 'private-session-key-longer-than-32-bytes');
    const result = read();
    expect(result.body!.setup).toMatchObject({
      mapping: { status: 'mapping_missing', owner: 'operator' },
      oidc: { status: 'configured' },
      browser_user: { status: 'sign_in_required', owner: 'user' },
      approval_scope: { status: 'mapping_required' },
      baseline: { status: 'unchecked' },
      reasoning: { status: 'not_required' },
    });
    expect(JSON.stringify(result.body!.setup)).not.toMatch(
      /private-|issuer|clientSecret|member_id|knowledge\//
    );
    expect(state.writes).toBe(0);
    expect(state.locks).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('keeps supported locale aliases and rejects unsupported locales in domain reads', () => {
    for (const locale of ['en-US', 'EN_us', 'jaJP'])
      expect(() => core.readFirstJobSnapshot(viewer, { locale })).not.toThrow();
    for (const locale of ['zz', 'invalid', 'C']) {
      expect(post({ action: 'start', request_id: id(), locale }).status).toBe(400);
      expect(() => core.readFirstJobSnapshot(viewer, { locale })).toThrow(
        'first_job_invalid_locale'
      );
    }
    expect(state.writes).toBe(0);
  });

  it('derives a public-only singleton scope without replacing authenticated identity', () => {
    const result = read();
    expect(result.body!.readiness).toEqual({ ready: true, status: 'diagnostic_mapping_ready' });
    expect(result.body!.scope).toEqual({
      tenant: 'alpha-team',
      organizationId: 'org-a',
      projectId: 'project-a',
      tier: 'public',
    });
    expect(result.body!.sessionId).toBe(store.conversationRef(viewer).sessionId);
    expect(state.writes).toBe(0);
    expect(state.locks).toBe(0);
  });

  it('reports absent, mismatched and ambiguous mappings without exposing other scopes', () => {
    state.mappings = [];
    expect(read().body!.readiness.status).toBe('mapping_missing');
    state.mappings = [
      { ...mapping(), viewer: { ...viewer, principalId: 'human:concierge-localadmin' } },
    ];
    expect(read().body!.readiness.status).toBe('mapping_mismatch');
    state.mappings = [
      mapping(),
      { ...mapping(), id: 'other', viewer: { ...viewer, projectIds: ['project-b'] } },
    ];
    const result = read();
    expect(result.body!.readiness.status).toBe('mapping_ambiguous');
    expect(result.body!.scope).toBeUndefined();
  });

  it('retains member, source and role and never widens restricted scopes', () => {
    const auth = {
      ...viewer,
      memberId: 'alice',
      tierAccess: ['public' as const, 'confidential' as const],
    };
    expect(core.resolveFirstJobViewer(auth).ready).toBe(false);
    state.mappings = [{ ...mapping(), viewer: { ...viewer, memberId: 'alice' } }];
    expect(core.resolveFirstJobViewer(auth)).toMatchObject({
      ready: true,
      viewer: { ...viewer, memberId: 'alice' },
    });
    for (const change of [
      { tenantSlugs: ['other'] },
      { organizationIds: ['other'] },
      { projectIds: ['other'] },
      { source: 'token' as const },
      { source: 'anonymous' as const },
      { role: 'readonly' as const },
      { tierAccess: ['confidential' as const] },
    ])
      expect(core.resolveFirstJobViewer({ ...auth, ...change }).ready).toBe(false);
  });

  it('rejects a stale session before any write', () => {
    expect(
      post({ action: 'start', request_id: id(), session_id: 'concierge-' + 'f'.repeat(64) })
    ).toMatchObject({ status: 409, error: 'first_job_scope_changed' });
    expect(contract.parseFirstJobReadRequest({ tenant: 'other' })).toBeUndefined();
    expect(state.writes).toBe(0);
  });

  it('admits only the local localadmin, even through a mapping written for another kind of viewer', () => {
    for (const change of [{ source: 'token' as const }, { role: 'readonly' as const }]) {
      state.mappings = [{ ...mapping(), viewer: { ...viewer, ...change } }];
      expect(
        core.resolveFirstJobViewer({ ...viewer, ...change }).ready,
        JSON.stringify(change)
      ).toBe(false);
    }
    state.mappings = [mapping()];
    expect(core.resolveFirstJobViewer({ ...viewer, principalId: ' ' }).ready).toBe(false);
  });

  it('never uses all, multiple or protected mapping scopes as a public singleton', () => {
    for (const override of [
      { tenantSlugs: 'all' as const },
      { organizationIds: 'all' as const },
      { projectIds: 'all' as const },
      { projectIds: ['one', 'two'] },
      { tierAccess: ['confidential' as const] },
    ]) {
      state.mappings = [{ ...mapping(), viewer: { ...viewer, ...override } }];
      expect(core.resolveFirstJobViewer(viewer).ready).toBe(false);
    }
  });

  it('admits only explicitly tenant-bound diagnostic charters without inventing org/project IDs', () => {
    state.mappings = [
      { ...mapping(), viewer: { ...viewer, organizationIds: 'all', projectIds: 'all' } },
    ];
    state.charter!.scope = { tier: 'public', tenant_slug: 'alpha-team' };
    const unbound = { ...viewer, organizationIds: 'all' as const, projectIds: 'all' as const };
    expect(core.resolveFirstJobViewer(unbound)).toMatchObject({ ready: true, viewer: unbound });
    expect(core.resolveFirstJobViewer(viewer).ready).toBe(false);
    expect(core.resolveFirstJobViewer({ ...unbound, organizationIds: ['other'] }).ready).toBe(
      false
    );
    const start = post({ action: 'start', request_id: id() });
    expect(start.body!.scope).toEqual({ tenant: 'alpha-team', tier: 'public' });
    state.projections.set(id(), {
      status: 'work_completed',
      text: 'done',
      artifactPath: '/private/path',
      artifactSha256: 'b'.repeat(64),
    });
    const revision = post({
      action: 'revise',
      request_id: id(2),
      artifactRevision: {
        requestId: id(),
        revision: 1,
        sha256: 'b'.repeat(64),
        format: 'compact',
      },
    });
    expect(revision.body!.ok).toBe(true);
    expect(revision.body!.tasks).toHaveLength(2);
    expect(
      store.listConfiguredFrontDeskExecutions().map((entry) => entry.binding.diagnostic_protocol)
    ).toEqual(['first-job-v1', 'first-job-v1']);
    state.charter!.scope.organization_id = 'other';
    expect(read().body!.readiness.status).toBe('mapping_unavailable');
    expect(post({ action: 'start', request_id: id(3) }).status).toBe(409);
  });

  it('persists diagnostic admission provenance and rejects stripped bindings or a generic charter', () => {
    expect(post({ action: 'start', request_id: id() }).body!.ok).toBe(true);
    const binding = store.listConfiguredFrontDeskExecutions()[0].binding;
    expect(binding.diagnostic_protocol).toBe('first-job-v1');
    const writes = state.writes;
    const { diagnostic_protocol: _marker, ...stripped } = binding;
    expect(store.inspectFrontDeskExecution(stripped, state.charter!)).toMatchObject({
      ok: false,
      reason: 'request_mismatch',
    });
    delete state.charter!.runtime.execution_mode;
    expect(store.inspectFrontDeskExecution(binding, structuredClone(state.charter!))).toMatchObject(
      { ok: false, reason: 'diagnostic_provenance_requires_active_mode' }
    );
    expect(state.writes).toBe(writes);
  });

  it('requires an active bounded diagnostic charter and rejects restored generic model wakes', () => {
    state.charter!.runtime.execution_mode = undefined;
    expect(read().body!.readiness.status).toBe('mapping_unavailable');
    state.charter!.runtime.execution_mode = 'front_desk_diagnostic';
    state.charter!.status = 'paused';
    expect(read().body!.readiness.status).toBe('mapping_unavailable');
    state.charter = undefined;
    expect(post({ action: 'start', request_id: id() }).status).toBe(409);
    expect(state.writes).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('records exactly one fixed diagnostic per request UUID and keeps reads read-only', () => {
    const start = { action: 'start', request_id: id() };
    expect(post(start).body).toMatchObject({ ok: true, mode: 'intake', replayed: false });
    const writes = state.writes;
    expect(post(start).body).toMatchObject({ ok: true, mode: 'history', replayed: true });
    expect(state.writes).toBe(writes);
    const locks = state.locks;
    const before = JSON.stringify([...state.files]);
    const got = read();
    read();
    expect(got.body!.tasks).toHaveLength(1);
    expect(JSON.stringify([...state.files])).toBe(before);
    expect(state.writes).toBe(writes);
    expect(state.locks).toBe(locks);
    const stored = JSON.stringify([...state.files]);
    expect(stored).toContain('human:presence-studio-localadmin');
    expect(stored).not.toContain('human:concierge-localadmin');
    expect(state.run).not.toHaveBeenCalled();
  });

  it('rejects client text, scope, approval and guessed revision without storing it', () => {
    for (const extra of [
      { text: 'protected private secret' },
      { tenant: 'other' },
      { tier: 'personal' },
      { approved: true },
    ])
      expect(post({ action: 'start', request_id: id(), ...extra }).status).toBe(400);
    expect(
      post({
        action: 'revise',
        request_id: id(2),
        artifactRevision: {
          requestId: id(),
          revision: 1,
          sha256: 'a'.repeat(64),
          format: 'compact',
        },
      }).status
    ).toBe(409);
    expect(state.writes).toBe(0);
    expect(state.files.size).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('fails closed if configuration is revoked between readiness and reservation', () => {
    state.revokeAt = 2;
    expect(post({ action: 'start', request_id: id() })).toMatchObject({
      status: 409,
      error: 'first_job_diagnostic_admission_required',
    });
    expect(state.writes).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('fails closed if the diagnostic charter is revoked between readiness and atomic reservation', () => {
    state.revokeCharterAt = 2;
    expect(post({ action: 'start', request_id: id() })).toMatchObject({
      status: 409,
      error: 'first_job_diagnostic_admission_required',
    });
    expect(state.writes).toBe(0);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('never replays an ordinary non-diagnostic turn as admitted execution', () => {
    state.mappings = [];
    store.reserveConversationTurn(viewer, execution.FRONT_DESK_RECEIPT_COMMAND, id());
    state.mappings = [mapping()];
    const writes = state.writes;
    expect(post({ action: 'start', request_id: id() }).status).toBe(409);
    expect(state.writes).toBe(writes);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('detects revoked setup for a known session and does not load its old history', () => {
    const first = post({ action: 'start', request_id: id() });
    state.mappings = [];
    const again = read({ session_id: first.body!.sessionId });
    expect(again.body!.readiness.status).toBe('mapping_changed');
    expect(again.body!.messages).toEqual([]);
    expect(post({ action: 'start', request_id: id() }).status).toBe(409);
  });

  it('uses verified artifact identity for immutable revision, retains old receipt, and omits paths', () => {
    post({ action: 'start', request_id: id() });
    state.projections.set(id(), {
      status: 'work_completed',
      text: 'private /secret/output',
      artifactPath: '/secret/output',
      artifactSha256: 'b'.repeat(64),
    });
    const history = read();
    const artifact = history.body!.messages.find(
      (message: { artifact?: unknown }) => message.artifact
    )?.artifact;
    expect(artifact).toEqual({
      requestId: id(),
      revision: 1,
      sha256: 'b'.repeat(64),
      format: 'readable',
      canRevise: true,
    });
    expect(JSON.stringify(history.body)).not.toContain('/secret');
    const revision = {
      action: 'revise',
      request_id: id(2),
      artifactRevision: {
        requestId: artifact.requestId,
        revision: artifact.revision,
        sha256: artifact.sha256,
        format: 'compact',
      },
    };
    expect(post(revision).body!.ok).toBe(true);
    expect(post(revision).body!.replayed).toBe(true);
    const current = read();
    expect(current.body!.tasks).toHaveLength(2);
    expect(
      current.body!.messages.find((message: { artifact?: unknown }) => message.artifact)?.artifact
        .canRevise
    ).toBe(false);
    expect(post({ ...revision, request_id: id(3) }).status).toBe(409);
    state.digest = 'c'.repeat(64);
    expect(post(revision).status).toBe(409);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('hides arbitrary legacy text in the same public transcript', () => {
    store.reserveConversationTurn(viewer, 'protected /internal/path', id(8));
    expect(
      store.readConversationHistory(viewer, { readOnly: true }).messages.length
    ).toBeGreaterThan(0);
    const result = read();
    expect(result.body!.messages).toEqual([]);
    expect(result.body!.tasks).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain('/internal');
  });
});

describe('read-only diagnostic artifact body (no HTTP)', () => {
  const selector = (n = 1, revision = 1, hash = 'b') => ({
    session_id: store.conversationRef(viewer).sessionId,
    request_id: id(n),
    revision: String(revision),
    sha256: hash.repeat(64),
  });
  const artifact = (query: Record<string, unknown>) => {
    const input = contract.parseFirstJobArtifactReadRequest(query);
    return input ? core.readFirstJobArtifact(viewer, input) : 'invalid';
  };
  function completed() {
    post({ action: 'start', request_id: id() });
    state.projections.set(id(), {
      status: 'work_completed',
      text: 'private path must not leak',
      artifactPath: '/private/path',
      artifactSha256: 'b'.repeat(64),
      artifactBody: '{\n  "diagnostic": true\n}\n',
    });
  }

  it('returns the exact verified body and immutable identity without locking or writing', () => {
    completed();
    const writes = state.writes,
      locks = state.locks,
      files = JSON.stringify([...state.files]);
    const result = artifact(selector());
    expect(result).toMatchObject({
      ok: true,
      sessionId: store.conversationRef(viewer).sessionId,
      artifact: {
        requestId: id(),
        revision: 1,
        sha256: 'b'.repeat(64),
        verification: 'verified',
        currentness: 'latest_verified',
        body: '{\n  "diagnostic": true\n}\n',
      },
    });
    expect(JSON.stringify(result)).not.toContain('/private/path');
    expect(JSON.stringify(read().body)).not.toContain('"body"');
    artifact(selector());
    expect(state.writes).toBe(writes);
    expect(state.locks).toBe(locks);
    expect(JSON.stringify([...state.files])).toBe(files);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('keeps an older verified revision readable after a new immutable revision completes', () => {
    completed();
    post({
      action: 'revise',
      request_id: id(2),
      artifactRevision: { requestId: id(), revision: 1, sha256: 'b'.repeat(64), format: 'compact' },
    });
    state.projections.set(id(2), {
      status: 'work_completed',
      text: 'done',
      artifactPath: '/private/new',
      artifactSha256: 'c'.repeat(64),
      artifactBody: '{"diagnostic":true}',
    });
    expect((artifact(selector()) as { artifact: unknown }).artifact).toMatchObject({
      requestId: id(),
      currentness: 'older_verified',
      body: '{\n  "diagnostic": true\n}\n',
    });
    expect((artifact(selector(2, 2, 'c')) as { artifact: unknown }).artifact).toMatchObject({
      requestId: id(2),
      currentness: 'latest_verified',
      body: '{"diagnostic":true}',
    });
  });

  it('rejects missing, stale, revoked and cross-conversation selectors without body', () => {
    completed();
    for (const query of [
      selector(9),
      selector(1, 2),
      selector(1, 1, 'c'),
      { ...selector(), session_id: 'concierge-' + 'f'.repeat(64) },
    ])
      expect(artifact(query)).toBeUndefined();
    state.projections.set(id(), { status: 'uncertain', text: 'unverified' });
    expect(artifact(selector())).toBeUndefined();
    completed();
    state.mappings = [];
    expect(artifact(selector())).toBeUndefined();
  });

  it('cannot read another principal, member, tenant, project or protected-tier receipt', () => {
    completed();
    const input = { ...selector(), revision: 1 };
    for (const change of [
      { principalId: 'human:other' },
      { memberId: 'other' },
      { tenantSlugs: ['other'] },
      { organizationIds: ['other'] },
      { projectIds: ['other'] },
      { tierAccess: ['confidential' as const] },
      { source: 'token' as const },
      { role: 'readonly' as const },
    ])
      expect(core.readFirstJobArtifact({ ...viewer, ...change }, input)).toBeUndefined();
  });

  it('fails closed on unreadable history without serving a cached body or creating a retry', () => {
    completed();
    expect(artifact(selector())).toMatchObject({ ok: true });
    for (const key of state.files.keys()) state.files.set(key, { version: 999 });
    const writes = state.writes,
      locks = state.locks;
    expect(() => artifact(selector())).toThrow();
    expect(state.writes).toBe(writes);
    expect(state.locks).toBe(locks);
    expect(state.run).not.toHaveBeenCalled();
  });

  it('rejects path and scope selectors as invalid', () => {
    for (const extra of [
      { path: '/etc/passwd' },
      { artifactPath: '../private' },
      { tenant: 'other' },
      { tier: 'personal' },
      { approved: true },
    ])
      expect(artifact({ ...selector(), ...extra })).toBe('invalid');
    expect(state.writes).toBe(0);
    expect(state.locks).toBe(0);
  });
});
