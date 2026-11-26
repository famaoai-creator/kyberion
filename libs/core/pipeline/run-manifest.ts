/**
 * Run Manifest compiler — static, side-effect-free analysis of one pipeline
 * definition into the single object a human approves and the runtime gates
 * later compare against (pipeline-run-manifest-model.md §3).
 *
 * The manifest answers "what does this exact file need before it runs":
 * whether it calls a model, which secret references it reads, and every
 * external effect that needs admission — with the authored params hash, the
 * static navigation target, the page origins and an occurrence bound for each.
 * Anything the compiler cannot bound statically (templated host, unbounded
 * loop, hidden sub-pipeline) is marked unbindable and stays on per-step
 * approval; nothing here weakens the per-effect gate.
 */
import { createHash } from 'node:crypto';
import { isRecord } from '../foundation/primitives.js';
import {
  browserOperationRequiresAdmission,
  operationAuthorization,
  requiresApprovalAdmission,
  isManifestBindableOperation,
} from '../foundation/authorization-registry.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { determineActuatorStepType } from '../actuator/actuator-op-registry.js';
import {
  pipelineBootstrapNeeds,
  type PipelineBootstrapStep,
} from '../reasoning/pipeline-bootstrap-needs.js';
import { normalizePipelineOp } from './pipeline-op-aliases.js';
import { canonicalActuatorAction } from './pipeline-op-aliases.js';
import { classifyPipelineBrowserOptions, pipelineUsesBrowser } from './pipeline-browser-options.js';
import {
  hasTemplate,
  pipelineTemplateMatches,
  scanPipelineTemplate,
  tokenRootVariable,
} from './pipeline-template.js';
import {
  BROWSER_NATIVE_FORMAT,
  NATIVE_WRITE_FILE_OPERATION,
  nativeBrowserManifestSteps,
  nativeWritePath,
  type RunManifestSourceFormat,
} from './run-manifest-native.js';

export { pipelineTemplateMatches, scanPipelineTemplate };

export const RUN_MANIFEST_VERSION = 1 as const;

export type ManifestTarget =
  { kind: 'url'; url: string } | { kind: 'origin_path'; origin: string; path_prefix: string };

export type ManifestArgumentOrigin = 'static' | 'step_output' | `secret:${string}`;

export type ManifestUnbindableReason =
  | 'templated_host'
  | 'invalid_url'
  | 'unbounded_loop'
  | 'templated_script'
  | 'no_static_origin'
  | 'ref_dispatch'
  | 'not_manifest_bindable'
  | 'unknown_operation'
  | 'script_not_presentable'
  | 'secret_origin_unknown'
  | 'unsafe_secret_selector'
  | 'judge_routed'
  | 'credential_in_url'
  | 'write_path_unconfined';

/** Longest page script the approval card can show in full enough to judge. */
export const MAX_PRESENTABLE_SCRIPT_CHARS = 2000;
/** Characters of each script shown on the card (whitespace collapsed). */
export const SCRIPT_EXCERPT_CHARS = 200;

/** What the card shows of one page script; part of the manifest hash. */
export interface ManifestScript {
  /** sha256 of the exact authored script text. */
  sha256: string;
  length: number;
  /** First SCRIPT_EXCERPT_CHARS characters, whitespace collapsed. */
  excerpt: string;
}

export interface EffectManifestEntry {
  /** Stable step path, e.g. "3" or "3.pipeline.1" or "2.on_error.fallback.0". */
  entry_id: string;
  /** Operation id the runtime admits (e.g. `browser:goto`; `navigate` folds into goto). */
  operation_id: string;
  admission: 'approval' | 'none';
  /** Navigation ops only: where the step may go. */
  target?: ManifestTarget;
  /** Origins the step may act on (navigation: its target origin; page ops: the manifest's origins). */
  origins: string[];
  /** Leaf param path → where its value comes from. */
  argument_origins: Record<string, ManifestArgumentOrigin>;
  /** computeApprovalPayloadHash over the runtime-shaped authored (unresolved) params. */
  params_template_hash: string;
  /** Upper bound of executions in one run; null when it cannot be bounded statically. */
  max_occurrences: number | null;
  /** Page-script ops (`browser:evaluate`, `browser:cdp`): the script the card shows. */
  script?: ManifestScript;
  /**
   * Secret reference → the one origin its value may reach: the origin of the
   * nearest preceding static navigation in the same body (or inherited from
   * the enclosing body). Never "every manifest origin".
   */
  secret_origins?: Record<string, string[]>;
  /**
   * `browser:write_file` (native runs): the file the step writes outside the
   * run's partition, and the confined path that would make it pre-approvable.
   */
  write?: { path: string; suggested_path: string };
  bindable: boolean;
  unbindable_reason?: ManifestUnbindableReason;
}

export interface RunManifestSecret {
  service: string;
  account?: string;
  export_as: string;
}

export interface RunManifestScope {
  tier: string;
  tenant_slug?: string;
}

