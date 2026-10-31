/** Real scoped learning stores with an isolated review principal; no production human-auth claim. */
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCandidate } from '../knowledge/memory-promotion-queue.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-judgment-learning-${randomUUID()}`);
let bootstrap: typeof import('../secure-io.js'), io: typeof import('../secure-io.js');
let queue: typeof import('../knowledge/memory-promotion-queue.js');
let workflow: typeof import('../knowledge/scoped-learning-workflow.js');
let approval: typeof import('../governance/approval-store.js');
let learningApproval: typeof import('../knowledge/scoped-learning-approval.js');
let domain: typeof import('../knowledge/scoped-learning-domain.js');
let publication: typeof import('../knowledge/scoped-learning-publication.js');
let retrieval: typeof import('../knowledge/scoped-learning-retrieval.js');
let promoted: typeof import('../promoted-memory.js');
let distill: typeof import('../knowledge/distill-candidate-registry.js');
let reasoning: typeof import('../reasoning/reasoning-backend.js');
let authority: typeof import('../authority.js');
let members: typeof import('./member-registry.js');
let projects: typeof import('../project/project-registry.js');
let audit: typeof import('../governance/audit-chain.js');
let approvalLocation: typeof import('../governance/approval-store-location.js');
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
beforeAll(async () => {
  bootstrap = await import('../secure-io.js');
  bootstrap.safeMkdir(root, { recursive: true });
  const copy = (from: string, to: string): void => {
    if (bootstrap.safeLstat(from).isDirectory()) {
      bootstrap.safeMkdir(to, { recursive: true });
      for (const name of bootstrap.safeReaddir(from))
        copy(path.join(from, name), path.join(to, name));
    } else bootstrap.safeCopyFileSync(from, to);
  };
  for (const name of ['schemas', 'governance', 'orchestration'])
    copy(
      path.join(sourceRoot, 'knowledge/product', name),
      path.join(root, 'knowledge/product', name)
    );
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('SYSTEM_ROLE', 'operator_surface');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  vi.resetModules();
  io = await import('../secure-io.js');
  queue = await import('../knowledge/memory-promotion-queue.js');
  workflow = await import('../knowledge/scoped-learning-workflow.js');
  approval = await import('../governance/approval-store.js');
  learningApproval = await import('../knowledge/scoped-learning-approval.js');
  domain = await import('../knowledge/scoped-learning-domain.js');
  publication = await import('../knowledge/scoped-learning-publication.js');
  retrieval = await import('../knowledge/scoped-learning-retrieval.js');
  promoted = await import('../promoted-memory.js');
  distill = await import('../knowledge/distill-candidate-registry.js');
  reasoning = await import('../reasoning/reasoning-backend.js');
  authority = await import('../authority.js');
  members = await import('./member-registry.js');
  projects = await import('../project/project-registry.js');
  audit = await import('../governance/audit-chain.js');
  approvalLocation = await import('../governance/approval-store-location.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  reasoning?.resetReasoningBackend();
});
afterAll(() => {
  vi.unstubAllEnvs();
  bootstrap?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});
function fixture() {
  const suffix = randomUUID().slice(0, 8),
    tenant = 'learn-reg-' + suffix,
    member = 'reviewer-' + suffix;
  vi.stubEnv('KYBERION_TENANT', tenant);
  io.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  io.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants', tenant + '.json'),
    JSON.stringify({
      tenant_slug: tenant,
      display_name: 'Isolated learning fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  projects.saveProjectRecord({
    project_id: 'learning-project',
    name: 'Learning regression',
    summary: 'Publication recovery',
    status: 'active',
    tier: 'confidential',
    tenant_slug: tenant,
    organization_id: 'learning-org',
  } as Parameters<typeof projects.saveProjectRecord>[0]);
  const scope = {
    tier: 'confidential' as const,
    tenant_slug: tenant,
    organization_id: 'learning-org',
    project_id: 'learning-project',
  };
  authority.withExecutionContext('sovereign_concierge', () =>
    members.writeMemberProfile({
      member_id: member,
      display_name: 'Isolated review fixture',
      status: 'active',
      memberships: [{ tenant_slug: tenant, role: 'owner' }],
      access_registrations: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  );
  const candidate = queue.createMemoryPromotionCandidate({
    candidateId: 'MEM-LEARNING-' + suffix,
    sourceType: 'task_session',
    sourceRef: 'task_session:isolated-learning-' + suffix,
    knowledgeDomain: 'organization',
    proposedMemoryKind: 'sop',
    summary: 'Reconcile input totals against source records before producing the final report.',
    evidenceRefs: ['task_session:isolated-learning-' + suffix],
    sensitivityTier: 'confidential',
    scope,
    ratificationRequired: true,
  });
  const event = audit.auditChain.record({
    agentId: 'isolated-learning-review',
    action: 'knowledge_promotion_candidate',
    operation: 'enqueue',
    result: 'completed',
    tenantSlug: tenant,
  });
  candidate.audit_ref = 'audit:' + event.id;
  queue.enqueueMemoryPromotionCandidate(candidate);
  const address = { candidateId: candidate.candidate_id, scope };
  const current = () => queue.loadMemoryPromotionCandidate(candidate.candidate_id, scope)!;
  const curation = {
    title: 'Evidence-backed reconciliation SOP',
    summary: candidate.summary,
    content:
      'Compare source record totals, inspect discrepancies, and preserve reconciliation evidence before finalizing the report.',
    evidence_refs: candidate.evidence_refs,
  };
  workflow.curateScopedLearningCandidate({
    ...address,
    curation,
    expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
  });
  const requested = workflow.requestScopedLearningCandidateApproval({
    ...address,
    expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
    requester: {
      requestedBy: 'agent:isolated-learning-review',
      actorId: 'agent:isolated-learning-review',
    },
  });
  const ref = requested.learning.approvalRef;
  if (!ref) throw new Error('Canonical human-review request not created');
  const requestId = ref.split(':')[1]!,
    pending = approval.loadApprovalRequest('terminal', requestId)!;
  // This is the real decision facade with an isolated synthetic surface principal, not live human authentication.
  approval.decideApprovalRequest('infrastructure_sentinel', {
    channel: 'terminal',
    requestId,
    decision: 'approved',
    decidedBy: 'user:' + member,
    decidedByType: 'human',
    authenticated: true,
    authMethod: 'surface_session',
    deciderIdentitySource: 'server_resolved',
    presentedDigest: approval.computeApprovalPresentedDigest(pending),
    deciderPrincipal: {
      actor: { kind: 'human', id: 'user:' + member },
      provider: 'offline-fixture-surface',
      source: 'oidc',
      principalId: 'user:' + member,
    },
  });
  queue.updateMemoryPromotionCandidateStatus({
    ...address,
    status: 'approved',
    expectedStatus: 'queued',
    expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
    learningApprovalRef: ref,
  });
  expect(current().status).toBe('approved');
  reasoning.registerReasoningBackend(reasoning.stubReasoningBackend);
  const markdown = domain.scopedLearningMarkdownPath(scope, candidate.candidate_id),
    record = markdown.replace(/\.md$/, '.json');
  const absMarkdown = path.join(root, markdown),
    absRecord = path.join(root, record);
  const read = (file: string) => String(io.safeReadFile(file, { encoding: 'utf8' }));
  const consent = () => approval.loadApprovalRequest('terminal', requestId)!;
  const consentBytes = () => {
    const located = approvalLocation.locateApprovalRequest('terminal', requestId, { scope });
    if (!located) throw new Error('Actual scoped consent location missing');
    return read(
      path.join(
        root,
        approvalLocation.approvalRequestLogicalPathAt(
          located.partition,
          located.storageChannel,
          located.record.id
        )
      )
    );
  };
  const publish = () =>
    workflow.publishScopedLearningCandidate({
      ...address,
      expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
      executionRole: 'mission_controller',
    });
  const reject = () =>
    queue.updateMemoryPromotionCandidateStatus({
      ...address,
      status: 'rejected',
      expectedStatus: 'approved',
      expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
      ratificationNote: 'Rejected before publication recovery',
    });
  const retrieve = () =>
    retrieval.resolveScopedLearningRetrieval({
      documentPath: markdown,
      candidateId: candidate.candidate_id,
      scopeText: JSON.stringify(scope),
      consumerScope: scope,
      sourceSha256: io.safeExistsSync(absMarkdown) ? sha(read(absMarkdown)) : '0'.repeat(64),
    });
  return {
    scope,
    address,
    candidateId: candidate.candidate_id,
    current,
    publish,
    reject,
    retrieve,
    consent,
    consentBytes,
    read,
    markdown,
    record,
    absMarkdown,
    absRecord,
  };
}
type Fixture = ReturnType<typeof fixture>;
function crashAt(f: Fixture, point: 'json_before_markdown' | 'consumed_before_queue') {
  let reached = false;
  if (point === 'json_before_markdown') {
    const write = io.safeWriteFile;
    vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
      if (path.resolve(String(file)) === f.absMarkdown) {
        reached = true;
        throw new Error('CRASH_JSON_BEFORE_MARKDOWN');
      }
      return write(file, data, options);
    });
  } else {
    const update = queue.updateMemoryPromotionCandidateStatus;
    vi.spyOn(queue, 'updateMemoryPromotionCandidateStatus').mockImplementation((input) => {
      if (input.candidateId === f.candidateId && input.status === 'promoted') {
        reached = true;
        throw new Error('CRASH_CONSUMED_BEFORE_QUEUE');
      }
      return update(input);
    });
  }
  return () => reached;
}
function originalDistill(f: Fixture) {
  const candidate = distill.loadDistillCandidateRecord(f.candidateId, f.scope);
  if (!candidate) throw new Error('Actual staged distillation evidence missing');
  return candidate;
}
describe('real scoped-learning publication recovery regression #1218', () => {
  it.each(['json_before_markdown', 'consumed_before_queue'] as const)(
    'recovers an unchanged approved %s crash without replacing immutable evidence',
    async (point) => {
      const f = fixture(),
        reached = crashAt(f, point);
      await expect(f.publish()).rejects.toThrow(
        point === 'json_before_markdown'
          ? 'CRASH_JSON_BEFORE_MARKDOWN'
          : 'CRASH_CONSUMED_BEFORE_QUEUE'
      );
      expect(reached()).toBe(true);
      expect(f.current().status).toBe('approved');
      const originalJson = f.read(f.absRecord),
        consumption = structuredClone(f.consent().consumption);
      if (point === 'json_before_markdown') {
        expect(io.safeExistsSync(f.absMarkdown)).toBe(false);
        expect(consumption).toBeUndefined();
      } else {
        expect(io.safeExistsSync(f.absMarkdown)).toBe(true);
        expect(consumption?.consumer).toBe('scoped_learning_publication');
      }
      const md = io.safeExistsSync(f.absMarkdown) ? f.read(f.absMarkdown) : undefined;
      vi.restoreAllMocks();
      const recovered = await f.publish();
      expect(recovered.learning.state).toBe('published');
      expect(f.current().status).toBe('promoted');
      expect(f.read(f.absRecord)).toBe(originalJson);
      if (md !== undefined) expect(f.read(f.absMarkdown)).toBe(md);
      if (consumption) expect(f.consent().consumption).toEqual(consumption);
      expect(publication.verifyScopedLearningPublication(f.current())).toBeDefined();
      expect(f.retrieve().publication).toBeDefined();
    }
  );
  it.each(['json_before_markdown', 'consumed_before_queue'] as const)(
    'a rejected %s candidate cannot be republished or adopted by recovery',
    async (point) => {
      const f = fixture(),
        reached = crashAt(f, point);
      await expect(f.publish()).rejects.toThrow(
        point === 'json_before_markdown'
          ? 'CRASH_JSON_BEFORE_MARKDOWN'
          : 'CRASH_CONSUMED_BEFORE_QUEUE'
      );
      expect(reached()).toBe(true);
      const record = f.read(f.absRecord),
        md = io.safeExistsSync(f.absMarkdown) ? f.read(f.absMarkdown) : undefined;
      const canonicalConsent = f.consentBytes(),
        consumption = structuredClone(f.consent().consumption),
        staged = originalDistill(f);
      vi.restoreAllMocks();
      f.reject();
      expect(f.current().status).toBe('rejected');
      await expect(f.publish()).rejects.toThrow();
      expect(() => promoted.savePromotedMemoryRecord(staged)).toThrow();
      expect(f.current().status).toBe('rejected');
      expect(f.current().learning_publication).toBeUndefined();
      expect(f.read(f.absRecord)).toBe(record);
      if (md === undefined) expect(io.safeExistsSync(f.absMarkdown)).toBe(false);
      else expect(f.read(f.absMarkdown)).toBe(md);
      expect(f.consentBytes()).toBe(canonicalConsent);
      expect(f.consent().consumption).toEqual(consumption);
      expect(publication.verifyScopedLearningPublication(f.current())).toBeUndefined();
      expect(f.retrieve()).toEqual({ governed: true });
    }
  );
  it('refuses stale-candidate consumption if the actual queue rejects immediately after publication', async () => {
    const f = fixture(),
      consume = learningApproval.recordScopedLearningPublicationConsumption;
    let reached = false;
    vi.spyOn(learningApproval, 'recordScopedLearningPublicationConsumption').mockImplementation(
      (candidate, proof) => {
        if (candidate.candidate_id === f.candidateId) {
          reached = true;
          f.reject();
        }
        // Invoke the REAL consumption facade against the stale approved snapshot; no approval is fabricated or rewritten.
        return consume(candidate, proof);
      }
    );
    await expect(f.publish()).rejects.toThrow();
    expect(reached).toBe(true);
    expect(f.current().status).toBe('rejected');
    expect(io.safeExistsSync(f.absRecord)).toBe(true);
    expect(io.safeExistsSync(f.absMarkdown)).toBe(true);
    expect(f.consent().status).toBe('approved');
    expect(
      f.consent().consumption,
      'Queue rejection must prevent a stale approved snapshot from consuming canonical consent'
    ).toBeUndefined();
    expect(f.current().learning_publication).toBeUndefined();
    expect(f.retrieve()).toEqual({ governed: true });
  });
});
