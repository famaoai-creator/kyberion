import * as path from 'node:path';
import {
  generateImage,
  planImageGeneration,
  type ImageGenerationPlan,
} from '@agent/core/image-generation-bridge';
import type {
  ImageEgressConsent,
  ImageGenerationMode,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageReference,
} from '@agent/core/image-generation-types';
import { createImageEgressConsent } from '@agent/core/image-reference-consent';
import { pathResolver } from '@agent/core/path-resolver';
import { resolveActiveProfileRoot } from '@agent/core/profile-root';
import {
  AVATAR_EXPRESSIONS,
  AVATAR_PROFILE_FILENAME,
  DEFAULT_GENERATED_AVATAR_EXPRESSIONS,
  DEFAULT_AVATAR_MOUTH_ANCHOR,
  personalAvatarDir,
  sniffAvatarImageContentType,
  type AvatarExpression,
  type PersonalAvatarProfileFile,
} from '@agent/core/presence-avatar';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { getRegisteredEnvText, isRecord, nowIso, readJsonIfPresent } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function splitPreference(value: string | boolean | undefined, fallback: string[]): string[] {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'auto') return fallback;
  if (trimmed === 'host')
    return ['host_agent', 'cursor_host_bridge', 'codex_host_bridge', 'agy_host_bridge'];
  if (trimmed === 'cursor')
    return ['cursor_host_bridge', 'host_agent', 'codex_host_bridge', 'agy_host_bridge'];
  if (trimmed === 'codex')
    return ['codex_host_bridge', 'host_agent', 'cursor_host_bridge', 'agy_host_bridge'];
  if (trimmed === 'agy')
    return ['agy_host_bridge', 'host_agent', 'cursor_host_bridge', 'codex_host_bridge'];
  if (trimmed === 'local') return ['local_flux', 'comfyui', 'gemini_service', 'llm_api'];
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function deriveAutoPreference(requireHostBridge: boolean): string[] {
  const bridgePreference =
    getRegisteredEnvText('CURSOR_CLI') ||
    getRegisteredEnvText('CURSOR_AGENT') ||
    getRegisteredEnvText('KYBERION_CURSOR_CLI_BIN') ||
    getRegisteredEnvText('CURSOR_API_KEY')
      ? ['cursor_host_bridge', 'codex_host_bridge', 'agy_host_bridge', 'host_agent']
      : getRegisteredEnvText('CODEX_CLI') ||
          getRegisteredEnvText('CODEX_VERSION') ||
          getRegisteredEnvText('TERM_PROGRAM') === 'codex'
        ? ['codex_host_bridge', 'cursor_host_bridge', 'agy_host_bridge', 'host_agent']
        : getRegisteredEnvText('AGY_CLI') || getRegisteredEnvText('ANTIGRAVITY_CLI')
          ? ['agy_host_bridge', 'cursor_host_bridge', 'codex_host_bridge', 'host_agent']
          : ['host_agent', 'cursor_host_bridge', 'codex_host_bridge', 'agy_host_bridge'];
  if (requireHostBridge) return bridgePreference;
  return [
    ...bridgePreference,
    'local_flux',
    'comfyui',
    'gemini_image',
    'gemini_service',
    'llm_api',
  ];
}

export function resolveAvatarGenerationPaths(
  inputPhoto: string,
  outputPath: string
): {
  inputPhoto: string;
  outputPath: string;
} {
  return {
    inputPhoto: assertSafeRepositoryPath(pathResolver.resolve(inputPhoto), {
      allowMissingLeaf: true,
    }),
    outputPath: assertSafeRepositoryPath(pathResolver.resolve(outputPath), {
      allowMissingLeaf: true,
    }),
  };
}

/** PA-10 shared look for the whole set; `--style` replaces it. */
export const DEFAULT_AVATAR_STYLE =
  'friendly stylised illustration, soft cel shading, clean plain light background, head-and-shoulders portrait, centred, facing the viewer';

