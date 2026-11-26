/**
 * Which of a pipeline's browser `options` a run actually applies
 * (pipeline-run-manifest-model.md §8).
 *
 * A pipeline's `options` reach every `browser:*` step of the run, and a
 * tenant run may execute under one project-trust approval. So they are an
 * allowlist: launch overrides that leave the confined browser (CDP attach to
 * the operator's Chrome, raw launch arguments that bypass the navigation
 * fence, the operator's registered Chrome profiles, untenanted traces) are
 * never applied, and the two that write to disk — the persistent profile and
 * the video recording — are applied only inside the run's own
 * `<tier>/<tenant|shared>` partition. Before runner dispatch forwarded any
 * options at all, every one of them was ignored; an option this module does
 * not apply is therefore dropped with a warning, never a failure.
 *
 * The scope is the run's location-derived scope (run-scope.ts), never the
 * ambient tenant. One classifier serves the browser actuator (what it
 * applies), the Run Manifest (what the approval card shows) and
 * `pipeline check` (what will be dropped).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { isRecord } from '../foundation/primitives.js';
import { pathResolver } from '../path-resolver.js';
import { storageFloorRelativePath, storagePartitionSegments } from '../storage-layout.js';
import type { StorageDataTier } from '../storage-layout.js';

/** The run scope the profile and recording directories are confined to. */
export interface BrowserOptionScope {
  tier: string;
  tenant_slug?: string;
}

/** One authored option the run will not apply, in diagnostic form. */
export interface DroppedBrowserOption {
  option: string;
  why: string;
  next: string;
}

export interface ClassifiedBrowserOptions {
  /** The options the browser receives (deep-copied). */
  applied: Record<string, unknown>;
  dropped: DroppedBrowserOption[];
  /**
   * Set when `applied.user_data_dir` is the session's implicit profile (see
   * {@link implicitBrowserProfileDir}), not one the file declares.
   */
  implicit_profile_session?: string;
}

const SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u;

/**
 * The persistent profile a browser session uses when no `user_data_dir`
 * applies. The browser keeps a profile per session id on disk
 * (`runtime/browser/<session_id>`, `default` when unset), so it is a
 * persistent profile even when nothing declares one. A run-manifest-bound run
 * keeps it inside the run's own partition instead:
 * `<profile partition>/session-<session_id>`.
 */
