/**
 * Run Manifest at the runner boundary (pipeline-run-manifest-model.md §3.3,
 * §6 P2b): compile the manifest of the exact file being run or trusted, open
 * a v2 trust request for it, and decide at run start whether the run executes
 * under a manifest-bound charter.
 *
 * Nothing here weakens a gate. A missing approval, a changed file, an
 * unissuable charter or a resumed run simply leaves the run unbound: every
 * external step then asks for its own approval exactly as before.
 */
import { createHash } from 'node:crypto';
import { readTextFile } from '../foundation/text.js';
import { isRecord } from '../foundation/primitives.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import {
  ensureRunManifestCharter,
  type EnsureRunManifestCharterInput,
} from '../governance/run-manifest-charter.js';
import type { RunManifestBindingInput } from '../governance/run-manifest-binding.js';
import { withRunManifestGateStore } from '../governance/run-manifest-gate-runtime.js';
import {
  recordRunManifestRunStarted,
  type IssuedRunManifestCharter,
  type RunManifestRunStart,
} from '../governance/accountability-charter-registry.js';
import type { Charter } from '../governance/accountability-charter.js';
import type { ApprovalRequesterInput } from '../governance/approval-requester.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { DEFAULT_RUN_PRINCIPAL_MODES } from '../governance/run-manifest-grant.js';
import {
  createProjectTrustApprovalRequest,
  findValidRunManifestTrustApproval,
  requestPipelineTrustWithManifest,
} from '../project/project-trust.js';
import * as pathResolver from '../path-resolver.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import { compileRunManifest, type RunManifest } from './run-manifest.js';
import {
  BROWSER_NATIVE_FORMAT,
  isNativeBrowserPipelineDocument,
  type RunManifestSourceFormat,
} from './run-manifest-native.js';
import {
  principalForAccountable,
  resolveRunPrincipal,
  type RunPrincipal,
  type RunPrincipalMode,
} from './run-principal.js';
import { deriveRunScope, type RunScope } from './run-scope.js';

/** The part of a RunScope the manifest needs. */
export type RunManifestFileScope = Pick<RunScope, 'input_path' | 'tier' | 'tenant_slug'>;

/** The loaded pipeline fields the manifest reads. */
export interface RunManifestPipelineSource {
  steps?: unknown;
  /** The browser session the pipeline runs under (its implicit persistent profile). */
  session_id?: unknown;
  context?: unknown;
  options?: unknown;
}

/**
 * Compile the manifest of the exact bytes being run: repo-relative path and
 * tier/tenant from the location-derived scope, sha256 of the source text, the
 * steps, static `context` block and `options` of the validated pipeline.
 */
export function compilePipelineFileRunManifest(input: {
  scope: RunManifestFileScope;
  sourceText: string;
  pipeline: RunManifestPipelineSource;
  /** `browser_native` for a browser actuator native pipeline (run-manifest-native.ts). */
  format?: RunManifestSourceFormat;
}): RunManifest {
  return compileRunManifest(Array.isArray(input.pipeline.steps) ? input.pipeline.steps : [], {
    inputPath: input.scope.input_path,
    contentSha256: createHash('sha256').update(input.sourceText).digest('hex'),
    scope: {
      tier: input.scope.tier,
      ...(input.scope.tenant_slug ? { tenantSlug: input.scope.tenant_slug } : {}),
    },
    ...(isRecord(input.pipeline.context) ? { context: input.pipeline.context } : {}),
    ...(isRecord(input.pipeline.options) ? { pipelineOptions: input.pipeline.options } : {}),
    ...(typeof input.pipeline.session_id === 'string' && input.pipeline.session_id
      ? { sessionId: input.pipeline.session_id }
      : {}),
    ...(input.format ? { format: input.format } : {}),
  });
}

const WORKFLOW_MODULE = /\.(ts|js|mjs|cjs)$/u;

/**
 * Read, validate and compile one JSON pipeline file. Static only: never
 * executes, never reads a secret value. Throws a diagnostic when the file is
 * a workflow module, not a valid pipeline, or has no derivable run scope.
 */