/** Per-expression suffix; every frame keeps the same framing so frames swap in place. */
export const AVATAR_EXPRESSION_PROMPTS: Record<AvatarExpression, string> = {
  neutral: 'calm, friendly neutral expression, mouth closed',
  joy: 'joyful expression with a warm open smile',
  thinking: 'thoughtful expression, eyes glancing slightly upward, mouth closed',
  listening: 'attentive listening expression, slight head tilt, gentle eye contact, mouth closed',
  speaking: 'speaking mid-sentence, relaxed face, mouth slightly open',
  mouth_open:
    'identical to the neutral reference image in framing, pose, lighting and expression, except the mouth is open as when saying "ah" (lip-sync frame)',
  blink:
    'identical to the neutral reference image in framing, pose, lighting and expression, except both eyes are closed (blink frame)',
};

export function buildAvatarPrompt(expression: AvatarExpression, style: string): string {
  const subject =
    expression === 'neutral'
      ? 'Create a stylised avatar of the person in the reference photo, keeping their recognisable features, hairstyle and skin tone.'
      : 'Create the same stylised avatar as the neutral reference image (same person, same style, same framing, same background) with a different expression.';
  return `${subject} Style: ${style}. Expression: ${AVATAR_EXPRESSION_PROMPTS[expression]}. No text, no watermark.`;
}

