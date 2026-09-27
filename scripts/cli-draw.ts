/**
 * `pnpm kyberion draw <prompt | --file <txt>> --out <image> [--aspect <w:h>] [--style <id>]
 *    [--ref <image>[:role]]... [--allow-cloud] [--allow-handoff] [--provider <id>]
 *    [--consent-provider <id> --consent-granted-by <who>] [--dry-run] [--json]`
 *
 * The action-side inverse of `pnpm kyberion see`: prompt → image through the
 * governed image-generation bridge (@agent/core/image-generation-bridge) — no
 * provider code of its own. The verb owns only the egress gate:
 *   - default          → providers that keep the data on this machine and finish
 *                        unattended (Image Playground, local Flux, ComfyUI, …)
 *   - --allow-cloud    → also cloud providers (Gemini, …); the provider is reported
 *   - --allow-handoff  → host-agent hand-off as a last resort: the first run exits
 *                        100 with instructions, rerunning the same command collects
 *                        the image once the host agent saved it to --out
 * The gate is an explicit provider allowlist enforced by the router on every
 * selection path. Reference images (`--ref`) follow PA-10: a cloud or hand-off
 * provider needs a per-run consent naming it (see `--dry-run`).
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeUnlinkSync,
} from '@agent/core/secure-io';
import type { ImageGenerationPlan } from '@agent/core/image-generation-bridge';
import type {
  ImageEgressConsent,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageReference,
} from '@agent/core/image-generation-types';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { ScriptExitError } from './lib/harness.js';
import {
  assertExtension,
  createPerceptionWorkDir,
  defaultPerceptionDeps,
  explainMediaError,
  isInsideRepository,
  parseCommonOption,
  removeWorkDir,
  resolveRepositoryInput,
  sniffImageDimensions,
  type CommonArgs,
  type MediaTool,
} from './lib/perception.js';

export const MAX_DRAW_PROMPT_CHARS = 4_000;
export const DRAW_OUT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
/** Same exit code as generate_avatar: the host agent must act, then rerun. */
export const DRAW_HANDOFF_EXIT_CODE = 100;
const REFERENCE_ROLES = ['subject', 'style', 'consistency'] as const;
const REFERENCE_MIME: Record<string, ImageReference['mimeType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export const DRAW_USAGE = `Usage: pnpm kyberion draw <prompt | --file <txt>> --out <image> [options]

Generates an image from a prompt through the governed image-generation bridge.
By default only providers that keep the data on this machine and finish unattended are used.
  --out <file>              Image to write inside the repository (${DRAW_OUT_EXTENSIONS.join(' / ')}); required unless --dry-run
  --file <txt>              Read the prompt from a file inside the repository
  --aspect <w:h>            Aspect ratio, e.g. 1:1, 16:9 (default 1:1)
  --style <id>              Native provider style (e.g. an Image Playground style)
  --ref <image>[:role]      Reference image (png / jpeg / webp), role subject | style | consistency; repeatable
  --allow-cloud             Also allow cloud providers (the prompt and references leave the machine)
  --allow-handoff           Last resort: hand the request to the host agent (exit ${DRAW_HANDOFF_EXIT_CODE}, rerun to collect)
  --provider <id>           Use only this provider (still subject to the flags above)
  --consent-provider <id>   With --ref: consent to send the references to this cloud / hand-off provider
  --consent-granted-by <who> Who gave that consent (valid for one hour)
  --dry-run                 Show which provider would run, its egress and consent need; generate nothing
  --json                    Print {status, out, provider, data_egress, bytes, width, height, warnings} as JSON
  --verbose                 Keep runtime logs (off by default)

Check the result with \`pnpm kyberion see <image> --describe\`.`;

export interface DrawProviderInfo {
  id: string;
  displayName: string;
  dataEgress: 'local' | 'cloud';
  interactiveHandoff: boolean;
}

/** Everything that touches a provider goes through here so the command stays hermetically testable. */
export interface DrawDeps {
  providers(): Promise<DrawProviderInfo[]>;
  plan(request: ImageGenerationRequest): Promise<ImageGenerationPlan | null>;
  candidates(request: ImageGenerationRequest): Promise<SeamProviderCandidate[]>;
  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  consent(input: { providerId: string; grantedBy: string }): Promise<ImageEgressConsent>;
  runMedia(tool: MediaTool, args: string[]): Promise<string>;
}

export const defaultDrawDeps: DrawDeps = {
  async providers() {
    const bridge = await import('@agent/core/image-generation-bridge');
    const { imageProviderDataEgress } = await import('@agent/core/image-reference-consent');
    // A lookup registers the built-in providers before they are listed.
    bridge.getImageGenerationProvider('');
    return bridge.listImageGenerationProviders().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName || provider.id,
      dataEgress: imageProviderDataEgress(provider),
      interactiveHandoff: provider.requiresInteractiveHandoff === true,
    }));
  },
  async plan(request) {
    const { planImageGeneration } = await import('@agent/core/image-generation-bridge');
    return planImageGeneration(request);
  },
  async candidates(request) {
    const { listImageGenerationCandidates } = await import('@agent/core/image-generation-bridge');
    return listImageGenerationCandidates(request);
  },
  async generate(request) {
    const { generateImage } = await import('@agent/core/image-generation-bridge');
    return generateImage(request);
  },
  async consent(input) {
    const { createImageEgressConsent } = await import('@agent/core/image-reference-consent');
    return createImageEgressConsent(input);
  },
  runMedia: (tool, args) => defaultPerceptionDeps.runMedia(tool, args),
};