export function loadPipelineFileRunManifest(
  inputPath: string,
  deps: { deriveScope?: (inputPath: string) => RunScope } = {}
): { manifest: RunManifest; steps: unknown[]; scope: RunScope } {
  if (WORKFLOW_MODULE.test(inputPath))
    throw new Error(
      `[RUN_MANIFEST_UNAVAILABLE] ${inputPath} is a workflow module — only a JSON pipeline has a static manifest | next: request file-only trust for it`
    );
  const scope = (deps.deriveScope ?? deriveRunScope)(inputPath);
  const sourceText = String(readTextFile(pathResolver.rootResolve(inputPath)));
  let parsed: unknown;
  try {
    // Same parse the runner applies to the snapshot it executes.
    parsed = parseSafeJsonInput(sourceText, 'pipeline file');
  } catch (error) {
    throw new Error(
      `[RUN_MANIFEST_UNAVAILABLE] ${scope.input_path} cannot be parsed — ${error instanceof Error ? error.message : String(error)} | next: fix the pipeline file`
    );
  }
  // A native browser pipeline is not an ADF: its runner (the browser
  // actuator) reads it as authored, so its manifest is compiled as authored.
  if (isNativeBrowserPipelineDocument(parsed)) {
    const native = parsed as RunManifestPipelineSource & { steps: unknown[] };
    return {
      manifest: compilePipelineFileRunManifest({
        scope,
        sourceText,
        pipeline: native,
        format: BROWSER_NATIVE_FORMAT,
      }),
      steps: native.steps,
      scope,
    };
  }
  const pipeline = validatePipelineAdf(parsed);
  return {
    manifest: compilePipelineFileRunManifest({ scope, sourceText, pipeline }),
    steps: (pipeline.steps ?? []) as unknown[],
    scope,
  };
}

export interface PipelineFileTrustRequest {
  record: ApprovalRequestRecord;
  /** The manifest the request binds (v2); absent for a file-only (v1) request. */
  manifest?: RunManifest;
  /** Why the request fell back to file-only trust. */
  fileOnlyReason?: string;
}

/**
 * Open (or reuse) the human trust request for a pipeline file. A JSON
 * pipeline gets a v2 request carrying its Run Manifest; a file without a
 * static manifest (workflow module, invalid JSON) falls back to v1 unless the
 * caller asked for unattended runs, which only a manifest can carry.
 */