function referenceMimeType(filePath: string): string {
  if (safeExistsSync(filePath)) {
    const sniffed = sniffAvatarImageContentType(
      safeReadFile(filePath, { encoding: null }) as Buffer
    );
    if (sniffed) return sniffed;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function isHostHandoff(message: string): boolean {
  return (
    message.includes('HOST_AGENT_IMAGE_GENERATION_REQUIRED') ||
    message.includes('HOST_BRIDGE_IMAGE_GENERATION_REQUIRED')
  );
}

export interface AvatarSetOptions {
  /** Absolute path of the user's photo (personal/profile tier or transient capture). */
  inputPhoto: string;
  /** Absolute output directory (CLI default `<profileRoot>/avatar/draft`, adopted via settings). */
  outputDir: string;
  style: string;
  expressions: AvatarExpression[];
  mode: ImageGenerationMode;
  providerPreference: string[];
  consent?: ImageEgressConsent;
  print?: (value: unknown) => void;
  generate?: (request: ImageGenerationRequest) => Promise<ImageGenerationResult>;
}

export interface AvatarSetResult {
  status: 'succeeded' | 'handoff' | 'failed';
  output_dir: string;
  images: Partial<Record<AvatarExpression, string>>;
  provider_id?: string;
  profile_path?: string;
  handoffs: Array<{ expression: AvatarExpression; message: string }>;
  message?: string;
  /** `--plan` only: the provider a run would use (consent not yet given). */
  plan?: ImageGenerationPlan | null;
}

/** Hand-off manifest listing every pending frame (repo paths only, never photo bytes). */
export const AVATAR_HANDOFF_MANIFEST = 'active/shared/tmp/avatar-set-handoff.json';

/**
 * Frames are generated into this sibling of the output directory and only
 * copied over it once the whole set exists (M2): a failed run never leaves a
 * partial or mixed set where the preview / "Use this avatar" would read it.
 */
export function avatarStagingDir(outputDir: string): string {
  return path.join(path.dirname(outputDir), `${path.basename(outputDir)}.pending`);
}

function readHandoffManifest(manifestPath: string): Record<string, unknown> | null {
  try {
    const parsed = readJsonIfPresent<unknown>(manifestPath);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Replace the set in `outputDir` with the staged one: the old profile goes
 * first (the old set stops being valid), frames are copied, frames the new
 * set does not name are removed, and the new profile is written last.
 */
function commitStagedAvatarSet(
  stagingDir: string,
  outputDir: string,
  profile: PersonalAvatarProfileFile
): string {
  if (!safeExistsSync(outputDir)) safeMkdir(outputDir, { recursive: true });
  const profilePath = path.join(outputDir, AVATAR_PROFILE_FILENAME);
  if (safeExistsSync(profilePath)) safeUnlinkSync(profilePath);
  const names = new Set(Object.values(profile.images));
  for (const expression of AVATAR_EXPRESSIONS) {
    const stale = path.join(outputDir, `${expression}.png`);
    if (!names.has(`${expression}.png`) && safeExistsSync(stale)) safeUnlinkSync(stale);
  }
  for (const name of names) {
    safeCopyFileSync(path.join(stagingDir, name), path.join(outputDir, name));
  }
  safeWriteFile(profilePath, JSON.stringify(profile, null, 2), { encoding: 'utf8' });
  safeRmSync(stagingDir, { recursive: true, force: true });
  return profilePath;
}

/**
 * PA-10: generate neutral from the photo, then every other expression from the
 * photo (subject) + the generated neutral (consistency), with one shared style.
 * Host-bridge hand-offs are collected for every frame and reported together so
 * the host agent can produce the whole set in one pass before the rerun.
 *
 * Frames land in {@link avatarStagingDir} first. A fresh run clears it; the
 * rerun after a host hand-off keeps it (the manifest names it) so the frames
 * the host saved are picked up. The output directory changes only on success.
 */
export async function generateAvatarSet(options: AvatarSetOptions): Promise<AvatarSetResult> {
  const print = options.print ?? (() => undefined);
  const generate = options.generate ?? generateImage;
  const expressions: AvatarExpression[] = [
    'neutral',
    ...options.expressions.filter((expression) => expression !== 'neutral'),
  ];
  const stagingDir = avatarStagingDir(options.outputDir);
  const stagingRel = pathResolver.toRepoRelative(stagingDir);
  const outputRel = pathResolver.toRepoRelative(options.outputDir);
  const manifestPath = pathResolver.resolve(AVATAR_HANDOFF_MANIFEST);
  const resumingHandoff = readHandoffManifest(manifestPath)?.staging_dir === stagingRel;
  if (!resumingHandoff) safeRmSync(stagingDir, { recursive: true, force: true });
  if (!safeExistsSync(stagingDir)) safeMkdir(stagingDir, { recursive: true });

  const photoRef: ImageReference = {
    path: options.inputPhoto,
    mimeType: referenceMimeType(options.inputPhoto),
    role: 'subject',
  };
  const neutralPath = path.join(stagingDir, 'neutral.png');
  const images: Partial<Record<AvatarExpression, string>> = {};
  const handoffs: AvatarSetResult['handoffs'] = [];
  let preference = options.providerPreference;
  let providerId: string | undefined;

  try {
    for (const expression of expressions) {
      const targetPath = path.join(stagingDir, `${expression}.png`);
      const references: ImageReference[] =
        expression === 'neutral'
          ? [photoRef]
          : [
              photoRef,
              {
                path: neutralPath,
                mimeType: referenceMimeType(neutralPath),
                role: 'consistency',
              },
            ];
      print(`Generating ${expression} expression -> ${targetPath}`);
      try {
        const result = await generate({
          prompt: buildAvatarPrompt(expression, options.style),
          targetPath,
          aspectRatio: '1:1',
          mode: options.mode,
          providerPreference: preference,
          referenceImages: references,
          ...(options.consent ? { egressConsent: options.consent } : {}),
        });
        if (result.status === 'failed') {
          throw new Error(result.error || `${expression} generation failed`);
        }
        images[expression] = `${expression}.png`;
        if (!providerId && result.provider) {
          providerId = result.provider;
          // Keep the whole set on the provider that produced neutral.
          preference = [providerId, ...preference.filter((id) => id !== providerId)];
        }
        if (expression === 'neutral') {
          print(`Avatar generated successfully at: ${result.path ?? targetPath}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isHostHandoff(message)) throw error;
        handoffs.push({ expression, message });
      }
    }
  } catch (error) {
    // A failed run leaves nothing behind: no staged frames, no stale hand-off.
    safeRmSync(stagingDir, { recursive: true, force: true });
    if (resumingHandoff && safeExistsSync(manifestPath)) safeUnlinkSync(manifestPath);
    throw error;
  }

  if (handoffs.length > 0) {
    const photoRel = pathResolver.toRepoRelative(options.inputPhoto);
    safeMkdir(path.dirname(manifestPath), { recursive: true });
    safeWriteFile(
      manifestPath,
      JSON.stringify(
        {
          kind: 'avatar-set-handoff',
          output_dir: outputRel,
          staging_dir: stagingRel,
          style: options.style,
          order: 'Generate neutral first; every other frame uses it as its consistency reference.',
          frames: handoffs.map((handoff) => ({
            expression: handoff.expression,
            prompt: buildAvatarPrompt(handoff.expression, options.style),
            target_path: `${stagingRel}/${handoff.expression}.png`,
            // Repo-relative paths + roles only: the host agent reads the files itself.
            reference_images:
              handoff.expression === 'neutral'
                ? [{ path: photoRel, role: 'subject' }]
                : [
                    { path: photoRel, role: 'subject' },
                    { path: `${stagingRel}/neutral.png`, role: 'consistency' },
                  ],
          })),
        },
        null,
        2
      ),
      { encoding: 'utf8' }
    );
    const code = handoffs[0]!.message.split(':')[0];
    const message = `${code}: the host agent must generate ${handoffs.length} avatar frame(s) (${handoffs
      .map((handoff) => handoff.expression)
      .join(
        ', '
      )}) listed in ${AVATAR_HANDOFF_MANIFEST}, then rerun this command. First frame: ${handoffs[0]!.message}`;
    return { status: 'handoff', output_dir: outputRel, images, handoffs, message };
  }

  const profile: PersonalAvatarProfileFile = {
    version: 1,
    images: images as PersonalAvatarProfileFile['images'],
    mouth: { ...DEFAULT_AVATAR_MOUTH_ANCHOR },
    generated_at: nowIso(),
    provider_id: providerId ?? 'unknown',
    style: options.style,
  };
  const profilePath = commitStagedAvatarSet(stagingDir, options.outputDir, profile);
  if (safeExistsSync(manifestPath)) safeUnlinkSync(manifestPath);
  return {
    status: 'succeeded',
    output_dir: outputRel,
    images,
    provider_id: profile.provider_id,
    profile_path: pathResolver.toRepoRelative(profilePath),
    handoffs,
  };
}

function parseExpressions(value: string | boolean | undefined): AvatarExpression[] {
  if (typeof value !== 'string' || !value.trim()) return [...DEFAULT_GENERATED_AVATAR_EXPRESSIONS];
  const requested = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const unknown = requested.filter(
    (entry) => !(AVATAR_EXPRESSIONS as readonly string[]).includes(entry)
  );
  if (unknown.length > 0) {
    throw new ScriptExitError(1, `Unknown expression(s): ${unknown.join(', ')}`);
  }
  return requested as AvatarExpression[];
}

function consentFromArgs(args: Record<string, string | boolean>): ImageEgressConsent | undefined {
  const providerId = args['consent-provider'];
  if (typeof providerId !== 'string' || !providerId.trim()) return undefined;
  const grantedBy = args['consent-granted-by'];
  if (typeof grantedBy !== 'string' || !grantedBy.trim()) {
    throw new ScriptExitError(1, '--consent-provider requires --consent-granted-by');
  }
  return createImageEgressConsent({
    providerId,
    grantedBy,
    ...(typeof args['consent-granted-at'] === 'string'
      ? { grantedAt: args['consent-granted-at'] }
      : {}),
  });
}

/** Machine-readable line for callers that spawn this script (concierge job). */
export const AVATAR_SET_RESULT_PREFIX = 'AVATAR_SET_RESULT ';
/** `--plan` output: which provider would receive the photo, before any consent. */
export const AVATAR_PLAN_PREFIX = 'AVATAR_PLAN ';

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  generate?: AvatarSetOptions['generate']
): Promise<AvatarSetResult> {
  const args = parseArgs(argv);
  // Default: the registered reference photo (`<profileRoot>/avatar.png`, as the
  // concierge upload and the create-my-avatar pipeline store it).
  const inputPhoto =
    typeof args['input-photo'] === 'string'
      ? args['input-photo']
      : path.join(resolveActiveProfileRoot(), 'avatar.png');
  const legacyOutputPath =
    typeof args['output-path'] === 'string' ? args['output-path'] : undefined;
  const outputDir =
    typeof args['output-dir'] === 'string'
      ? args['output-dir']
      : // A new set never overwrites the one in use: it waits in draft/ until adopted.
        personalAvatarDir(resolveActiveProfileRoot(), 'draft');
  // `--prompt` (v1) was the whole prompt; it now seeds the shared style.
  const style =
    typeof args.style === 'string'
      ? args.style
      : typeof args.prompt === 'string'
        ? args.prompt
        : DEFAULT_AVATAR_STYLE;
  const mode = (typeof args.mode === 'string' ? args.mode : 'balanced') as ImageGenerationMode;
  const requireHostBridge = Boolean(args['require-host-bridge']);
  const preference = splitPreference(
    args['bridge-preference'],
    deriveAutoPreference(requireHostBridge)
  );

  const resolvedInput = resolveAvatarGenerationPaths(inputPhoto, inputPhoto).inputPhoto;
  const resolvedOutputDir = assertSafeRepositoryPath(pathResolver.resolve(outputDir), {
    allowMissingLeaf: true,
  });
  const resolvedLegacyOutput = legacyOutputPath
    ? resolveAvatarGenerationPaths(inputPhoto, legacyOutputPath).outputPath
    : undefined;

  if (!safeExistsSync(resolvedInput)) {
    throw new ScriptExitError(1, `Input face photo not found at: ${resolvedInput}`);
  }

  if (args.plan === true) {
    // Nothing is generated or sent: the consent prompt needs the provider name first.
    const plan = await planImageGeneration({
      prompt: buildAvatarPrompt('neutral', style),
      aspectRatio: '1:1',
      mode,
      providerPreference: preference,
      referenceImages: [
        { path: resolvedInput, mimeType: referenceMimeType(resolvedInput), role: 'subject' },
      ],
    });
    print(`${AVATAR_PLAN_PREFIX}${JSON.stringify({ plan })}`);
    return {
      status: 'succeeded',
      output_dir: pathResolver.toRepoRelative(resolvedOutputDir),
      images: {},
      handoffs: [],
      plan,
    };
  }

  print(`Generating avatar based on: ${resolvedInput}`);
  print(`Provider preference: ${preference.join(' -> ')}`);

  // A transient capture (under active/shared/tmp) is removed on every terminal
  // status — success and failure. A host hand-off keeps it until the rerun
  // completes, because the host agent still has to read it. A profile-tier
  // photo is never removed.
  const cleanupInput = (): void => {
    if (args['cleanup-input'] !== true) return;
    const tmpRoot = pathResolver.resolve('active/shared/tmp');
    if (resolvedInput.startsWith(`${tmpRoot}${path.sep}`) && safeExistsSync(resolvedInput)) {
      safeUnlinkSync(resolvedInput);
    }
  };

  let result: AvatarSetResult;
  try {
    result = await generateAvatarSet({
      inputPhoto: resolvedInput,
      outputDir: resolvedOutputDir,
      style,
      expressions: parseExpressions(args.expressions),
      mode,
      providerPreference: preference,
      consent: consentFromArgs(args),
      print,
      generate,
    });
  } catch (err: unknown) {
    cleanupInput();
    if (err instanceof ScriptExitError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const failed: AvatarSetResult = {
      status: 'failed',
      output_dir: pathResolver.toRepoRelative(resolvedOutputDir),
      images: {},
      handoffs: [],
      message,
    };
    print(`${AVATAR_SET_RESULT_PREFIX}${JSON.stringify(failed)}`);
    throw new ScriptExitError(1, `Avatar generation failed: ${message}`, false, failed);
  }

  print(`${AVATAR_SET_RESULT_PREFIX}${JSON.stringify(result)}`);
  if (result.status === 'handoff') {
    throw new ScriptExitError(
      100,
      result.message ?? 'HOST_BRIDGE_IMAGE_GENERATION_REQUIRED',
      false,
      result
    );
  }

  if (resolvedLegacyOutput) {
    // v1 callers (the register_avatar step) read the single avatar from --output-path.
    safeMkdir(path.dirname(resolvedLegacyOutput), { recursive: true });
    safeCopyFileSync(path.join(resolvedOutputDir, 'neutral.png'), resolvedLegacyOutput);
  }
  cleanupInput();
  print(`Avatar set generated at: ${result.output_dir}`);
  return result;
}

export const runGenerateAvatar = defineScript({
  name: 'avatar:generate',
  flags: [],
  run: async ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'generate_avatar.ts') ||
  isDirectScript(import.meta.url, 'generate_avatar.js')
)
  void runGenerateAvatar();
