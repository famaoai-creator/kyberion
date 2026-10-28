/** Reuse-first learning intake. Planning and queueing never grant publication authority. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFileSnapshot,
  safeReaddir,
} from '../secure-io.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import {
  createDistillCandidateRecord,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
  updateDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
} from './memory-promotion-queue.js';
import {
  learningEntityRoot as entityRoot,
  learningSourceAllowed as sourceAllowed,
  reusableLearningMemorySourceRef,
  assertReusableLearningBinding,
} from './reusable-learning-binding.js';

export type LearningDestination = 'knowledge' | 'skill' | 'pipeline' | 'procedure' | 'evidence';
export type LearningPlanDecision =
  'extend_existing' | 'replace_existing' | 'create_new' | 'no_change';
export interface ReusableLearningPlan {
  version: 1;
  decision: LearningPlanDecision;
  destination: LearningDestination;
  source_ref: string;
  source_sha256: string;
  scope: MemoryScopeEnvelope;
  target_ref?: string;
  base_sha256?: string;
  reason: string;
  reuse_condition: string;
  verification_command: string;
  approval_required: true;
  next_steps: string[];
  search: { examined: number; truncated: boolean };
}
export interface PrepareReusableLearningInput {
  /** Authority comes from the calling execution context, never this classification envelope. */
  scope: MemoryScopeEnvelope;
  sourceRef: string;
  intent: string;
  title: string;
  destination: LearningDestination;
  reuseCondition: string;
  verificationCommand: string;
  /** An explicit request to replace an already readable asset; never model-selected. */
  replaceTarget?: string;
}
interface LearningAsset {
  ref: string;
  content: string;
  sha256: string;
  destination: LearningDestination;
}
const MAX_BYTES = 128 * 1024;
const MAX_FILES = 300;
const MAX_DIRECTORIES = 100;
const ENTITY_FOLDERS = new Set(['organizations', 'projects', 'missions', 'tasks', 'sessions']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// Indentation inside fenced code and YAML is meaningful; normalize line endings only.
const normalized = (value: string) => value.replaceAll('\r\n', '\n').trim();

function requireText(value: string, field: string, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new Error(`[LEARNING_INTAKE_INVALID] ${field} must contain 1-${max} characters`);
  return value.trim();
}

function lexicalRef(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error('[LEARNING_SOURCE_SCOPE] A repository file is required');
  const absolute = path.resolve(pathResolver.rootDir(), value);
  const ref = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  if (!ref || ref.startsWith('../') || path.isAbsolute(ref))
    throw new Error('[LEARNING_SOURCE_SCOPE] A repository file is required');
  return ref;
}

function canonicalRef(value: string): string {
  const ref = lexicalRef(value);
  // The bootstrap-safe repository boundary rejects symbolic parents and leafs without
  // asking tenant policy to enumerate protected bare prefixes such as confidential/.
  assertSafeRepositoryPath(pathResolver.rootResolve(ref));
  return ref;
}

/** Search only public catalogs and the exact entity's asset floor, never sibling entities. */
function assetRoots(scope: MemoryScopeEnvelope, destination: LearningDestination): string[] {
  const roots =
    destination === 'pipeline'
      ? ['pipelines', 'knowledge/product/pipeline-templates']
      : destination === 'skill'
        ? ['plugins/kyberion-agent-plugin/skills', 'plugins/kyberion-claude-code/skills']
        : destination === 'procedure'
          ? ['knowledge/product/procedures']
          : [
              'knowledge/product/orchestration',
              'knowledge/product/architecture',
              'knowledge/product/governance',
            ];
  if (scope.tier !== 'public') roots.unshift(entityRoot(scope));
  return roots;
}

function readSource(ref: string): string {
  if (!/\.(?:md|txt|json|ya?ml|csv)$/iu.test(ref))
    throw new Error(
      '[LEARNING_SOURCE_INVALID] Use a text artifact; perceive documents/media with kyberion read/see/listen/watch first'
    );
  const absolute = pathResolver.rootResolve(ref);
  const stat = safeLstat(absolute);
  if (!stat.isFile() || stat.size > MAX_BYTES)
    throw new Error(
      `[LEARNING_SOURCE_INVALID] Source must be a regular file <= ${MAX_BYTES} bytes`
    );
  const bytes = safeReadFileSnapshot(absolute, MAX_BYTES + 1);
  if (bytes.length > MAX_BYTES)
    throw new Error('[LEARNING_SOURCE_INVALID] Source changed beyond the byte limit');
  const text = bytes.toString('utf8');
  if (text.includes('\0'))
    throw new Error(
      '[LEARNING_SOURCE_INVALID] Binary material requires a perception artifact first'
    );
  return text;
}

function destinationFor(ref: string): LearningDestination {
  if (/(?:^|\/)SKILL\.md$/u.test(ref) || ref.includes('/skills/')) return 'skill';
  if (ref.endsWith('.json') && /(?:^|\/)(?:pipelines|pipeline-templates)\//u.test(ref))
    return 'pipeline';
  if (/(?:^|\/)procedures\//u.test(ref)) return 'procedure';
  return 'knowledge';
}

function tokens(value: string): Set<string> {
  const text = value.toLowerCase();
  const words: string[] = text.match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? [];
  for (const phrase of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ??
    [])
    for (let i = 0; i < phrase.length - 1; i += 1) words.push(phrase.slice(i, i + 2));
  return new Set(words);
}

function similarity(query: Set<string>, asset: LearningAsset): number {
  const terms = tokens(`${asset.ref}\n${asset.content.slice(0, 8000)}`);
  const shared = [...query].filter((word) => terms.has(word)).length;
  return shared >= 2 ? shared / Math.max(query.size, 1) : 0;
}

function searchAssets(
  scope: MemoryScopeEnvelope,
  destination: LearningDestination
): {
  assets: LearningAsset[];
  examined: number;
  truncated: boolean;
} {
  const assets: LearningAsset[] = [];
  let examined = 0;
  let directories = 0;
  let truncated = false;
  const roots = assetRoots(scope, destination);
  const quota = Math.ceil(MAX_FILES / roots.length);
  let rootLimit = quota;
  const visit = (ref: string, depth: number): void => {
    if (
      depth > 6 ||
      examined >= rootLimit ||
      examined >= MAX_FILES ||
      directories >= MAX_DIRECTORIES
    ) {
      truncated = true;
      return;
    }
    if (!safeExistsSync(pathResolver.rootResolve(ref))) return;
    const stat = safeLstat(pathResolver.rootResolve(ref));
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      directories += 1;
      for (const name of safeReaddir(pathResolver.rootResolve(ref)).sort()) {
        if (examined >= rootLimit || examined >= MAX_FILES || directories >= MAX_DIRECTORIES) {
          truncated = true;
          break;
        }
        if (!name.startsWith('.') && !ENTITY_FOLDERS.has(name)) visit(`${ref}/${name}`, depth + 1);
      }
      return;
    }
    if (!stat.isFile()) return;
    examined += 1;
    if (!/\.(?:md|json)$/u.test(ref)) return;
    if (stat.size > MAX_BYTES) return;
    try {
      const content = readSource(ref);
      assets.push({ ref, content, sha256: digest(content), destination: destinationFor(ref) });
    } catch {
      // Unreadable assets are not evidence and must never appear in a plan.
    }
  };
  for (const root of roots) {
    rootLimit = Math.min(MAX_FILES, examined + quota);
    visit(root, 0);
  }
  return { assets, examined, truncated };
}

/** Shared read-only inventory for foreground intake and background review prompts.
 * Ref/digest suggestions are advisory; they cannot substitute for effect approval.
 */
export function findReusableLearningAssets(input: {
  scope: MemoryScopeEnvelope;
  destination: LearningDestination;
  query: string;
  limit?: number;
}): {
  assets: Array<{ ref: string; base_sha256: string; score: number }>;
  search: { examined: number; truncated: boolean };
} {
  const scope = assertMemoryScope(input.scope);
  const query = tokens(requireText(input.query, 'query', 16000));
  const found = searchAssets(scope, input.destination);
  const limit = input.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    throw new Error('[LEARNING_INTAKE_INVALID] Search limit must be an integer from 1 to 10');
  const assets = found.assets
    .filter(
      (asset) =>
        asset.destination === input.destination &&
        (scope.tier === 'public' || asset.ref.startsWith(entityRoot(scope) + '/'))
    )
    .map((asset) => ({
      ref: asset.ref,
      base_sha256: asset.sha256,
      score: similarity(query, asset),
    }))
    .filter((asset) => asset.score >= 0.2)
    .sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : 1))
    .slice(0, limit);
  return { assets, search: { examined: found.examined, truncated: found.truncated } };
}