export interface RunManifest {
  version: typeof RUN_MANIFEST_VERSION;
  scope: RunManifestScope;
  /**
   * The exact file the manifest was compiled from; part of manifest_hash.
   * `format: 'browser_native'` marks a browser actuator native pipeline (its
   * runner is the browser actuator); absent for a pipeline ADF.
   */
  source: { input_path: string; content_sha256: string; format?: RunManifestSourceFormat };
  /** False when a step hides effects from static analysis (ref / include / run_pipeline / hooks). */
  complete: boolean;
  incomplete_reasons: string[];
  requirements: {
    model: boolean;
    secrets: RunManifestSecret[];
    effects: EffectManifestEntry[];
    /**
     * Present only when the pipeline's own `options.navigation_policy`
     * loosens the browser's default navigation fence for every step.
     */
    browser_navigation?: { allow_private_network?: true; allow_data_url?: true };
    /** Present only when the pipeline's options give its browser a persistent profile. */
    /**
     * The persistent profile the run uses: the declared `user_data_dir`, or
     * the session's implicit one (`session_id` set) inside the run partition.
     */
    browser_profile?: { user_data_dir: string; session_id?: string };
    /** Present only when the pipeline's options record the browser session on video. */
    browser_recording?: { video_artifact_dir: string };
  };
  /** sha256 of the canonical JSON of every field above. */
  manifest_hash: string;
}

export interface CompileRunManifestOptions {
  inputPath: string;
  contentSha256: string;
  scope: { tier: string; tenantSlug?: string };
  /** The pipeline file's static `context` block; resolves navigation targets only. */
  context?: Record<string, unknown>;
  /** The pipeline file's `options` block; every browser step runs under it. */
  pipelineOptions?: Record<string, unknown>;
  /** The pipeline file's browser `session_id` (`default` when unset). */
  sessionId?: string;
  /**
   * `browser_native`: the steps are a browser actuator native pipeline (bare
   * ops dispatched by their authored `type`, run-manifest-native.ts).
   */
  format?: RunManifestSourceFormat;
}

// ---------------------------------------------------------------------------
// Step walking
// ---------------------------------------------------------------------------

interface ManifestStep {
  op: string;
  type?: string;
  role?: string;
  produces?: unknown;
  params?: Record<string, unknown>;
  on_error?: { fallback?: unknown; ref?: unknown };
  hooks?: unknown;
}

/** A body's steps by RAW array index: a malformed entry stays a hole, never renumbering the rest. */
type ManifestBody = Array<ManifestStep | undefined>;

/**
 * The steps of a body, positioned by their raw array index. Runners number
 * entries by the raw index (`prepareEngineSteps`, the browser actuator's
 * native tagging), so a malformed entry (not a record, no `op`) is kept as a
 * hole instead of shifting every later entry id.
 */
function asManifestSteps(value: unknown): ManifestBody | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) =>
    isRecord(entry) && typeof entry.op === 'string' ? (entry as unknown as ManifestStep) : undefined
  );
}

function presentSteps(body: ManifestBody): ManifestStep[] {
  return body.filter((step): step is ManifestStep => step !== undefined);
}

/** Mirrors the runtime's coercePositiveInt(value, fallback). */
function coercePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function multiply(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a * b;
}

function staticArrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

interface NestedBody {
  key: string;
  steps: ManifestBody;
  /** Multiplier applied to the body relative to the parent step's own count. */
  repeat: number | null;
  /** Bodies dispatched inside the browser actuator: bare ops are browser ops. */
  browserBody?: boolean;
}

const LOOP_OPS = new Set(['core:while', 'core:loop_until', 'core:retry_until_quality']);
const HIDDEN_EFFECT_OPS = new Set([
  'core:include',
  'core:run_pipeline',
  'system:ref',
  'browser:ref',
]);

function nestedBodies(op: string, params: Record<string, unknown>): NestedBody[] {
  const bodies: NestedBody[] = [];
  const push = (key: string, value: unknown, repeat: number | null, browserBody?: boolean) => {
    const steps = asManifestSteps(value);
    if (steps) bodies.push({ key, steps, repeat, ...(browserBody ? { browserBody } : {}) });
  };
  if (LOOP_OPS.has(op)) {
    // Runtime: coercePositiveInt(params.max_iterations ?? params.maxIterations, 1) on the raw param.
    push(
      'pipeline',
      params.pipeline,
      coercePositiveInt(params.max_iterations ?? params.maxIterations, 1)
    );
    return bodies;
  }
  if (op === 'core:foreach') {
    push('do', params.do, staticArrayLength(params.items));
    return bodies;
  }
  if (op === 'core:parallel_foreach') {
    push('do', params.do, isRecord(params.items_from) ? null : staticArrayLength(params.items));
    return bodies;
  }
  if (op === 'core:accumulate') {
    const items = staticArrayLength(params.items);
    push(
      'do',
      params.do,
      items === null
        ? null
        : Math.min(items, coercePositiveInt(params.max_iterations ?? params.maxIterations, items))
    );
    return bodies;
  }
  if (op === 'core:team_lead') {
    const tasks = staticArrayLength(params.tasks) ?? staticArrayLength(params.fixture_tasks);
    push('do', params.do, tasks);
    return bodies;
  }
  if (op === 'browser:while') {
    // Browser-internal loop: number >= 0 bounds it, anything else runs up to 100.
    const max =
      typeof params.max_iterations === 'number' && params.max_iterations >= 0
        ? Math.floor(params.max_iterations)
        : 100;
    push('pipeline', params.pipeline, max, true);
    return bodies;
  }
  if (op === 'browser:if') {
    push('then', params.then, 1, true);
    push('else', params.else, 1, true);
    return bodies;
  }
  // if / switch / parallel_calls / anything else with nested step lists: each body once.
  for (const key of ['then', 'else', 'default', 'pipeline', 'steps', 'calls', 'do']) {
    push(key, params[key], 1);
  }
  if (Array.isArray(params.cases)) {
    params.cases.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      for (const key of ['steps', 'then', 'pipeline', 'do']) {
        push(`cases.${index}.${key}`, entry[key], 1);
      }
    });
  }
  return bodies;
}