interface DrawArgs extends CommonArgs {
  words: string[];
  aspect?: string;
  style?: string;
  provider?: string;
  refs: string[];
  allowCloud: boolean;
  allowHandoff: boolean;
  consentProvider?: string;
  consentGrantedBy?: string;
  dryRun: boolean;
}

export interface DrawResult {
  status: 'succeeded' | 'handoff' | 'planned';
  out: string | null;
  provider: string | null;
  data_egress: 'local' | 'cloud' | null;
  bytes: number | null;
  width?: number;
  height?: number;
  references: number;
  plan?: ImageGenerationPlan;
  allowed_providers?: string[];
  message?: string;
  warnings: string[];
}

function parseDrawArgs(argv: string[]): DrawArgs {
  const args: DrawArgs = {
    json: false,
    help: false,
    words: [],
    refs: [],
    allowCloud: false,
    allowHandoff: false,
    dryRun: false,
  };
  const takeValue = (index: number, label: string): string => {
    const next = argv[index + 1];
    if (!next || next.startsWith('--'))
      throw new ScriptExitError(1, `${argv[index]} requires ${label}`);
    return next;
  };
  const valued: Record<string, [label: string, apply: (value: string) => void]> = {
    '--file': ['a text file path', (v) => (args.file = v)],
    '--aspect': ['an aspect ratio like 16:9', (v) => (args.aspect = v)],
    '--style': ['a style id', (v) => (args.style = v)],
    '--provider': ['a provider id', (v) => (args.provider = v)],
    '--ref': ['an image path', (v) => args.refs.push(v)],
    '--consent-provider': ['a provider id', (v) => (args.consentProvider = v)],
    '--consent-granted-by': ['who consented', (v) => (args.consentGrantedBy = v)],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (value === '--lang') throw new ScriptExitError(1, 'Unknown option: --lang');
    const common = parseCommonOption(args, argv, index);
    if (common) {
      index += common.consumed;
      continue;
    }
    const option = valued[value];
    if (option) {
      option[1](takeValue(index, option[0]));
      index += 1;
    } else if (value === '--allow-cloud') args.allowCloud = true;
    else if (value === '--allow-handoff') args.allowHandoff = true;
    else if (value === '--dry-run') args.dryRun = true;
    else if (value.startsWith('--')) throw new ScriptExitError(1, `Unknown option: ${value}`);
    else args.words.push(value);
  }
  return args;
}

function resolvePrompt(args: DrawArgs): string {
  if (args.file && args.words.length > 0) {
    throw new ScriptExitError(1, '[draw] pass the prompt or --file <txt>, not both');
  }
  let prompt = args.words.join(' ');
  if (args.file) {
    const absolute = resolveRepositoryInput('draw', args.file);
    if (!safeExistsSync(absolute)) throw new ScriptExitError(1, `[draw] ${args.file} not found`);
    prompt = String(safeReadFile(absolute, { encoding: 'utf8' }));
  }
  prompt = prompt.trim();
  if (!prompt) throw new ScriptExitError(1, '[draw] nothing to draw: the prompt is empty');
  if (prompt.length > MAX_DRAW_PROMPT_CHARS) {
    throw new ScriptExitError(
      1,
      `[draw] the prompt is ${prompt.length} characters; the limit is ${MAX_DRAW_PROMPT_CHARS}.`
    );
  }
  return prompt;
}