export function implicitBrowserProfileDir(scope: BrowserOptionScope, sessionId: string): string {
  const segment =
    SESSION_SEGMENT.test(sessionId) && !/^\.+$/u.test(sessionId)
      ? sessionId
      : `sha256-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;
  return `${browserProfilePartition(scope)}/session-${segment}`;
}

/** Artifact-floor domain of run-recorded browser video. */
export const BROWSER_VIDEO_DOMAIN = 'browser-video';

/** Options applied as authored (value shape checked by the browser itself). */
const APPLIED_AS_AUTHORED = [
  'headless',
  'viewport',
  'locale',
  'timeout_ms',
  'max_steps',
  'keep_alive',
  'lease_ms',
  'action_trail_max',
] as const;

/** Options a pipeline run never applies: each leaves the confined browser. */
const NEVER_APPLIED: Record<string, string> = {
  connect_over_cdp: 'it attaches to an already running browser instead of a confined one',
  cdp_url: 'it attaches to an already running browser instead of a confined one',
  cdp_port: 'it attaches to an already running browser instead of a confined one',
  launch_args: 'raw launch arguments can bypass the navigation fence (proxy, host rules)',
  profile: "it opens one of the operator's registered Chrome profiles",
  profile_name: "it opens one of the operator's registered Chrome profiles",
  profile_email: "it opens one of the operator's registered Chrome profiles",
  record_trace: 'traces are written outside the tenant partition',
  browser_runtime: 'only the default confined runtime is available to pipeline runs',
  runtime_purpose: 'only the default confined runtime is available to pipeline runs',
};

const PLAIN_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/u;

function partitionOf(scope: BrowserOptionScope) {
  return {
    kind: 'tier' as const,
    tier: scope.tier as StorageDataTier,
    ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
  };
}

/** Repo-relative directory the run's persistent browser profiles must live under. */
export function browserProfilePartition(scope: BrowserOptionScope): string {
  return path.posix.join(
    pathResolver.toRepoRelative(pathResolver.shared('runtime/browser/profiles')),
    ...storagePartitionSegments(partitionOf(scope))
  );
}

/** Repo-relative directory the run's recorded browser video must live under. */
export function browserVideoPartition(scope: BrowserOptionScope): string {
  return storageFloorRelativePath('artifact', partitionOf(scope), BROWSER_VIDEO_DOMAIN);
}

/** Repo-relative POSIX form of a repository path reference, or undefined if outside. */
function repoRelative(ref: string): string | undefined {
  const root = pathResolver.rootDir();
  const relative = path.relative(root, path.resolve(root, ref));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

function confined(value: unknown, partition: string): string | undefined {
  const relative = typeof value === 'string' && value.trim() ? repoRelative(value.trim()) : '';
  return relative && relative.startsWith(`${partition}/`) ? relative : undefined;
}

/**
 * Split a pipeline's `options` into the browser options the run applies and
 * the ones it drops. `scope` undefined (no location-derived run scope) applies
 * no profile or recording directory. Options that are not browser launch
 * options (e.g. `max_inline_output_chars`) are neither applied nor reported.
 */
export function classifyPipelineBrowserOptions(
  pipelineOptions: unknown,
  scope: BrowserOptionScope | undefined,
  /**
   * Run-manifest-bound runs: the session id the browser runs under (`default`
   * when the file sets none). Without an applied `user_data_dir`, its
   * implicit profile is confined to the run's partition.
   */
  bound: { sessionId: string } | undefined = undefined
): ClassifiedBrowserOptions {
  const applied: Record<string, unknown> = {};
  const dropped: DroppedBrowserOption[] = [];
  const implicit = (): ClassifiedBrowserOptions => {
    if (!bound || !scope || typeof applied.user_data_dir === 'string') return { applied, dropped };
    applied.user_data_dir = implicitBrowserProfileDir(scope, bound.sessionId);
    return { applied, dropped, implicit_profile_session: bound.sessionId };
  };
  if (!isRecord(pipelineOptions)) return implicit();
  const options = structuredClone(pipelineOptions) as Record<string, unknown>;
  const set = (value: unknown) => value !== undefined && value !== null && value !== false;

  for (const [option, why] of Object.entries(NEVER_APPLIED)) {
    if (set(options[option]))
      dropped.push({
        option,
        why: `not available to pipeline runs: ${why}`,
        next: `remove options.${option} from the pipeline file`,
      });
  }
  for (const option of APPLIED_AS_AUTHORED) {
    if (options[option] !== undefined) applied[option] = options[option];
  }
  const policy = options.navigation_policy;
  if (isRecord(policy)) {
    applied.navigation_policy = {
      ...(Array.isArray(policy.allowed_origins)
        ? { allowed_origins: policy.allowed_origins.map(String) }
        : {}),
      ...(typeof policy.allow_private_network === 'boolean'
        ? { allow_private_network: policy.allow_private_network }
        : {}),
      ...(typeof policy.allow_data_url === 'boolean'
        ? { allow_data_url: policy.allow_data_url }
        : {}),
    };
  } else if (set(policy)) {
    dropped.push({
      option: 'navigation_policy',
      why: 'it must be an object',
      next: 'set { allowed_origins?, allow_private_network?, allow_data_url? }',
    });
  }
  if (options.browser_channel === 'chromium' || options.browser_channel === 'chrome') {
    applied.browser_channel = options.browser_channel;
  } else if (set(options.browser_channel)) {
    dropped.push({
      option: 'browser_channel',
      why: 'only the chromium and chrome channels exist',
      next: 'set options.browser_channel to "chromium" or "chrome"',
    });
  }
  if (set(options.user_data_dir)) {
    const partition = scope ? browserProfilePartition(scope) : undefined;
    const dir = partition ? confined(options.user_data_dir, partition) : undefined;
    if (dir) applied.user_data_dir = dir;
    else
      dropped.push({
        option: 'user_data_dir',
        why: partition
          ? `${JSON.stringify(options.user_data_dir)} is outside the run's partition ${partition}/ — the run uses a fresh per-session profile instead`
          : 'the run has no location-derived scope to confine a profile to',
        next: partition
          ? `move the profile to ${partition}/<profile-name> and set options.user_data_dir to it`
          : 'run the pipeline from its file so its scope is derived from the location',
      });
  }
  if (set(options.profile_directory)) {
    if (
      typeof options.profile_directory === 'string' &&
      PLAIN_SEGMENT.test(options.profile_directory)
    )
      applied.profile_directory = options.profile_directory;
    else
      dropped.push({
        option: 'profile_directory',
        why: 'it must be a plain profile folder name inside user_data_dir',
        next: 'set options.profile_directory to a name such as "Default"',
      });
  }
  if (options.record_video === true) {
    const partition = scope ? browserVideoPartition(scope) : undefined;
    const dir = partition ? confined(options.video_artifact_dir, partition) : undefined;
    if (dir) {
      applied.record_video = true;
      applied.video_artifact_dir = dir;
    } else
      dropped.push({
        option: 'record_video',
        why: partition
          ? `video_artifact_dir ${JSON.stringify(options.video_artifact_dir ?? null)} is outside the run's artifact partition ${partition}/ — the run is not recorded`
          : 'the run has no location-derived scope to confine a recording to',
        next: partition
          ? `set options.video_artifact_dir to ${partition}/<recording-name>`
          : 'run the pipeline from its file so its scope is derived from the location',
      });
  }
  return implicit();
}

/** One diagnostic line (`what — why | next`) for a dropped option. */
export function describeDroppedBrowserOption(entry: DroppedBrowserOption): string {
  return `browser options.${entry.option} not applied — ${entry.why} | next: ${entry.next}`;
}

/** True when any step (at any nesting depth) dispatches a `browser:*` op. */
export function pipelineUsesBrowser(steps: unknown): boolean {
  if (Array.isArray(steps)) return steps.some(pipelineUsesBrowser);
  if (!isRecord(steps)) return false;
  if (typeof steps.op === 'string' && steps.op.startsWith('browser:')) return true;
  return Object.values(steps).some(
    (value) => (Array.isArray(value) || isRecord(value)) && pipelineUsesBrowser(value)
  );
}