function exportKeyOf(step: ManifestStep): string | undefined {
  const params = step.params ?? {};
  if (typeof params.export_as === 'string' && params.export_as.trim())
    return params.export_as.trim();
  if (typeof step.produces === 'string') return step.produces;
  if (isRecord(step.produces) && typeof step.produces.channel === 'string')
    return step.produces.channel;
  return undefined;
}

function secretRef(secret: { service: string; account?: string }): string {
  return secret.account ? `${secret.service}/${secret.account}` : secret.service;
}

// ---------------------------------------------------------------------------
// Targets and origins
// ---------------------------------------------------------------------------

type TargetResult =
  | { ok: true; target: ManifestTarget; origin: string }
  | { ok: false; reason: ManifestUnbindableReason };

function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Static URL → exact target; template only after `scheme://host/` → origin + path prefix. */
export function compileNavigationTarget(url: unknown): TargetResult {
  if (typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'invalid_url' };
  const segments = scanPipelineTemplate(url);
  if (!segments.some((segment) => 'token' in segment)) {
    const parsed = httpUrl(url);
    return parsed
      ? { ok: true, target: { kind: 'url', url: parsed.href }, origin: parsed.origin }
      : { ok: false, reason: 'invalid_url' };
  }
  const first = segments[0];
  if (!('literal' in first)) return { ok: false, reason: 'templated_host' };
  // The authority must be fully static and closed by '/' before any token,
  // or a token could extend the host (`https://a.example{{x}}`).
  const match = first.literal.match(/^(https?):\/\/([^/?#\s]+)(\/.*)?$/s);
  if (!match || match[3] === undefined) return { ok: false, reason: 'templated_host' };
  if (match[2].includes('@')) return { ok: false, reason: 'invalid_url' };
  const origin = httpUrl(`${match[1]}://${match[2]}/`)?.origin;
  if (!origin) return { ok: false, reason: 'invalid_url' };
  return { ok: true, target: { kind: 'origin_path', origin, path_prefix: match[3] }, origin };
}

function substituteStaticContext(
  value: unknown,
  context: Record<string, unknown>,
  exported: ReadonlySet<string>
): unknown {
  if (typeof value !== 'string') return value;
  const segments = scanPipelineTemplate(value);
  if (!segments.some((segment) => 'token' in segment)) return value;
  return segments
    .map((segment) => {
      if ('literal' in segment) return segment.literal;
      const variable = tokenRootVariable(segment.token);
      const name = segment.token.trim();
      const bound =
        variable && name === variable && !exported.has(variable) && Object.hasOwn(context, variable)
          ? context[variable]
          : undefined;
      return typeof bound === 'string' || typeof bound === 'number'
        ? String(bound)
        : `{{${segment.token}}}`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

const NAVIGATION_OPS = new Set(['browser:goto', 'browser:open_tab']);
const SCRIPT_OPS = new Set(['browser:evaluate', 'browser:cdp']);

interface DraftEntry {
  entry: Omit<EffectManifestEntry, 'origins' | 'bindable' | 'unbindable_reason'>;
  navigationOrigin?: string;
  reason?: ManifestUnbindableReason;
}

/** The text a page-script op runs: evaluate's script, or a CDP call's params. */
function scriptTextOf(operationId: string, authored: Record<string, unknown>): string {
  if (operationId === 'browser:evaluate') return String(authored.script ?? '');
  const { export_as: _export, ...call } = authored;
  return JSON.stringify(call);
}

export function presentScript(text: string): ManifestScript {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    length: text.length,
    excerpt:
      collapsed.length > SCRIPT_EXCERPT_CHARS
        ? `${collapsed.slice(0, SCRIPT_EXCERPT_CHARS)}…`
        : collapsed,
  };
}

/** Playwright selector syntax that enters another frame. */
const FRAME_PIERCING = /(>>|internal:control\s*=\s*enter-frame|(^|[\s,>])frame\s*=)/iu;

/**
 * Whether a step carrying a secret targets an element that is not a static,
 * same-frame selector: a templated selector (page data could pick the field)
 * or frame-entering syntax (the value could land in a third-party frame).
 */
function unsafeSecretSelector(params: Record<string, unknown>): boolean {
  const unsafe = (value: unknown): boolean =>
    typeof value === 'string'
      ? hasTemplate(value) || FRAME_PIERCING.test(value)
      : Array.isArray(value) && value.some(unsafe);
  return Object.entries(params).some(
    ([key, value]) =>
      /frame/iu.test(key) || (/selector|locator|target/iu.test(key) && unsafe(value))
  );
}

function collectExports(steps: ManifestBody): {
  secrets: RunManifestSecret[];
  secretVars: Map<string, string>;
  outputVars: Set<string>;
} {
  const secrets: RunManifestSecret[] = [];
  const secretVars = new Map<string, string>();
  const outputVars = new Set<string>();
  const visit = (body: ManifestBody, depth: number) => {
    if (depth > 32) return;
    for (const step of body) {
      if (!step) continue;
      const op = normalizePipelineOp(step.op);
      const params = step.params ?? {};
      if (op === 'secret:get' && typeof params.service === 'string' && params.service.trim()) {
        const exportAs = exportKeyOf(step) ?? 'secret_value';
        const secret: RunManifestSecret = {
          service: params.service.trim(),
          ...(typeof params.account === 'string' && params.account.trim()
            ? { account: params.account.trim() }
            : {}),
          export_as: exportAs,
        };
        secrets.push(secret);
        secretVars.set(exportAs, secretRef(secret));
      } else {
        const exported = exportKeyOf(step);
        if (exported) outputVars.add(exported);
        if (isRecord(params) && typeof params.as === 'string') outputVars.add(params.as);
      }
      for (const nested of nestedBodies(op, params)) visit(nested.steps, depth + 1);
      const fallback = asManifestSteps(step.on_error?.fallback);
      if (fallback) visit(fallback, depth + 1);
    }
  };
  visit(steps, 0);
  return { secrets, secretVars, outputVars };
}

/** Secret reference of an environment-variable token (`env/<NAME>`). */
export const ENV_CREDENTIAL_PREFIX = 'env/';

/**
 * The credential a template token carries, or undefined: a `secret:get`
 * export (`<service>/<account>`) or an environment variable (`env/<NAME>`).
 * `{{env.NAME}}` is the browser actuator's documented credential injection
 * (both the pipeline runner and the browser engine resolve it from the
 * process environment), so it is treated exactly like a `secret:get` value.
 */
export function credentialTokenRef(
  token: string,
  secretVars: ReadonlyMap<string, string> = new Map()
): string | undefined {
  const path = (token.trim().split('|')[0] ?? '').trim();
  if (path.startsWith('env.') && path.length > 'env.'.length)
    return `${ENV_CREDENTIAL_PREFIX}${path.slice('env.'.length)}`;
  const variable = tokenRootVariable(token);
  return variable ? secretVars.get(variable) : undefined;
}

/** Variables the pipeline's `secret:get` steps export (their values are credentials). */
export function secretExportVariables(steps: unknown): Set<string> {
  return new Set(collectExports(asManifestSteps(steps) ?? []).secretVars.keys());
}

function argumentOrigins(
  params: Record<string, unknown>,
  secretVars: ReadonlyMap<string, string>
): Record<string, ManifestArgumentOrigin> {
  const out: Record<string, ManifestArgumentOrigin> = {};
  const classify = (value: string): ManifestArgumentOrigin => {
    let origin: ManifestArgumentOrigin = 'static';
    for (const segment of scanPipelineTemplate(value)) {
      if (!('token' in segment)) continue;
      const credential = credentialTokenRef(segment.token, secretVars);
      if (credential) return `secret:${credential}`;
      if (!tokenRootVariable(segment.token)) continue;
      // Any non-secret variable (exports, loop items, context overrides) is
      // runtime data; only literal text is bound by the file's content hash.
      origin = 'step_output';
    }
    return origin;
  };
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      out[path] = classify(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, path ? `${path}.${index}` : String(index)));
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) walk(entry, path ? `${path}.${key}` : key);
    }
  };
  walk(params, '');
  return out;
}

/**
 * The params object the browser runtime binds as `requested_params` before
 * resolution. The browser actuator's own engine (`browser_native`) hands a
 * native step's params to the op as authored: nothing is stamped or removed.
 */
export function runtimeShapedAuthoredParams(
  operationId: string,
  step: { params?: Record<string, unknown>; produces?: unknown },
  format?: RunManifestSourceFormat
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(step.params ?? {}) };
  if (format === BROWSER_NATIVE_FORMAT) return params;
  // The pipeline runner stamps produces → export_as when the author omitted it.
  if (params.export_as === undefined) {
    const channel =
      typeof step.produces === 'string'
        ? step.produces
        : isRecord(step.produces) && typeof step.produces.channel === 'string'
          ? step.produces.channel
          : undefined;
    if (channel) params.export_as = channel;
  }
  // Runner execution metadata never reaches the browser action input.
  delete params._facets;
  delete params._reasoning_policy;
  delete params._step_id;
  if (NAVIGATION_OPS.has(operationId)) delete params.onboarding_isolated_navigation;
  return params;
}