/** Deterministic, bounded discovery. It does not execute commands or modify an asset. */
export function planReusableLearning(input: PrepareReusableLearningInput): ReusableLearningPlan {
  const scope = assertMemoryScope(input.scope);
  if (
    Object.entries(input.scope).some(
      ([field, value]) => value !== undefined && !Object.hasOwn(scope, field)
    )
  )
    throw new Error('[LEARNING_SOURCE_SCOPE] Unknown scope fields cannot be dropped');
  if (!['knowledge', 'skill', 'pipeline', 'procedure', 'evidence'].includes(input.destination))
    throw new Error('[LEARNING_INTAKE_INVALID] Unknown learning destination');
  const intent = requireText(input.intent, 'intent');
  requireText(input.title, 'title', 240);
  const reuse = requireText(input.reuseCondition, 'reuseCondition');
  const verification = requireText(input.verificationCommand, 'verificationCommand');
  const sourceLexical = lexicalRef(input.sourceRef);
  if (!sourceAllowed(sourceLexical, scope))
    throw new Error('[LEARNING_SOURCE_SCOPE] Source is outside the active learning scope');
  const ref = canonicalRef(sourceLexical);
  if (!sourceAllowed(ref, scope))
    throw new Error('[LEARNING_SOURCE_SCOPE] Source is outside the active learning scope');
  const source = readSource(ref);
  const found = searchAssets(scope, input.destination);
  const choices = found.assets.filter(
    (asset) =>
      asset.destination === input.destination &&
      // Public reference knowledge may inform private work, but private source material
      // must never be proposed as a patch to a public catalog.
      (scope.tier === 'public' || asset.ref.startsWith(entityRoot(scope) + '/'))
  );
  const identical = choices.find((asset) => normalized(asset.content) === normalized(source));
  let target = identical;
  if (input.replaceTarget) {
    const targetLexical = lexicalRef(input.replaceTarget);
    if (!sourceAllowed(targetLexical, scope))
      throw new Error('[LEARNING_TARGET_SCOPE] Replacement is outside the active learning scope');
    const replacement = canonicalRef(targetLexical);
    if (
      destinationFor(replacement) !== input.destination ||
      (scope.tier !== 'public' && !replacement.startsWith(entityRoot(scope) + '/')) ||
      !assetRoots(scope, input.destination).some((root) => replacement.startsWith(root + '/'))
    )
      throw new Error(
        '[LEARNING_TARGET_SCOPE] Replacement must be an existing readable asset in this scope'
      );
    const content = readSource(replacement);
    target = { ref: replacement, content, sha256: digest(content), destination: input.destination };
  }
  if (!target) {
    const query = tokens(`${input.title}\n${intent}`);
    const ranked = choices
      .map((asset) => ({ asset, score: similarity(query, asset) }))
      .filter((row) => row.score >= 0.5)
      .sort((a, b) => b.score - a.score || (a.asset.ref < b.asset.ref ? -1 : 1));
    target = ranked[0]?.asset;
  }
  const unchanged = target && normalized(target.content) === normalized(source);
  const decision: LearningPlanDecision =
    input.destination === 'evidence' || unchanged
      ? 'no_change'
      : input.replaceTarget
        ? 'replace_existing'
        : target
          ? 'extend_existing'
          : 'create_new';
  const reason =
    input.destination === 'evidence'
      ? 'Keep unsettled or one-off work as evidence; no durable asset is proposed.'
      : unchanged
        ? 'An existing asset already contains this material.'
        : target
          ? 'Improve an existing relevant asset before creating another.'
          : 'No sufficiently relevant readable asset was found in the bounded search; review before creating one.';
  return {
    version: 1,
    decision,
    destination: input.destination,
    source_ref: ref,
    source_sha256: digest(source),
    scope,
    ...(target ? { target_ref: target.ref, base_sha256: target.sha256 } : {}),
    reason,
    reuse_condition: reuse,
    verification_command: verification,
    approval_required: true,
    next_steps: [
      ...(found.truncated
        ? ['Review additional catalog matches: the bounded search was truncated.']
        : []),
      ...(decision === 'no_change'
        ? ['Retain the source evidence; no asset write is needed.']
        : [
            'Review the candidate and shape the smallest reusable change; source evidence is not a finished skill.',
            input.destination === 'pipeline'
              ? 'Validate a successful run and abstracted ADF through pipeline promote; this plan is not execution proof.'
              : input.destination === 'procedure'
                ? 'Use the existing browser/service recording review and procedure promotion path.'
                : 'Use the existing knowledge/skill review and content-bound approval path.',
            'Re-read the target and bind approval to its current digest before applying any change.',
          ]),
    ],
    search: { examined: found.examined, truncated: found.truncated },
  };
}

