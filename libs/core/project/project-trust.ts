/** PI-03: bind project-local pipeline execution to a durable human approval. */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import {
  evaluateApprovalUsability,
  assertApprovalUsable,
} from '../governance/approval-separation-of-duties.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { createApprovalRequest } from '../governance/approval-request-create.js';
import {
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
} from '../governance/approval-store-reader.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import {
  NON_HUMAN_PROOF_AUTH_METHODS,
  PROJECT_TRUST_MIN_ASSURANCE,
} from '../governance/approval-assurance.js';
import { pathResolver } from '../path-resolver.js';
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
  type ApprovalRequesterRef,
} from '../governance/approval-requester.js';
import type { CharterScope } from '../governance/accountability-charter.js';
import { runCharterGate } from '../governance/approval-gate-charter.js';
import {
  charterInputForPipelineTrust,
  PIPELINE_TRUST_GRANT_DECISION_TYPE,
} from '../governance/charter-call-site.js';
import type { CharterPathOptions } from '../governance/accountability-charter-registry.js';
import { readTextFile } from '../foundation/text.js';
import { safeExistsSync, safeLstat } from '../secure-io.js';
import { isBuiltinPipelineResource } from '../governance/trust-requiring-resources.js';
import {
  describeExternalHookCommands,
  type ExternalHookSource,
} from '../harnessing/external-hook-bridge.js';
import { parseSafeJsonObjectInput } from '../foundation/json.js';
import { t } from '../localization/t.js';
import {
  computeRunManifestHash,
  describeRunManifest,
  type RunManifest,
} from '../pipeline/run-manifest.js';
import type { RunPrincipalMode } from '../governance/run-manifest-grant.js';
import {
  PROJECT_TRUST_APPROVAL_CHANNEL,
  expectedProjectTrustPayloadHash,
  projectTrustBindingOf,
  projectTrustBindingPayloadV1,
  projectTrustBindingPayloadV2,
  projectTrustEffectBinding,
  projectTrustRequestedEffects,
  requestedPrincipalModes,
  requestedRunsPerDay,
  type ProjectTrustManifestBinding,
} from './project-trust-binding.js';

/**
 * What the approver is trusting. The binding (path + content hash) is the
 * same for every kind, so lookups and assertProjectTrustApproval are
 * unaffected; only the human-facing card changes.
 */
export type ProjectTrustResource =
  { kind: 'pipeline' } | { kind: 'external-hook-config'; source: ExternalHookSource };

export { PROJECT_TRUST_APPROVAL_CHANNEL, projectTrustBindingOf };