function resolveOut(out: string | undefined): string {
  if (!out) {
    throw new ScriptExitError(
      1,
      '[draw] --out <image> is required, e.g. --out active/shared/tmp/<job>/image.png'
    );
  }
  const target = pathResolver.rootResolve(out);
  if (!isInsideRepository(target)) {
    throw new ScriptExitError(1, `[draw] --out ${out} must be inside the repository`);
  }
  assertExtension('draw', target, DRAW_OUT_EXTENSIONS);
  return target;
}

function resolveReferences(refs: string[]): ImageReference[] {
  return refs.map((spec) => {
    const match = new RegExp(`^(.*):(${REFERENCE_ROLES.join('|')})$`).exec(spec);
    const file = match ? match[1]! : spec;
    const role = (match?.[2] ?? 'subject') as (typeof REFERENCE_ROLES)[number];
    const absolute = resolveRepositoryInput('draw', file);
    assertExtension('draw', absolute, Object.keys(REFERENCE_MIME), '(--ref)');
    if (!safeExistsSync(absolute)) throw new ScriptExitError(1, `[draw] --ref ${file} not found`);
    const mimeType = REFERENCE_MIME[path.extname(absolute).toLowerCase()]!;
    const sniffed = sniffImageFormat(safeReadFile(absolute, { encoding: null }) as Buffer);
    if (sniffed && `image/${sniffed}` !== mimeType) {
      throw new ScriptExitError(
        1,
        `[draw] --ref ${file} contains ${sniffed} data but its extension says ${mimeType}; rename it`
      );
    }
    return { path: path.relative(pathResolver.rootDir(), absolute), mimeType, role };
  });
}

function flagFor(info: DrawProviderInfo): string {
  return info.interactiveHandoff ? '--allow-handoff' : '--allow-cloud';
}

/** The providers this run may use, before and after the hand-off last resort. */
function allowlist(providers: DrawProviderInfo[], args: DrawArgs, withHandoff: boolean): string[] {
  return providers
    .filter((info) =>
      info.interactiveHandoff ? withHandoff : info.dataEgress === 'local' || args.allowCloud
    )
    .map((info) => info.id);
}

function noProviderMessage(
  candidates: SeamProviderCandidate[],
  allowed: string[],
  args: DrawArgs
): string {
  const lines = ['[draw] no image provider can run this request here.'];
  for (const candidate of candidates.filter((c) => allowed.includes(c.id))) {
    lines.push(`  - ${candidate.id}: ${(candidate.unmet ?? []).join('; ') || 'not selected'}`);
  }
  if (!args.allowCloud) lines.push('  cloud providers are off (add --allow-cloud to allow them)');
  if (!args.allowHandoff) lines.push('  host hand-off is off (add --allow-handoff to allow it)');
  return lines.join('\n');
}

/** Provider errors can carry whole tracebacks; keep the last lines, which name the cause. */
export function summarizeProviderError(message: string, maxLines = 3): string {
  const lines = message
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-maxLines).join(' | ');
  return lines.length > maxLines ? `… ${tail}` : tail;
}

function isHostHandoff(message: string): boolean {
  return /HOST_(AGENT|BRIDGE)_IMAGE_GENERATION_REQUIRED/.test(message);
}

type ImageFormat = 'png' | 'jpeg' | 'webp';

function sniffImageFormat(buffer: Buffer): ImageFormat | undefined {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'jpeg';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return undefined;
}

function formatForExtension(ext: string): ImageFormat {
  return ext === '.png' ? 'png' : ext === '.webp' ? 'webp' : 'jpeg';
}

/** Remove a provider's intermediate only where draw put it: next to --out or in shared tmp. */
function removeByproduct(produced: string, target: string): void {
  const dir = path.dirname(path.resolve(produced));
  const tmpRoot = pathResolver.sharedTmp();
  if (
    path.resolve(produced) !== path.resolve(target) &&
    (dir === path.dirname(path.resolve(target)) || dir.startsWith(`${tmpRoot}${path.sep}`))
  ) {
    safeUnlinkSync(produced);
  }
}