/** Queue only a review proposal in the existing registry. No promotion or approval is implied. */
export function prepareReusableLearning(
  input: PrepareReusableLearningInput,
  options: { dryRun?: boolean } = {}
): { plan: ReusableLearningPlan; candidate?: DistillCandidateRecord; persisted: boolean } {
  const plan = planReusableLearning(input);
  if (plan.decision === 'no_change') return { plan, persisted: false };
  const storageScope =
    plan.scope.tier === 'public' && !plan.scope.tenant_slug ? undefined : plan.scope;
  const id = `DSC-LEARN-${digest(
    JSON.stringify({
      digest: plan.source_sha256,
      scope: plan.scope,
      destination: plan.destination,
      target: plan.target_ref,
      base: plan.base_sha256,
      intent: input.intent.trim(),
      title: input.title.trim(),
      reuse: plan.reuse_condition,
      verify: plan.verification_command,
    })
  ).slice(0, 24)}`;
  plan.next_steps.push(`pnpm kyberion learning prepare --queue --candidate ${id}`);
  const existing = options.dryRun ? null : loadDistillCandidateRecord(id, storageScope);
  if (existing) return { plan, candidate: existing, persisted: true };
  const candidate = createDistillCandidateRecord({
    candidate_id: id,
    source_type: plan.scope.mission_id ? 'mission' : 'artifact',
    tier: plan.scope.tier,
    ...(storageScope ? { scope: storageScope } : {}),
    ...(plan.scope.mission_id ? { mission_id: plan.scope.mission_id } : {}),
    title: input.title.trim(),
    summary: `${input.intent.trim()}\n\n${plan.reason}`,
    status: 'proposed',
    target_kind:
      plan.destination === 'procedure'
        ? 'procedure'
        : plan.destination === 'pipeline'
          ? 'sop_candidate'
          : 'pattern',
    evidence_refs: [plan.source_ref],
    metadata: {
      origin: 'learning_intake',
      learning_plan: plan,
      maintenance: { automatic_archive: false },
    },
  });
  if (!options.dryRun) saveDistillCandidateRecord(candidate);
  return { plan, candidate, persisted: !options.dryRun };
}