function classifyBrowserOperation(
  action: string,
  step: ManifestStep,
  inBrowserBody: boolean
): { operationId: string; admitted: boolean; known: boolean } {
  const op = canonicalActuatorAction('browser', action);
  let kind: string | undefined = inBrowserBody ? step.type : undefined;
  let known = true;
  if (!kind) {
    try {
      // Catalog dispatch uses the browser op-catalog kind, not the authored step type.
      kind = determineActuatorStepType('browser', op);
    } catch {
      known = false;
    }
  }
  return {
    operationId: `browser:${op}`,
    // An unknown browser op is treated as an effect: the runtime fails closed anyway.
    admitted: known ? browserOperationRequiresAdmission(kind!, op) : true,
    known,
  };
}

/**
 * Compile one pipeline's steps into a Run Manifest. Pure: reads only the
 * actuator op registry (catalog kinds) and the authorization registry.
 */
export function compileRunManifest(
  steps: readonly unknown[],
  options: CompileRunManifestOptions
): RunManifest {
  const native = options.format === BROWSER_NATIVE_FORMAT;
  // A native browser pipeline is one browser body: every step is browser:<op>.
  const typedSteps = asManifestSteps(native ? nativeBrowserManifestSteps(steps) : steps) ?? [];
  const context = isRecord(options.context) ? options.context : {};
  const { secrets, secretVars, outputVars } = collectExports(typedSteps);
  const exportedVars = new Set<string>([...secretVars.keys(), ...outputVars]);
  const incomplete = new Set<string>();
  const drafts: DraftEntry[] = [];

  /**
   * Walk one body in authored order. `origin` is the page origin known at the
   * body's start (the nearest preceding static navigation); `routed` marks a
   * body whose steps a model-chosen `core:judge_route` jump can select.
   * Returns the known origin after the body, or undefined when it navigated
   * somewhere the compiler cannot pin.
   */
  const visit = (
    body: ManifestBody,
    prefix: string,
    multiplier: number | null,
    inBrowserBody: boolean,
    depth: number,
    startOrigin: string | undefined,
    startRouted: boolean
  ): string | undefined => {
    if (depth > 32) {
      incomplete.add('nested steps exceed the depth limit');
      return undefined;
    }
    let origin = startOrigin;
    let routed = startRouted;
    body.forEach((step, index) => {
      if (!step) return;
      const entryId = prefix ? `${prefix}.${index}` : String(index);
      const op = inBrowserBody
        ? `browser:${step.op.replace(/^browser:/, '')}`
        : normalizePipelineOp(step.op);
      const params = isRecord(step.params) ? step.params : {};
      if (HIDDEN_EFFECT_OPS.has(op)) {
        incomplete.add(`${entryId} ${op} runs steps the manifest cannot see`);
      }
      if (isRecord(step.on_error) && step.on_error.ref !== undefined) {
        incomplete.add(`${entryId} on_error.ref runs steps the manifest cannot see`);
      }
      if (step.hooks !== undefined) {
        incomplete.add(`${entryId} hooks run steps the manifest cannot see`);
      }

      const [domain, action = ''] = op.split(':');
      let operationId = op;
      let admitted = false;
      let known = true;
      if (domain === 'browser' && !['if', 'while', 'ref'].includes(action)) {
        ({ operationId, admitted, known } = classifyBrowserOperation(action, step, inBrowserBody));
      } else if (domain !== 'core' && domain !== 'browser') {
        admitted = requiresApprovalAdmission(operationAuthorization(op));
      }

      if (admitted) {
        const authored = runtimeShapedAuthoredParams(
          operationId,
          { ...step, params },
          options.format
        );
        const argOrigins = argumentOrigins(authored, secretVars);
        const draft: DraftEntry = {
          entry: {
            entry_id: entryId,
            operation_id: operationId,
            admission: 'approval',
            argument_origins: argOrigins,
            params_template_hash: computeApprovalPayloadHash(authored),
            max_occurrences: multiplier,
          },
        };
        const script = SCRIPT_OPS.has(operationId)
          ? presentScript(scriptTextOf(operationId, authored))
          : undefined;
        if (script) draft.entry.script = script;
        let navigationTarget: TargetResult | undefined;
        if (NAVIGATION_OPS.has(operationId)) {
          navigationTarget = compileNavigationTarget(
            substituteStaticContext(params.url, context, exportedVars)
          );
        }
        const secretRefs = [
          ...new Set(
            Object.values(argOrigins)
              .filter((value) => value.startsWith('secret:'))
              .map((value) => value.slice('secret:'.length))
          ),
        ];
        // A secret may reach only the page it was authored for: the target of
        // its own navigation, or the nearest preceding static navigation.
        const secretOrigin = navigationTarget
          ? 'origin' in navigationTarget
            ? navigationTarget.origin
            : undefined
          : origin;
        if (secretRefs.length && secretOrigin)
          draft.entry.secret_origins = Object.fromEntries(
            secretRefs.map((ref) => [ref, [secretOrigin]])
          );
        if (!known) draft.reason = 'unknown_operation';
        else if (!isManifestBindableOperation(operationId)) draft.reason = 'not_manifest_bindable';
        else if (
          NAVIGATION_OPS.has(operationId) &&
          Object.entries(argOrigins).some(
            ([path, from]) =>
              (path === 'url' || path.startsWith('url.')) && from.startsWith('secret:')
          )
        )
          // A credential in the address leaves with the request (and its logs/referrers).
          draft.reason = 'credential_in_url';
        else if (operationId === 'browser:click' && params.ref != null && String(params.ref).trim())
          draft.reason = 'ref_dispatch';
        else if (
          SCRIPT_OPS.has(operationId) &&
          Object.values(params).some((value) => typeof value === 'string' && hasTemplate(value))
        )
          // A page-derived value spliced into approved script text is code injection.
          draft.reason = 'templated_script';
        else if (script && script.length > MAX_PRESENTABLE_SCRIPT_CHARS)
          // Too long to show on the card: never approved unseen.
          draft.reason = 'script_not_presentable';
        else if (secretRefs.length && unsafeSecretSelector(params))
          draft.reason = 'unsafe_secret_selector';
        else if (secretRefs.length && !secretOrigin) draft.reason = 'secret_origin_unknown';
        else if (routed) draft.reason = 'judge_routed';
        else if (multiplier === null) draft.reason = 'unbounded_loop';
        if (navigationTarget) {
          if ('reason' in navigationTarget) {
            draft.reason ??= navigationTarget.reason;
          } else {
            draft.entry.target = navigationTarget.target;
            draft.navigationOrigin = navigationTarget.origin;
          }
        }
        drafts.push(draft);
      }
      // A native run's step that writes a file outside the run's partition
      // is never pre-approved: it asks per step (browser:write_file).
      if (native && domain === 'browser') {
        const write = nativeWritePath(
          op,
          params,
          {
            tier: options.scope.tier,
            ...(options.scope.tenantSlug ? { tenant_slug: options.scope.tenantSlug } : {}),
          },
          options.sessionId || 'default'
        );
        if (write && !write.confined) {
          const authored = runtimeShapedAuthoredParams(
            NATIVE_WRITE_FILE_OPERATION,
            { ...step, params },
            options.format
          );
          drafts.push({
            entry: {
              entry_id: entryId,
              operation_id: NATIVE_WRITE_FILE_OPERATION,
              admission: 'approval',
              argument_origins: argumentOrigins(authored, secretVars),
              params_template_hash: computeApprovalPayloadHash(authored),
              max_occurrences: multiplier,
              write: { path: write.path, suggested_path: write.suggested_path },
            },
            reason: 'write_path_unconfined',
          });
        }
      }
      if (NAVIGATION_OPS.has(operationId)) {
        const target = compileNavigationTarget(
          substituteStaticContext(params.url, context, exportedVars)
        );
        origin = 'origin' in target ? target.origin : undefined;
      }
      // A model-chosen jump selects among the steps after it in this body.
      if (op === 'core:judge_route') routed = true;

      let after = origin;
      for (const nested of nestedBodies(op, params)) {
        const end = visit(
          nested.steps,
          `${entryId}.${nested.key}`,
          multiply(multiplier, nested.repeat),
          inBrowserBody || nested.browserBody === true,
          depth + 1,
          origin,
          routed
        );
        if (end !== origin) after = undefined;
      }
      const fallback = asManifestSteps(step.on_error?.fallback);
      if (fallback) {
        const end = visit(
          fallback,
          `${entryId}.on_error.fallback`,
          multiplier,
          inBrowserBody,
          depth + 1,
          origin,
          routed
        );
        if (end !== origin) after = undefined;
      }
      // A body that may navigate leaves the page origin unknown after it.
      origin = after;
    });
    return origin;
  };
  visit(typedSteps, '', 1, native, 0, undefined, false);

  const manifestOrigins = [
    ...new Set(
      drafts.flatMap((draft) =>
        draft.navigationOrigin !== undefined ? [draft.navigationOrigin] : []
      )
    ),
  ].sort();
  const effects: EffectManifestEntry[] = drafts.map((draft) => {
    const navigation = NAVIGATION_OPS.has(draft.entry.operation_id);
    const origins = navigation
      ? draft.navigationOrigin !== undefined
        ? [draft.navigationOrigin]
        : []
      : draft.entry.operation_id.startsWith('browser:')
        ? manifestOrigins
        : [];
    let reason = draft.reason;
    if (!reason && origins.length === 0) reason = 'no_static_origin';
    return {
      ...draft.entry,
      origins: [...origins],
      bindable: reason === undefined,
      ...(reason ? { unbindable_reason: reason } : {}),
    };
  });

  const model = pipelineBootstrapNeeds(
    presentSteps(typedSteps) as unknown as PipelineBootstrapStep[],
    normalizePipelineOp
  ).model;

  const body: Omit<RunManifest, 'manifest_hash'> = {
    version: RUN_MANIFEST_VERSION,
    scope: {
      tier: options.scope.tier,
      ...(options.scope.tenantSlug ? { tenant_slug: options.scope.tenantSlug } : {}),
    },
    source: {
      input_path: options.inputPath.replaceAll('\\', '/'),
      content_sha256: options.contentSha256,
      ...(native ? { format: BROWSER_NATIVE_FORMAT } : {}),
    },
    complete: incomplete.size === 0,
    incomplete_reasons: [...incomplete],
    requirements: {
      model,
      secrets,
      effects,
      ...browserRequirements(presentSteps(typedSteps), options),
    },
  };
  return { ...body, manifest_hash: computeRunManifestHash(body) };
}

