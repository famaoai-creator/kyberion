import { generateImage } from '@agent/core/image-generation-bridge';
import type { ImageGenerationMode } from '@agent/core/image-generation-types';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
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
  if (trimmed === 'host') return ['host_agent', 'codex_host_bridge', 'agy_host_bridge'];
  if (trimmed === 'codex') return ['codex_host_bridge', 'host_agent', 'agy_host_bridge'];
  if (trimmed === 'agy') return ['agy_host_bridge', 'host_agent', 'codex_host_bridge'];
  if (trimmed === 'local') return ['local_flux', 'comfyui', 'gemini_service', 'llm_api'];
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function deriveAutoPreference(requireHostBridge: boolean): string[] {
  const bridgePreference =
    process.env.CODEX_CLI || process.env.CODEX_VERSION || process.env.TERM_PROGRAM === 'codex'
      ? ['codex_host_bridge', 'agy_host_bridge', 'host_agent']
      : process.env.AGY_CLI || process.env.ANTIGRAVITY_CLI
        ? ['agy_host_bridge', 'codex_host_bridge', 'host_agent']
        : ['host_agent', 'codex_host_bridge', 'agy_host_bridge'];
  if (requireHostBridge) return bridgePreference;
  return [...bridgePreference, 'local_flux', 'comfyui', 'gemini_service', 'llm_api'];
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

export async function main(argv: string[] = [], print: (value: unknown) => void = () => undefined) {
  const args = parseArgs(argv);
  const inputPhoto =
    typeof args['input-photo'] === 'string'
      ? args['input-photo']
      : 'active/shared/tmp/user_face.jpg';
  const outputPath =
    typeof args['output-path'] === 'string' ? args['output-path'] : 'active/shared/tmp/avatar.png';
  const prompt =
    typeof args.prompt === 'string'
      ? args.prompt
      : 'A highly detailed 3D Pixar style avatar, portrait, clean background, based on user face photo';
  const mode = (typeof args.mode === 'string' ? args.mode : 'balanced') as ImageGenerationMode;
  const requireHostBridge = Boolean(args['require-host-bridge']);
  const preference = splitPreference(
    args['bridge-preference'],
    deriveAutoPreference(requireHostBridge)
  );

  const resolvedPaths = resolveAvatarGenerationPaths(inputPhoto, outputPath);
  const resolvedInput = resolvedPaths.inputPhoto;
  const resolvedOutput = resolvedPaths.outputPath;

  if (!safeExistsSync(resolvedInput)) {
    throw new ScriptExitError(1, `Input face photo not found at: ${resolvedInput}`);
  }

  print(`Generating avatar based on: ${resolvedInput}`);
  print(`Provider preference: ${preference.join(' -> ')}`);

  try {
    const result = await generateImage({
      prompt,
      targetPath: resolvedOutput,
      aspectRatio: '1:1',
      mode,
      providerPreference: preference,
    });

    print(`Avatar generated successfully at: ${result.path}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('HOST_AGENT_IMAGE_GENERATION_REQUIRED') ||
      message.includes('HOST_BRIDGE_IMAGE_GENERATION_REQUIRED')
    ) {
      throw new ScriptExitError(100, message);
    }
    throw new ScriptExitError(1, `Avatar generation failed: ${message}`);
  }
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