/**
 * Providers may write next to the target with their own extension (Image
 * Playground always writes PNG) or bytes that do not match it. Land the
 * image at `target` in the format its extension names.
 */
async function landOutput(
  deps: DrawDeps,
  produced: string,
  target: string,
  warnings: string[]
): Promise<Buffer> {
  const want = formatForExtension(path.extname(target).toLowerCase());
  const got = sniffImageFormat(safeReadFile(produced, { encoding: null }) as Buffer);
  if (!got || got === want) {
    if (!got) warnings.push('could not recognise the generated image format; kept as written');
    if (path.resolve(produced) !== path.resolve(target)) {
      safeCopyFileSync(produced, target);
      removeByproduct(produced, target);
    }
  } else {
    const workDir = createPerceptionWorkDir('draw');
    try {
      const source = path.join(workDir, `generated.${got === 'jpeg' ? 'jpg' : got}`);
      safeCopyFileSync(produced, source);
      removeByproduct(produced, target);
      const quality = want === 'jpeg' ? ['-q:v', '2'] : [];
      try {
        await deps.runMedia('ffmpeg', [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          source,
          ...quality,
          target,
        ]);
      } catch (error) {
        explainMediaError('draw', error);
      }
      warnings.push(`converted ${got} → ${want} to match ${path.basename(target)}`);
    } finally {
      removeWorkDir(workDir);
    }
  }
  return safeReadFile(target, { encoding: null }) as Buffer;
}

export function renderDrawResult(result: DrawResult, options: { json: boolean }): string {
  if (options.json) return JSON.stringify(result, null, 2);
  const lines: string[] = [];
  if (result.status === 'planned') {
    const plan = result.plan!;
    const notes = [
      `egress ${plan.data_egress}`,
      plan.requires_consent ? 'needs reference consent' : undefined,
      plan.interactive_handoff ? 'host hand-off (two-step)' : undefined,
    ].filter(Boolean);
    lines.push(`[draw] plan: ${plan.display_name} (${plan.provider_id}), ${notes.join(', ')}`);
  } else if (result.status === 'handoff') {
    lines.push(`[draw] handoff (${result.provider}): ${result.message}`);
    lines.push(
      `> [draw] after the host agent saves the image to ${result.out}, rerun the same command`
    );
  } else {
    const dims = result.width && result.height ? `, ${result.width}×${result.height}` : '';
    lines.push(
      `[draw] wrote ${result.out} (${result.provider}, egress ${result.data_egress}${dims}, ${result.bytes} bytes)`
    );
  }
  lines.push(...result.warnings.map((w) => `> [draw] ${w}`));
  return lines.join('\n');
}