/**
 * The security-relevant browser options the run will actually apply (the same
 * classifier the browser actuator uses, confined to this file's scope): a
 * lifted private-network fence, a persistent profile, a video recording.
 * Options the run drops are not shown — `pipeline check` warns about them.
 */
function browserRequirements(
  steps: readonly unknown[],
  options: CompileRunManifestOptions
): Pick<
  RunManifest['requirements'],
  'browser_navigation' | 'browser_profile' | 'browser_recording'
> {
  if (!pipelineUsesBrowser(steps)) return {};
  // As a bound run applies them: a session without a declared profile still
  // keeps one on disk, confined to the run's partition.
  const sessionId = options.sessionId || 'default';
  const { applied, implicit_profile_session } = classifyPipelineBrowserOptions(
    options.pipelineOptions ?? {},
    {
      tier: options.scope.tier,
      ...(options.scope.tenantSlug ? { tenant_slug: options.scope.tenantSlug } : {}),
    },
    { sessionId }
  );
  const policy = isRecord(applied.navigation_policy) ? applied.navigation_policy : {};
  const navigation = {
    ...(policy.allow_private_network === true ? { allow_private_network: true as const } : {}),
    ...(policy.allow_data_url === true ? { allow_data_url: true as const } : {}),
  };
  return {
    ...(Object.keys(navigation).length ? { browser_navigation: navigation } : {}),
    ...(typeof applied.user_data_dir === 'string'
      ? {
          browser_profile: {
            user_data_dir: applied.user_data_dir,
            ...(implicit_profile_session !== undefined
              ? { session_id: implicit_profile_session }
              : {}),
          },
        }
      : {}),
    ...(typeof applied.video_artifact_dir === 'string'
      ? { browser_recording: { video_artifact_dir: applied.video_artifact_dir } }
      : {}),
  };
}