export function requestPipelineFileTrust(params: {
  inputPath: string;
  /** Adds 'unattended' to the approved principal modes (default: attended only). */
  allowUnattended?: boolean;
  /** Daily run cap the approver binds (default DEFAULT_RUN_MANIFEST_RUNS_PER_DAY). */
  runsPerDay?: number;
  requester?: ApprovalRequesterInput;
  requestedBy?: string;
  deps?: {
    deriveScope?: (inputPath: string) => RunScope;
    createRequest?: (
      input: Parameters<typeof requestPipelineTrustWithManifest>[0]
    ) => ApprovalRequestRecord;
    createFileOnlyRequest?: (input: {
      inputPath: string;
      requester?: ApprovalRequesterInput;
      requestedBy?: string;
    }) => ApprovalRequestRecord;
  };
}): PipelineFileTrustRequest {
  const principalModes: RunPrincipalMode[] = params.allowUnattended
    ? ['attended', 'unattended']
    : [...DEFAULT_RUN_PRINCIPAL_MODES];
  const who = {
    ...(params.requester ? { requester: params.requester } : {}),
    ...(params.requestedBy ? { requestedBy: params.requestedBy } : {}),
  };
  let loaded: ReturnType<typeof loadPipelineFileRunManifest>;
  try {
    loaded = loadPipelineFileRunManifest(params.inputPath, {
      deriveScope: params.deps?.deriveScope,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (params.allowUnattended)
      throw new Error(
        `[PROJECT_TRUST_PRINCIPAL] unattended runs need a run manifest — ${reason} | next: request without --allow-unattended`
      );
    if (params.runsPerDay !== undefined)
      throw new Error(
        `[PROJECT_TRUST_RUN_LIMIT] a daily run cap needs a run manifest — ${reason} | next: request without --runs-per-day`
      );
    // A file the runner cannot snapshot statically keeps today's v1 trust.
    return {
      record: (params.deps?.createFileOnlyRequest ?? createProjectTrustApprovalRequest)({
        inputPath: params.inputPath,
        ...who,
      }),
      fileOnlyReason: reason,
    };
  }
  const record = (params.deps?.createRequest ?? requestPipelineTrustWithManifest)({
    inputPath: loaded.scope.input_path,
    manifest: loaded.manifest,
    principalModes,
    ...(params.runsPerDay !== undefined ? { runsPerDay: params.runsPerDay } : {}),
    ...who,
  });
  return { record, manifest: loaded.manifest };
}

// ---------------------------------------------------------------------------
// Run start
// ---------------------------------------------------------------------------

export interface RunManifestSessionInput {
  scope: RunManifestFileScope;
  /** Exact JSON text the runner loaded; absent for workflow modules. */
  sourceText?: string;
  pipeline: RunManifestPipelineSource;
  /** The runner's terminal presence (resolvePipelineHumanPresence / options.hasHuman). */
  hasHuman: boolean | undefined;
  runId: string;
  /** A `--resume` / journal continuation: bindings never span processes (§8). */
  resumed?: boolean;
  /** `browser_native` when the browser actuator runs a native pipeline file (§3.5). */
  format?: RunManifestSourceFormat;
}

export interface RunManifestSessionDeps {
  resolvePrincipal?: (input: { hasHuman: boolean | undefined }) => RunPrincipal;
  findApproval?: (inputPath: string, manifestHash: string) => string | null;
  ensureCharter?: (input: EnsureRunManifestCharterInput) => IssuedRunManifestCharter;
  /**
   * Ledger entry for each bound run and the daily cap check (default:
   * recordRunManifestRunStarted). `recorded: false` leaves the run unbound.
   */
  recordRunStart?: (
    charter: Charter,
    run: { run_id: string; principal_mode: string }
  ) => RunManifestRunStart | void;
}

export interface RunManifestSession {
  /** Install with withRunManifestBinding when present. */
  binding?: RunManifestBindingInput;
  manifest?: RunManifest;
  principal?: RunPrincipal;
  /**
   * True only when the binding will admit steps: the run principal is in the
   * charter's approved modes and the run was recorded (`run_started`, daily
   * cap passed). A binding without it pre-approves nothing.
   */
  admitting?: boolean;
  /**
   * Present only on an admitting session of a tenant file: run `body` (inside
   * this session's `withRunManifestBinding`) with the gate store of this run —
   * the external-operation gate then reads this tenant's charters and the bound
   * manifest's ledger, and records the run's ledger entries, reservations and
   * review artifacts, through one exact grant per access
   * (governance/run-manifest-gate-store.ts). A runner that dispatches under a
   * narrow identity (`surface_runtime`) uses it instead of the caller's
   * identity (§3.5).
   */
  withGateStore?: <T>(body: () => T) => T;
  /** One operator line: what the binding covers, or why the run is unbound. */
  message: string;
  /** `debug` when pre-approval cannot apply to this kind of run at all. */
  level: 'debug' | 'info' | 'warn';
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Decide the run's manifest binding at run start. Never throws: every failure
 * becomes an unbound run with the reason (and the next command) in `message`.
 */
export function openRunManifestSession(
  input: RunManifestSessionInput,
  deps: RunManifestSessionDeps = {}
): RunManifestSession {
  const rel = input.scope.input_path;
  const unbound = (why: string, level: RunManifestSession['level'] = 'info', extra = {}) => ({
    message: `run manifest: not bound — ${why}; every external step asks for its own approval`,
    level,
    ...extra,
  });
  if (input.resumed)
    return unbound(
      'resumed run (occurrence bounds are counted per process, so a resumed run never reuses them)'
    );
  if (input.sourceText === undefined)
    return unbound('workflow modules have no static manifest', 'debug');
  if (!input.scope.tenant_slug)
    return unbound('the pipeline has no tenant scope (pre-approval is per tenant)', 'debug');
  let manifest: RunManifest;
  try {
    manifest = compilePipelineFileRunManifest({
      scope: input.scope,
      sourceText: input.sourceText,
      pipeline: input.pipeline,
      ...(input.format ? { format: input.format } : {}),
    });
  } catch (error) {
    return unbound(
      `the manifest could not be compiled — ${error instanceof Error ? error.message : String(error)} | next: pnpm pipeline check ${rel}`,
      'warn'
    );
  }
  const external = manifest.requirements.effects.length;
  if (external === 0)
    return { manifest, message: 'run manifest: no external steps to pre-approve', level: 'debug' };
  let terminalPrincipal: RunPrincipal;
  try {
    terminalPrincipal = (deps.resolvePrincipal ?? resolveRunPrincipal)({
      hasHuman: input.hasHuman,
    });
  } catch (error) {
    return unbound(
      `the run principal could not be resolved — ${error instanceof Error ? error.message : String(error)} | next: pnpm pipeline check ${rel}`,
      'warn',
      { manifest }
    );
  }
  let principal = terminalPrincipal;
  let approvalId: string | null;
  try {
    approvalId = (deps.findApproval ?? findValidRunManifestTrustApproval)(
      rel,
      manifest.manifest_hash
    );
  } catch (error) {
    return unbound(
      `trust approvals could not be read — ${error instanceof Error ? error.message : String(error)}`,
      'warn',
      { manifest, principal }
    );
  }
  if (!approvalId)
    return unbound(
      `0/${external} external steps pre-approved (no approved manifest ${shortHash(manifest.manifest_hash)} for the current content) | next: pnpm kyberion project-trust request ${rel}`,
      'info',
      { manifest, principal }
    );
  let issued: IssuedRunManifestCharter;
  try {
    issued = (deps.ensureCharter ?? ensureRunManifestCharter)({
      approvalRequestId: approvalId,
      manifest,
    });
  } catch (error) {
    return unbound(
      `run-manifest charter not issued for approval ${approvalId} — ${error instanceof Error ? error.message : String(error)} | next: pnpm pipeline check ${rel}`,
      'warn',
      { manifest, principal }
    );
  }
  const charter = issued.charter;
  // Attended means the approving owner (or a deputy) is at the terminal —
  // not any active member, and never an agent-driven process.
  try {
    principal = principalForAccountable(terminalPrincipal, charter.accountable);
  } catch (error) {
    return unbound(
      `the run principal could not be matched to charter ${charter.charter_id} — ${error instanceof Error ? error.message : String(error)} | next: pnpm pipeline check ${rel}`,
      'warn',
      { manifest, principal }
    );
  }
  const bindable = manifest.requirements.effects.filter((entry) => entry.bindable).length;
  const modes = (charter.envelope.principal_modes ??
    DEFAULT_RUN_PRINCIPAL_MODES) as readonly string[];
  if (modes.includes(principal.mode)) {
    // Every bound run is on the charter ledger; without that audit entry the
    // run gets no pre-approval.
    let started: RunManifestRunStart | void;
    try {
      started = (deps.recordRunStart ?? recordRunManifestRunStarted)(charter, {
        run_id: input.runId,
        principal_mode: principal.mode,
      });
    } catch (error) {
      return unbound(
        `the run could not be recorded on charter ${charter.charter_id} — ${error instanceof Error ? error.message : String(error)}`,
        'warn',
        { manifest, principal }
      );
    }
    if (started && !started.recorded)
      return unbound(
        `daily run cap reached (${started.runs_today}/${started.runs_per_day} today, UTC ${started.day}) | next: run again after 00:00 UTC, or re-approve with a higher cap: pnpm kyberion project-trust request ${rel} --runs-per-day <N>`,
        'warn',
        { manifest, principal }
      );
  }
  const principalNote = modes.includes(principal.mode)
    ? `principal ${principal.mode}`
    : `principal ${principal.mode} (${principal.reason}) is NOT approved (approved: ${modes.join(', ')}) — every external step will ask`;
  return {
    binding: {
      manifest,
      charterId: charter.charter_id,
      principal: principal.mode,
      runId: input.runId,
    },
    manifest,
    principal,
    admitting: modes.includes(principal.mode),
    ...(modes.includes(principal.mode) && input.scope.tenant_slug
      ? {
          withGateStore: <T>(body: () => T): T =>
            withRunManifestGateStore(
              {
                tenantSlug: input.scope.tenant_slug!,
                runId: input.runId,
                manifestHash: manifest.manifest_hash,
              },
              body
            ),
        }
      : {}),
    message: `run manifest: ${modes.includes(principal.mode) ? bindable : 0}/${external} external steps pre-approved (charter ${charter.charter_id}, ${principalNote})`,
    level: modes.includes(principal.mode) ? 'info' : 'warn',
  };
}