export async function runDrawCommand(
  argv: string[],
  print: (text: string) => void,
  deps: DrawDeps = defaultDrawDeps
): Promise<DrawResult | undefined> {
  const args = parseDrawArgs(argv);
  if (args.help) {
    print(DRAW_USAGE);
    return undefined;
  }
  if (!args.file && args.words.length === 0) throw new ScriptExitError(1, DRAW_USAGE);
  const prompt = resolvePrompt(args);
  const target = args.dryRun && !args.out ? undefined : resolveOut(args.out);
  if (args.aspect && !/^[1-9]\d?:[1-9]\d?$/.test(args.aspect)) {
    throw new ScriptExitError(1, `[draw] --aspect must look like 16:9, got "${args.aspect}"`);
  }
  if (Boolean(args.consentProvider) !== Boolean(args.consentGrantedBy)) {
    throw new ScriptExitError(
      1,
      '[draw] --consent-provider and --consent-granted-by must be given together'
    );
  }
  const references = resolveReferences(args.refs);
  if (args.consentProvider && references.length === 0) {
    throw new ScriptExitError(1, '[draw] consent applies only to --ref reference images');
  }

  const providers = await deps.providers();
  const byId = new Map(providers.map((info) => [info.id, info]));
  for (const id of [args.provider, args.consentProvider]) {
    if (!id) continue;
    const info = byId.get(id);
    if (!info) {
      throw new ScriptExitError(
        1,
        `[draw] unknown provider "${id}". Known: ${providers.map((p) => p.id).join(', ')}`
      );
    }
    if (!allowlist(providers, args, args.allowHandoff).includes(id)) {
      throw new ScriptExitError(
        1,
        `[draw] ${id} is not allowed for this run; add ${flagFor(info)}`
      );
    }
  }

  const request: ImageGenerationRequest = {
    prompt,
    mode: args.allowCloud ? 'balanced' : 'local_only',
    aspectRatio: args.aspect ?? '1:1',
    ...(args.style ? { style: args.style } : {}),
    ...(args.provider ? { providerPreference: [args.provider] } : {}),
    ...(target ? { targetPath: target } : {}),
    awaitCompletion: true,
    ...(references.length > 0 ? { referenceImages: references } : {}),
    ...(args.consentProvider
      ? {
          egressConsent: await deps.consent({
            providerId: args.consentProvider,
            grantedBy: args.consentGrantedBy!,
          }),
        }
      : {}),
    // --provider pins exactly that provider (already checked against the flags).
    allowedProviders: args.provider ? [args.provider] : allowlist(providers, args, false),
    ...(args.provider && byId.get(args.provider)!.interactiveHandoff
      ? { allowHostHandoff: true }
      : {}),
  };
  let plan = await deps.plan(request);
  if (args.allowHandoff && !args.provider && !plan) {
    request.allowedProviders = allowlist(providers, args, true);
    request.allowHostHandoff = true;
    plan = await deps.plan(request);
  }
  if (!plan) {
    throw new ScriptExitError(
      1,
      noProviderMessage(await deps.candidates(request), request.allowedProviders!, args)
    );
  }

  const warnings: string[] = [];
  const base = {
    references: references.length,
    allowed_providers: request.allowedProviders,
  };
  if (args.dryRun) {
    const result: DrawResult = {
      status: 'planned',
      out: target ? path.relative(pathResolver.rootDir(), target) : null,
      provider: plan.provider_id,
      data_egress: plan.data_egress,
      bytes: null,
      plan,
      ...base,
      warnings,
    };
    print(renderDrawResult(result, { json: args.json }));
    return result;
  }
  if (plan.requires_consent && request.egressConsent?.provider_id !== plan.provider_id) {
    throw new ScriptExitError(
      1,
      `[draw] ${plan.display_name} (${plan.provider_id}) would receive the reference image(s) off this machine. ` +
        `To consent for this run, add --consent-provider ${plan.provider_id} --consent-granted-by <who>.`
    );
  }

  const out = path.relative(pathResolver.rootDir(), target!);
  safeMkdir(path.dirname(target!), { recursive: true });
  let generated: ImageGenerationResult;
  try {
    generated = await deps.generate(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const denied = /IMAGE_REFERENCE_EGRESS_DENIED\]\s*([\w-]+)/.exec(message);
    if (denied) {
      throw new ScriptExitError(
        1,
        `[draw] ${denied[1]} would receive the reference image(s) off this machine. ` +
          `To consent for this run, add --consent-provider ${denied[1]} --consent-granted-by <who>.`
      );
    }
    if (!isHostHandoff(message))
      throw new ScriptExitError(1, `[draw] generation failed: ${summarizeProviderError(message)}`);
    const result: DrawResult = {
      status: 'handoff',
      out,
      provider: plan.provider_id,
      data_egress: 'cloud',
      bytes: null,
      message,
      ...base,
      warnings,
    };
    print(renderDrawResult(result, { json: args.json }));
    throw new ScriptExitError(DRAW_HANDOFF_EXIT_CODE, '', true, result);
  }
  if (generated.status !== 'succeeded' || !generated.path || !safeExistsSync(generated.path)) {
    throw new ScriptExitError(
      1,
      `[draw] generation ${generated.status === 'succeeded' ? 'reported success but wrote no image' : generated.status} (${generated.provider})${generated.error ? `: ${summarizeProviderError(generated.error)}` : ''}`
    );
  }
  const info = byId.get(generated.provider);
  const egress = info?.dataEgress ?? 'cloud';
  if (egress === 'cloud') {
    warnings.push(
      `generated by ${info?.displayName ?? generated.provider}: the prompt left this machine`
    );
  }
  const buffer = await landOutput(deps, generated.path, target!, warnings);
  const result: DrawResult = {
    status: 'succeeded',
    out,
    provider: generated.provider,
    data_egress: egress,
    bytes: buffer.length,
    ...sniffImageDimensions(buffer),
    ...base,
    warnings,
  };
  print(renderDrawResult(result, { json: args.json }));
  return result;
}