function normalizeRelativePath(inputPath: string): { absolute: string; relative: string } {
  const absolute = path.resolve(pathResolver.rootResolve(inputPath));
  const relative = path.relative(pathResolver.rootDir(), absolute).replaceAll('\\', '/');
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('[PROJECT_TRUST_SCOPE] pipeline path must be inside the repository root');
  }
  let current = pathResolver.rootDir();
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (safeLstat(current).isSymbolicLink()) {
        throw new Error(
          `[PROJECT_TRUST_SCOPE] pipeline path cannot traverse a symbolic link: ${relative}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[PROJECT_TRUST_SCOPE]')) {
        throw error;
      }
      // Missing paths are reported by contentHash with the canonical error.
    }
  }
  return { absolute, relative };
}

function contentHash(absolutePath: string): string {
  return createHash('sha256').update(readTrustedResource(absolutePath)).digest('hex');
}

function readTrustedResource(absolutePath: string): string {
  if (!safeExistsSync(absolutePath)) {
    throw new Error(`[PROJECT_TRUST_SCOPE] pipeline resource does not exist: ${absolutePath}`);
  }
  if (!safeLstat(absolutePath).isFile()) {
    throw new Error(
      `[PROJECT_TRUST_SCOPE] pipeline resource must be a regular file: ${absolutePath}`
    );
  }
  return String(readTextFile(absolutePath));
}

function hashContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface ApprovalCardText {
  title: string;
  summary: string;
  details: string;
  reason: string;
}

function hookCommandLines(raw: string, source: ExternalHookSource): string[] {
  try {
    const config = parseSafeJsonObjectInput(raw, 'external hook config') ?? {};
    return describeExternalHookCommands(config, source).map(
      (hook) => `- ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ''} → ${hook.command}`
    );
  } catch (error) {
    return [
      t('cli:cli_hooks_trust_card_unparsable', {
        reason: error instanceof Error ? error.message : String(error),
      }),
    ];
  }
}

/** What a v2 pipeline request shows: the manifest in plain language, hashes in one footer line. */
export interface ProjectTrustManifestCard {
  manifest: RunManifest;
  principalModes: RunPrincipalMode[];
  /** Daily run cap bound by the request (shown in plain language). */
  runsPerDay: number;
  /**
   * The steps of the exact file content being bound, so lines can name
   * selectors (never values). Parsed here from that content — never taken
   * from the caller, who could otherwise show other selectors than it binds.
   */
  steps?: readonly unknown[];
}

/** Steps of the trusted file content for the card; undefined when it is not a JSON pipeline. */
function cardStepsOf(raw: string): readonly unknown[] | undefined {
  try {
    const parsed = parseSafeJsonObjectInput(raw, 'pipeline file');
    return Array.isArray(parsed?.steps) ? parsed.steps : undefined;
  } catch {
    return undefined;
  }
}

function manifestCardText(
  relative: string,
  hash: string,
  card: ProjectTrustManifestCard
): ApprovalCardText {
  const { manifest, principalModes } = card;
  const effects = manifest.requirements.effects;
  const bindable = effects.filter((entry) => entry.bindable).length;
  const origins = [...new Set(effects.flatMap((entry) => entry.origins))].sort();
  const unattended = principalModes.includes('unattended');
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  return {
    title: `Approve project-local pipeline: ${relative}`,
    summary:
      `Runs ${plural(effects.length, 'external operation', 'external operations')} on ` +
      `${plural(origins.length, 'site', 'sites')}; ${bindable} run without asking again. ` +
      (unattended
        ? 'UNATTENDED RUNS ENABLED: workers may run it without you at the terminal.'
        : 'Only you, at the terminal, can run it under this approval.'),
    details: [
      `Path: ${relative}`,
      unattended
        ? 'Who may run it: you at the terminal, AND unattended workers without you'
        : 'Who may run it: you at the terminal only',
      `How often: at most ${plural(card.runsPerDay, 'run', 'runs')} per day (UTC); later runs that day ask step by step`,
      ...describeRunManifest(manifest, { steps: card.steps, hashFooter: false }),
      `Binding: content SHA-256 ${hash} · manifest SHA-256 ${manifest.manifest_hash}`,
    ].join('\n'),
    reason:
      'Project-local pipeline content and the external operations it performs require a durable human trust decision.',
  };
}

function approvalCardText(
  resource: ProjectTrustResource,
  relative: string,
  hash: string,
  raw: string,
  manifestCard?: ProjectTrustManifestCard
): ApprovalCardText {
  if (manifestCard && resource.kind === 'pipeline')
    return manifestCardText(relative, hash, manifestCard);
  const binding = `Path: ${relative}\nContent SHA-256: ${hash}`;
  if (resource.kind === 'external-hook-config') {
    const commands = hookCommandLines(raw, resource.source);
    return {
      title: t('cli:cli_hooks_trust_card_title', { path: relative }),
      summary: t('cli:cli_hooks_trust_card_summary', { count: commands.length }),
      details: [
        binding,
        `Source: ${resource.source}`,
        t('cli:cli_hooks_trust_card_commands_header'),
        ...(commands.length > 0 ? commands : [t('cli:cli_hooks_trust_card_no_commands')]),
      ].join('\n'),
      reason:
        'Project-local hook config registers shell commands that run on agent lifecycle events; it requires a durable human trust decision.',
    };
  }
  return {
    title: `Approve project-local pipeline: ${relative}`,
    summary:
      'A project-local pipeline can change executable behavior and remains blocked until an authenticated human approves this exact content.',
    details: binding,
    reason: 'Project-local executable pipeline content requires a durable human trust decision.',
  };
}

const effectBinding = projectTrustEffectBinding;

function isProjectTrustRequest(record: ApprovalRequestRecord, relativePath: string): boolean {
  return (
    record.storageChannel === PROJECT_TRUST_APPROVAL_CHANNEL &&
    record.requestedByContext?.actorRole === 'project-trust' &&
    record.accountability?.effectBinding === effectBinding(relativePath)
  );
}

/**
 * The v2 binding of one compiled manifest to the file it claims to describe.
 * A manifest compiled from other content, another path or edited after
 * compilation never reaches a human card.
 */
function manifestBindingFor(
  manifest: RunManifest,
  relative: string,
  hash: string,
  principalModes: readonly RunPrincipalMode[] | undefined,
  runsPerDay: number | undefined
): ProjectTrustManifestBinding {
  if (computeRunManifestHash(manifest) !== manifest.manifest_hash) {
    throw new Error(
      '[PROJECT_TRUST_MANIFEST] run manifest hash does not match its body — compiled manifest was altered | next: recompile it with compileRunManifest'
    );
  }
  if (manifest.source.input_path !== relative || manifest.source.content_sha256 !== hash) {
    throw new Error(
      `[PROJECT_TRUST_MANIFEST] run manifest was compiled from another file or content than ${relative} | next: recompile it from the current file with its repository-relative path`
    );
  }
  return {
    manifest_hash: manifest.manifest_hash,
    principal_modes: requestedPrincipalModes(principalModes),
    runs_per_day: requestedRunsPerDay(runsPerDay),
  };
}

/**
 * Runner entry point for a v2 trust request: same as
 * createProjectTrustApprovalRequest with the compiled manifest required.
 */
export function requestPipelineTrustWithManifest(params: {
  inputPath: string;
  manifest: RunManifest;
  principalModes?: readonly RunPrincipalMode[];
  runsPerDay?: number;
  requester?: ApprovalRequesterInput;
  requestedBy?: string;
}): ApprovalRequestRecord {
  return createProjectTrustApprovalRequest({ ...params, resource: { kind: 'pipeline' } });
}

/** Open or reuse the human approval request for one exact pipeline resource. */
export function createProjectTrustApprovalRequest(params: {
  inputPath: string;
  requestedBy?: string;
  /** The requester the entry point resolved (overrides `requestedBy`). */
  requester?: ApprovalRequesterInput;
  /** Defaults to a project-local pipeline. */
  resource?: ProjectTrustResource;
  /**
   * v2: the Run Manifest compiled from this exact file. The card then lists
   * the manifest in plain language and an approval can issue a run-manifest
   * charter. Omitted: a v1 (file-only) trust request.
   */
  manifest?: RunManifest;
  /** v2 only. Defaults to ['attended']; 'unattended' must be asked for explicitly. */
  principalModes?: readonly RunPrincipalMode[];
  /** v2 only. Daily run cap of the charter; defaults to DEFAULT_RUN_MANIFEST_RUNS_PER_DAY. */
  runsPerDay?: number;
}): ApprovalRequestRecord {
  const resolved = normalizeRelativePath(params.inputPath);
  if (isBuiltinPipelineResource(resolved.relative)) {
    throw new Error(
      `[PROJECT_TRUST_NOT_REQUIRED] canonical pipeline is repository-owned: ${resolved.relative}`
    );
  }
  const raw = readTrustedResource(resolved.absolute);
  const hash = hashContent(raw);
  if (params.manifest && params.resource && params.resource.kind !== 'pipeline') {
    throw new Error(
      '[PROJECT_TRUST_MANIFEST] a run manifest binds only a pipeline resource | next: omit the manifest for this resource'
    );
  }
  const manifestBinding = params.manifest
    ? manifestBindingFor(
        params.manifest,
        resolved.relative,
        hash,
        params.principalModes,
        params.runsPerDay
      )
    : undefined;
  if (!params.manifest && params.principalModes !== undefined) {
    throw new Error(
      '[PROJECT_TRUST_PRINCIPAL] principal modes need a run manifest | next: pass the compiled manifest with them'
    );
  }
  if (!params.manifest && params.runsPerDay !== undefined) {
    throw new Error(
      '[PROJECT_TRUST_RUN_LIMIT] a daily run cap needs a run manifest | next: pass the compiled manifest with it'
    );
  }
  const payload = manifestBinding
    ? projectTrustBindingPayloadV2(resolved.relative, hash, manifestBinding)
    : projectTrustBindingPayloadV1(resolved.relative, hash);
  const payloadHash = computeApprovalPayloadHash(payload);
  const binding = effectBinding(resolved.relative);
  const card = approvalCardText(
    params.resource ?? { kind: 'pipeline' },
    resolved.relative,
    hash,
    raw,
    params.manifest && manifestBinding
      ? {
          manifest: params.manifest,
          principalModes: manifestBinding.principal_modes,
          runsPerDay: manifestBinding.runs_per_day ?? requestedRunsPerDay(undefined),
          // Selector names come from the bytes the manifest hash binds.
          steps: cardStepsOf(raw),
        }
      : undefined
  );
  const existing = listApprovalRequests({
    storageChannels: [PROJECT_TRUST_APPROVAL_CHANNEL],
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      isProjectTrustRequest(record, resolved.relative) &&
      record.accountability?.payloadHash === payloadHash &&
      // Separation of duties: never hand back an approved record that cannot be used.
      (record.status !== 'approved' || !evaluateApprovalUsability(record))
  );
  if (existing && !isApprovalRequestExpired(existing)) return existing;

  const requester: ApprovalRequesterRef = params.requester
    ? resolveApprovalRequesterInput(params.requester)
    : { requestedBy: params.requestedBy?.trim() || 'project-trust-cli' };
  const requestedBy = requester.requestedBy;
  return createApprovalRequest('mission_controller', {
    channel: PROJECT_TRUST_APPROVAL_CHANNEL,
    storageChannel: PROJECT_TRUST_APPROVAL_CHANNEL,
    threadTs: binding,
    correlationId: binding,
    requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    kind: 'channel-approval',
    draft: {
      title: card.title,
      summary: card.summary,
      details: card.details,
      severity: 'high',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'project-trust',
    },
    justification: {
      reason: card.reason,
      requestedEffects: projectTrustRequestedEffects(resolved.relative, manifestBinding),
    },
    risk: { level: 'high', restartScope: 'none', requiresStrongAuth: true },
    accountability: {
      finalDecision: 'human_only',
      min_assurance: PROJECT_TRUST_MIN_ASSURANCE,
      payloadHash,
      effectBinding: binding,
    },
  });
}

/**
 * Verify an approved request before loading the resource. The hash check
 * prevents approval from surviving edits to the project-local pipeline.
 */
export function assertProjectTrustApproval(requestId: string, inputPath: string): void {
  const resolved = normalizeRelativePath(inputPath);
  if (isBuiltinPipelineResource(resolved.relative)) return;
  const record = loadApprovalRequest(PROJECT_TRUST_APPROVAL_CHANNEL, requestId);
  if (!record || !isProjectTrustRequest(record, resolved.relative)) {
    throw new Error(
      `[TRUST_REQUIRED] approved project-trust request not found for ${resolved.relative}`
    );
  }
  if (record.status !== 'approved') {
    throw new Error(
      `[TRUST_REQUIRED] project-trust request ${record.id} is ${record.status}, not approved`
    );
  }
  if (isApprovalRequestExpired(record)) {
    throw new Error(`[TRUST_REQUIRED] project-trust request ${record.id} has expired`);
  }
  if (
    record.accountability?.finalDecision !== 'human_only' ||
    record.decidedByType !== 'human' ||
    record.authenticated !== true ||
    (record.decidedAuthMethod && NON_HUMAN_PROOF_AUTH_METHODS.has(record.decidedAuthMethod))
  ) {
    throw new Error(
      `[TRUST_REQUIRED] project-trust request ${record.id} lacks an authenticated human decision`
    );
  }
  assertApprovalUsable(record, { consumer: 'project_trust' });
  const hash = contentHash(resolved.absolute);
  // v1 and v2 records are both valid trust for this exact content; the binding
  // the record declares is recomputed from the current file, never read back.
  const expectedPayloadHash = expectedProjectTrustPayloadHash(record, resolved.relative, hash);
  if (!expectedPayloadHash || record.accountability.payloadHash !== expectedPayloadHash) {
    throw new Error(
      `[TRUST_REQUIRED] project-local pipeline changed after approval: ${resolved.relative}`
    );
  }
}

/**
 * Newest approved project-trust request that is valid for the CURRENT content
 * of this exact resource, or null. Unattended runners (chronos tenant
 * schedules) use this to find the human decision they must present; every
 * candidate is re-verified through assertProjectTrustApproval, so an edited
 * file, an expired or non-human decision never yields an id.
 */
export function findValidProjectTrustApproval(inputPath: string): string | null {
  const resolved = normalizeRelativePath(inputPath);
  if (isBuiltinPipelineResource(resolved.relative)) return null;
  const candidates = listApprovalRequests({
    storageChannels: [PROJECT_TRUST_APPROVAL_CHANNEL],
    status: 'approved',
  })
    .filter((record) => isProjectTrustRequest(record, resolved.relative))
    .sort((a, b) =>
      String(b.decidedAt ?? b.requestedAt) < String(a.decidedAt ?? a.requestedAt) ? -1 : 1
    );
  for (const record of candidates) {
    try {
      assertProjectTrustApproval(record.id, resolved.relative);
      return record.id;
    } catch {
      // Stale (content changed), expired or not a human decision — keep looking.
    }
  }
  return null;
}

/**
 * Newest approved v2 project-trust request valid for the CURRENT content and
 * bound to exactly this manifest hash, or null. The runner passes its id to
 * ensureRunManifestCharter; a v1 record never matches.
 */
export function findValidRunManifestTrustApproval(
  inputPath: string,
  manifestHash: string
): string | null {
  const resolved = normalizeRelativePath(inputPath);
  if (isBuiltinPipelineResource(resolved.relative)) return null;
  const candidates = listApprovalRequests({
    storageChannels: [PROJECT_TRUST_APPROVAL_CHANNEL],
    status: 'approved',
  })
    .filter((record) => {
      if (!isProjectTrustRequest(record, resolved.relative)) return false;
      const binding = projectTrustBindingOf(record);
      return binding.version === 2 && binding.manifest_hash === manifestHash;
    })
    .sort((a, b) =>
      String(b.decidedAt ?? b.requestedAt) < String(a.decidedAt ?? a.requestedAt) ? -1 : 1
    );
  for (const record of candidates) {
    try {
      assertProjectTrustApproval(record.id, resolved.relative);
      return record.id;
    } catch {
      // Stale, expired, unusable or not a human decision — keep looking.
    }
  }
  return null;
}

// --- Charter delegation -----------------------------------------------------
// An accountability charter that names `pipeline_trust_grant` in
// `envelope.delegated_decisions` can stand in for the human approval. The
// envelope delegates the *type* of decision (the human already bounded it by
// accepting the charter); the content binding lives in the correlation id —
// a fresh content hash means a fresh delegated decision, never a reused one.

export { PIPELINE_TRUST_GRANT_DECISION_TYPE };

/** `--delegated-trust` scope spelling: `person` (default) or `tenant:<slug>`. */
export function parseDelegatedTrustScope(value: unknown): CharterScope {
  const raw =
    value === true || value === '' || value === undefined ? 'person' : String(value).trim();
  if (raw === 'person') return { kind: 'person' };
  const tenant = raw.startsWith('tenant:') ? raw.slice('tenant:'.length).trim() : '';
  if (tenant) return { kind: 'organization', tenant_slug: tenant };
  throw new Error(
    `[DELEGATED_TRUST_SCOPE] --delegated-trust takes 'person' or 'tenant:<slug>' (got '${raw}')`
  );
}

export type ProjectTrustDelegation =
  { delegated: true; charterId: string; message: string } | { delegated: false; reason: string };

/**
 * Ask the accountability charter whether it delegates the trust grant for
 * this exact pipeline resource. Reads the file once — the content hash goes
 * into the correlation id so an edited file is a new delegated decision and
 * re-runs of unchanged content do not double-charge the ledger.
 */
export function evaluateProjectTrustDelegation(args: {
  inputPath: string;
  scope: CharterScope;
  /** Agent identity acting on the operator's behalf (e.g. 'pipeline-cli'). */
  agentId?: string;
  now?: Date;
  pathOptions?: CharterPathOptions;
}): ProjectTrustDelegation {
  const resolved = normalizeRelativePath(args.inputPath);
  if (isBuiltinPipelineResource(resolved.relative)) {
    return { delegated: false, reason: 'repository-owned pipeline needs no trust decision' };
  }
  const hash = contentHash(resolved.absolute);
  let outcome: ReturnType<typeof runCharterGate>;
  try {
    const charter = charterInputForPipelineTrust(
      { scope: args.scope, agentId: args.agentId },
      args.pathOptions ?? {},
      args.now ?? new Date()
    );
    if (!charter) {
      return {
        delegated: false,
        reason: `no active charter for this scope, or '${PIPELINE_TRUST_GRANT_DECISION_TYPE}' is not in the charter decision vocabulary`,
      };
    }
    outcome = runCharterGate({
      charter,
      agentId: args.agentId ?? 'pipeline-cli',
      operationId: `project-trust:${resolved.relative}`,
      correlationId: `project-trust:${resolved.relative}:${hash.slice(0, 16)}`,
      now: args.now,
    });
  } catch (error) {
    // Scope-denied or unreadable charter state means "no delegation here" —
    // fail closed: the caller falls back to the human approval path.
    return {
      delegated: false,
      reason: `charter evaluation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (outcome.kind === 'allow') {
    return {
      delegated: true,
      charterId: outcome.acceptedCharter!.charter_id,
      message: outcome.message,
    };
  }
  if (outcome.kind === 'stop') {
    return { delegated: false, reason: outcome.message };
  }
  return {
    delegated: false,
    reason:
      outcome.kind === 'require_approval'
        ? outcome.reason
        : 'no accountability charter covers this decision',
  };
}