/** sha256 of the canonical (key-sorted) JSON of the manifest without its hash. */
export function computeRunManifestHash(manifest: Omit<RunManifest, 'manifest_hash'>): string {
  const { manifest_hash: _ignored, ...body } = manifest as RunManifest;
  return computeApprovalPayloadHash(body as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Plain-language description for the approval card
// ---------------------------------------------------------------------------

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function describeTarget(target: ManifestTarget | undefined): string {
  if (!target) return 'a URL decided at run time';
  return target.kind === 'url' ? target.url : `${target.origin}${target.path_prefix}…`;
}

function times(count: number | null): string {
  if (count === null) return 'an unbounded number of times';
  return count === 1 ? 'once' : `up to ${count} times`;
}

function onHosts(origins: readonly string[]): string {
  return origins.length ? origins.map(hostOf).join(', ') : 'an unapproved page';
}

function sumOccurrences(entries: readonly EffectManifestEntry[]): number | null {
  let total = 0;
  for (const entry of entries) {
    if (entry.max_occurrences === null) return null;
    total += entry.max_occurrences;
  }
  return total;
}

function selectorOf(params: Record<string, unknown> | undefined): string | undefined {
  const selector = params?.selector;
  return typeof selector === 'string' ? selector : undefined;
}

/**
 * Plain-language lines for the approval card: what the run will do, in the
 * order a reviewer needs it, with the binding hash on the last line. English,
 * matching the existing pipeline trust card.
 */
export function describeRunManifest(
  manifest: RunManifest,
  /** `hashFooter: false` omits the hash line when the caller renders its own footer. */
  options: { steps?: readonly unknown[]; hashFooter?: boolean } = {}
): string[] {
  const lines: string[] = [];
  const scope = manifest.scope.tenant_slug
    ? `tenant ${manifest.scope.tenant_slug} (${manifest.scope.tier})`
    : manifest.scope.tier;
  lines.push(`Scope: ${scope}`);
  if (manifest.source.format === BROWSER_NATIVE_FORMAT)
    lines.push('Runner: the browser actuator (native browser pipeline)');
  lines.push(
    manifest.requirements.model
      ? 'Model: required (calls a reasoning backend)'
      : 'Model: not required (deterministic)'
  );
  const refs = [
    ...new Set([
      ...manifest.requirements.secrets.map(secretRef),
      ...manifest.requirements.effects.flatMap(credentialsOf),
    ]),
  ].map((ref) =>
    ref.startsWith(ENV_CREDENTIAL_PREFIX)
      ? `environment variable ${ref.slice(ENV_CREDENTIAL_PREFIX.length)} (credential)`
      : ref
  );
  lines.push(`Secrets: ${refs.length ? refs.join(', ') : 'none'}`);
  if (manifest.requirements.browser_navigation?.allow_private_network)
    lines.push('Browser: allows private-network navigation (intranet and loopback hosts)');
  if (manifest.requirements.browser_navigation?.allow_data_url)
    lines.push('Browser: allows navigation to data: URLs (pages built from inline content)');
  if (manifest.requirements.browser_profile)
    lines.push(
      `Browser: uses the persistent profile ${manifest.requirements.browser_profile.user_data_dir}${
        manifest.requirements.browser_profile.session_id !== undefined
          ? ` of browser session "${manifest.requirements.browser_profile.session_id}"`
          : ''
      } (keeps its logins between runs)`
    );
  if (manifest.requirements.browser_recording)
    lines.push(
      `Browser: records the session on video to ${manifest.requirements.browser_recording.video_artifact_dir}`
    );

  const paramsByEntry = new Map<string, Record<string, unknown>>();
  if (options.steps) {
    const index = (body: unknown, prefix: string) => {
      const steps = asManifestSteps(body);
      steps?.forEach((step, position) => {
        if (!step) return;
        const id = prefix ? `${prefix}.${position}` : String(position);
        if (isRecord(step.params)) {
          paramsByEntry.set(id, step.params);
          for (const [key, value] of Object.entries(step.params)) {
            if (Array.isArray(value)) index(value, `${id}.${key}`);
          }
          if (Array.isArray(step.params.cases)) {
            step.params.cases.forEach((entry, caseIndex) => {
              if (!isRecord(entry)) return;
              for (const key of ['steps', 'then', 'pipeline', 'do'])
                index(entry[key], `${id}.cases.${caseIndex}.${key}`);
            });
          }
        }
        index(step.on_error?.fallback, `${id}.on_error.fallback`);
      });
    };
    index(options.steps, '');
  }

  const effects = manifest.requirements.effects;
  const scripts = effects.filter((entry) => SCRIPT_OPS.has(entry.operation_id));
  for (const entry of effects) {
    if (SCRIPT_OPS.has(entry.operation_id) || entry.write) continue;
    const params = paramsByEntry.get(entry.entry_id);
    const count = times(entry.max_occurrences);
    switch (entry.operation_id) {
      case 'browser:goto':
      case 'browser:open_tab':
        lines.push(
          `${entry.operation_id === 'browser:open_tab' ? 'Open a new tab at' : 'Open'} ${describeTarget(entry.target)} ${count}`
        );
        break;
      case 'browser:fill': {
        const selector = selectorOf(params) ?? 'a field';
        const secret = Object.values(entry.argument_origins)
          .find((origin) => origin.startsWith('secret:'))
          ?.slice('secret:'.length);
        lines.push(
          secret
            ? `Type ${credentialPhrase(secret)} into ${selector} on ${
                entry.secret_origins?.[secret]
                  ? onHosts(entry.secret_origins[secret])
                  : 'a page decided at run time'
              } ${count}`
            : `Fill ${selector} on ${onHosts(entry.origins)} ${count}`
        );
        break;
      }
      case 'browser:click':
        lines.push(
          `Click ${selectorOf(params) ?? 'an element'} on ${onHosts(entry.origins)} ${count}`
        );
        break;
      case 'browser:click_first_match': {
        const selectors = Array.isArray(params?.selectors) ? params.selectors.length : undefined;
        lines.push(
          `Click the first match of ${selectors ?? 'several'} selectors on ${onHosts(entry.origins)} ${count}`
        );
        break;
      }
      default:
        lines.push(`Run ${entry.operation_id} on ${onHosts(entry.origins)} ${count}`);
    }
    // Any other step that carries a credential says so on its own line.
    if (entry.operation_id !== 'browser:fill' && credentialsOf(entry).length)
      lines[lines.length - 1] += carriesCredentials(entry);
  }
  // Every distinct page script is shown — an excerpt and its own digest — so
  // the approver judges the code, not a count of it.
  const byScript = new Map<string, EffectManifestEntry[]>();
  for (const entry of scripts) {
    const key = entry.script?.sha256 ?? `entry:${entry.entry_id}`;
    byScript.set(key, [...(byScript.get(key) ?? []), entry]);
  }
  for (const group of byScript.values()) {
    const script = group[0].script;
    const origins = [...new Set(group.flatMap((entry) => entry.origins))];
    const steps = group.map((entry) => entry.entry_id).join(', ');
    const what = group[0].operation_id === 'browser:cdp' ? 'DevTools call' : 'page script';
    lines.push(
      script
        ? `Run ${what} sha256:${script.sha256.slice(0, 16)} on ${onHosts(origins)} ${times(sumOccurrences(group))} (step ${steps}; ${script.length} chars): ${
            script.length > MAX_PRESENTABLE_SCRIPT_CHARS
              ? 'too long to show here — it will ask per step'
              : JSON.stringify(script.excerpt)
          }`
        : `Run ${what} on ${onHosts(origins)} ${times(sumOccurrences(group))} (step ${steps})`
    );
    for (const entry of group)
      if (credentialsOf(entry).length)
        lines.push(`  step ${entry.entry_id}${carriesCredentials(entry)}`);
  }
  const unbindable = effects.filter((entry) => !entry.bindable);
  for (const entry of unbindable) {
    if (entry.write) {
      lines.push(
        `Will still ask per step: step ${entry.entry_id} writes ${entry.write.path} outside the run's partition — to pre-approve it, write it under ${entry.write.suggested_path}`
      );
      continue;
    }
    const reason = entry.unbindable_reason
      ? UNBINDABLE_REASON_TEXT[entry.unbindable_reason]
      : 'it cannot be checked before the run';
    lines.push(
      `Will still ask per step: ${entry.operation_id} at step ${entry.entry_id} — ${reason}`
    );
  }
  for (const reason of manifest.incomplete_reasons) {
    lines.push(`Not covered by this approval: ${reason}`);
  }
  if (options.hashFooter !== false) lines.push(`Manifest SHA-256: ${manifest.manifest_hash}`);
  return lines;
}

/** Credential references a manifest entry carries (secret:get exports and env variables). */
function credentialsOf(entry: EffectManifestEntry): string[] {
  return [
    ...new Set(
      Object.values(entry.argument_origins)
        .filter((origin) => origin.startsWith('secret:'))
        .map((origin) => origin.slice('secret:'.length))
    ),
  ];
}

/** Plain words for one credential reference on the card. */
function credentialPhrase(ref: string): string {
  return ref.startsWith(ENV_CREDENTIAL_PREFIX)
    ? `the value of environment variable ${ref.slice(ENV_CREDENTIAL_PREFIX.length)} (credential)`
    : `secret ${ref}`;
}

function carriesCredentials(entry: EffectManifestEntry): string {
  return ` — carries ${credentialsOf(entry)
    .map(
      (ref) =>
        `${credentialPhrase(ref)} (only to ${
          entry.secret_origins?.[ref]
            ? onHosts(entry.secret_origins[ref])
            : 'a page decided at run time'
        })`
    )
    .join(', ')}`;
}

/** Plain-language reason a step stays on per-step approval. */
const UNBINDABLE_REASON_TEXT: Record<ManifestUnbindableReason, string> = {
  templated_host: 'the site address is decided at run time',
  invalid_url: 'the address is not a plain http(s) URL',
  unbounded_loop: 'it repeats an unknown number of times',
  templated_script: 'the page script contains values decided at run time',
  no_static_origin: 'the pipeline never opens a fixed site first',
  ref_dispatch: 'it clicks an element chosen at run time',
  not_manifest_bindable: 'this kind of operation always needs its own approval',
  unknown_operation: 'the operation is not a known browser operation',
  script_not_presentable: `the page script is longer than ${MAX_PRESENTABLE_SCRIPT_CHARS} characters and cannot be shown on this card`,
  secret_origin_unknown: 'no fixed site is opened before it types a secret',
  unsafe_secret_selector:
    'it types a secret into an element chosen at run time or inside another frame',
  judge_routed: 'a model decides whether it runs (core:judge_route)',
  credential_in_url: 'it puts a credential into the address it opens',
  write_path_unconfined: "it writes a file outside the run's partition",
};