/** Explicit handoff to the existing steward review queue. This is not approval. */
export function queueReusableLearning(
  candidateId: string,
  selectedScope: MemoryScopeEnvelope,
  options: { dryRun?: boolean } = {}
): { candidate_id: string; memory_candidate_id: string; queued: boolean; next_steps: string[] } {
  const canonical = assertMemoryScope(selectedScope);
  if (
    Object.entries(selectedScope).some(
      ([field, value]) => value !== undefined && !Object.hasOwn(canonical, field)
    )
  )
    throw new Error('[LEARNING_SOURCE_SCOPE] Unknown scope fields cannot be dropped');
  const scope = canonical.tier === 'public' && !canonical.tenant_slug ? undefined : canonical;
  const row = loadDistillCandidateRecord(candidateId, scope);
  if (!row || row.metadata?.origin !== 'learning_intake' || row.status !== 'proposed')
    throw new Error(
      '[LEARNING_LINK_INVALID] Proposed learning intake not found in this exact scope'
    );
  const sourceRef = reusableLearningMemorySourceRef(row);
  assertReusableLearningBinding({ source_ref: sourceRef, scope });
  const queueId = `MEM-LEARN-${digest(sourceRef).slice(0, 32)}`;
  const plan = row.metadata.learning_plan as unknown as ReusableLearningPlan;
  const expected = createMemoryPromotionCandidate({
    candidateId: queueId,
    sourceType: 'artifact',
    sourceRef,
    knowledgeDomain: 'unclassified',
    proposedMemoryKind: 'sop',
    summary: row.summary,
    evidenceRefs: [plan.source_ref],
    sensitivityTier: canonical.tier,
    ratificationRequired: true,
    scope,
    queuedAt: row.created_at,
  });
  const existing = loadMemoryPromotionCandidate(queueId, scope);
  if (existing && existing.status !== 'queued')
    throw new Error(
      '[LEARNING_ALREADY_REVIEWED] This plan has already been decided; prepare a new plan for a new change'
    );
  if (
    existing &&
    (existing.source_ref !== sourceRef ||
      existing.summary !== expected.summary ||
      existing.sensitivity_tier !== expected.sensitivity_tier ||
      JSON.stringify(existing.evidence_refs) !== JSON.stringify(expected.evidence_refs))
  )
    throw new Error(
      '[LEARNING_LINK_INVALID] Existing review queue identity conflicts with this plan'
    );
  if (!options.dryRun) {
    if (!existing) enqueueMemoryPromotionCandidate(expected);
    const queued = loadMemoryPromotionCandidate(queueId, scope);
    if (!queued || queued.source_ref !== sourceRef)
      throw new Error('[LEARNING_LINK_INVALID] Review queue persistence failed');
    updateDistillCandidateRecord(
      candidateId,
      {
        metadata: {
          ...row.metadata,
          learning_link: { candidate_id: queueId, source_ref: sourceRef },
        },
      },
      scope
    );
  }
  return {
    candidate_id: candidateId,
    memory_candidate_id: queueId,
    queued: !options.dryRun,
    next_steps: [
      `pnpm mission memory-review ${queueId}`,
      `pnpm mission memory-approve ${queueId} --knowledge-domain <product|organization|personal> --curation-json '<reviewed title, summary, content, evidence_refs>'`,
      'Classify and curate the reusable lesson from its evidence. Queueing does not approve or publish it.',
      ...(plan.destination === 'pipeline'
        ? [
            'After review, use pipeline promote with the plan source_ref and a successful content-bound trace; a memory review is not execution proof.',
          ]
        : []),
      ...(canonical.tier === 'public'
        ? [
            'Product publication additionally requires evidence retained under knowledge/public or active/missions/public; retain it there and prepare again if the source is only temporary.',
          ]
        : []),
    ],
  };
}
