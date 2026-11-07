/**
 * Declarative runtime requirements for seam providers (bridges, backends).
 *
 * A provider declares what the host must supply — OS platform, accelerator
 * class, a managed tool-runtime, or an operator-supplied env command — and
 * `unmetRuntimeRequirements` turns the declaration into `unmet` reasons the
 * seam-provider-selection layer can rank/exclude with. This replaces the
 * scattered `installXxxIfAvailable` probes that made unavailable providers
 * invisible (surfacing as "not found" at runtime instead of an
 * `unmet: ['managed_runtime:mlx_whisper']` exclusion with a setup hint).
 */

import { hostArch, hostNodePlatform, isAppleSilicon } from '../platform-facts.js';
import { locateManagedToolPythonBin } from '../tool/tool-runtime-registry.js';
import { isExternalToolBinResolvable } from '../tool/tool-binary-resolvers.js';
import { getRegisteredEnvText } from '../foundation/env.js';

export interface ProviderRuntimeRequirement {
  /** Host platforms the provider can run on (NodeJS.Platform names). */
  platforms?: readonly string[];
  /** Hardware accelerator the provider needs. 'mlx'/'metal' require Apple Silicon. */
  accelerator?: 'metal' | 'mlx' | 'cuda' | 'none';
  /** Managed tool-runtime registry id that must be installed (`pnpm tool:setup`). */
  managed_tool_id?: string;
  /** Env var naming an operator-supplied command that must be set. */
  env_command?: string;
  /** Non-command env vars that must be set (profile ids, flags, …). */
  env_vars?: readonly string[];
  /**
   * External tool binary that must resolve — via its KYBERION_*_BIN env
   * override, an installed managed binary, a governed registry command, or a
   * PATH-visible binary under `binary`.
   */
  tool_binary?: { toolId: string; envNames: readonly string[]; binary: string };
}

/** Injectable evaluation context — tests pass fakes; production uses defaults. */
export interface RuntimeRequirementContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * CPU architecture for accelerator checks; defaults to the host arch. Must
   * accompany `platform` in fakes — `platform:'darwin'` on an x64 host is not
   * Apple Silicon.
   */
  arch?: string;
  /** Managed-runtime probe; defaults to the tool-runtime registry record. */
  isManagedToolInstalled?: (toolId: string) => boolean;
  /** External-binary probe; defaults to the governed tool-binary resolvers. */
  isToolBinaryResolvable?: (spec: {
    toolId: string;
    envNames: readonly string[];
    binary: string;
  }) => boolean;
}

const DEFAULT_MANAGED_PROBE = (toolId: string): boolean =>
  locateManagedToolPythonBin(toolId) !== null;

function acceleratorAvailable(
  accelerator: NonNullable<ProviderRuntimeRequirement['accelerator']>,
  ctx: Required<Pick<RuntimeRequirementContext, 'platform' | 'arch'>>
): boolean {
  switch (accelerator) {
    case 'none':
      return true;
    case 'metal':
    case 'mlx':
      return isAppleSilicon(ctx.platform, ctx.arch);
    case 'cuda':
      return ctx.platform === 'linux' || ctx.platform === 'win32';
  }
}

/**
 * Reasons a provider cannot run on this host, e.g.
 * `['platform:darwin', 'managed_runtime:mlx_whisper']`.
 * Empty array = runnable.
 */
export function unmetRuntimeRequirements(
  req: ProviderRuntimeRequirement | undefined,
  ctx: RuntimeRequirementContext = {}
): string[] {
  if (!req) return [];
  const unmet: string[] = [];
  const platform = ctx.platform ?? hostNodePlatform();
  const arch = ctx.arch ?? hostArch();
  if (req.platforms && req.platforms.length > 0 && !req.platforms.includes(platform)) {
    unmet.push(`platform:${req.platforms.join('|')}`);
  }
  if (req.accelerator && !acceleratorAvailable(req.accelerator, { platform, arch })) {
    unmet.push(`accelerator:${req.accelerator}`);
  }
  if (req.managed_tool_id) {
    const probe = ctx.isManagedToolInstalled ?? DEFAULT_MANAGED_PROBE;
    if (!probe(req.managed_tool_id)) unmet.push(`managed_runtime:${req.managed_tool_id}`);
  }
  if (req.env_command && !getRegisteredEnvText(req.env_command, { env: ctx.env })?.trim()) {
    unmet.push(`env:${req.env_command}`);
  }
  for (const name of req.env_vars ?? []) {
    if (!getRegisteredEnvText(name, { env: ctx.env })?.trim()) unmet.push(`env:${name}`);
  }
  if (req.tool_binary) {
    const probe = ctx.isToolBinaryResolvable ?? isExternalToolBinResolvable;
    if (!probe(req.tool_binary)) unmet.push(`tool_binary:${req.tool_binary.toolId}`);
  }
  return [...new Set(unmet)];
}

/**
 * Actionable setup hint for runtime unmet reasons — the governed install
 * surface for `managed_runtime:*`, or the env var to set for `env:*`.
 */
export function runtimeSetupHint(unmet: readonly string[]): string | undefined {
  const hints: string[] = [];
  for (const reason of unmet) {
    if (reason.startsWith('managed_runtime:')) {
      hints.push(`pnpm tool:setup -- --tool ${reason.slice('managed_runtime:'.length)} --apply`);
    } else if (reason.startsWith('tool_binary:')) {
      hints.push(`pnpm tool:setup -- --tool ${reason.slice('tool_binary:'.length)} --apply`);
    } else if (reason.startsWith('env:')) {
      hints.push(`set ${reason.slice('env:'.length)}`);
    }
  }
  return hints.length > 0 ? hints.join('; ') : undefined;
}

/**
 * Setup hints across a candidate list (e.g. decision.excluded) — deduped.
 */
export function runtimeSetupHintsFromCandidates(
  candidates: ReadonlyArray<{ unmet?: readonly string[] }>
): string[] {
  const hints = new Set<string>();
  for (const candidate of candidates) {
    const hint = runtimeSetupHint(candidate.unmet ?? []);
    if (hint) for (const part of hint.split('; ')) hints.add(part);
  }
  return [...hints];
}
