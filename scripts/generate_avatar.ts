import * as path from 'node:path';
import { generateImage } from '../libs/core/image-generation-bridge.js';
import type { ImageGenerationMode } from '../libs/core/image-generation-types.js';
import { safeExistsSync } from '../libs/core/secure-io.js';

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
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

  const resolvedInput = path.resolve(inputPhoto);
  const resolvedOutput = path.resolve(outputPath);

  if (!safeExistsSync(resolvedInput)) {
    console.error(`Input face photo not found at: ${resolvedInput}`);
    process.exit(1);
  }

  console.log(`Generating avatar based on: ${resolvedInput}`);
  console.log(`Provider preference: ${preference.join(' -> ')}`);

  try {
    const result = await generateImage({
      prompt,
      targetPath: resolvedOutput,
      aspectRatio: '1:1',
      mode,
      providerPreference: preference,
    });

    console.log(`Avatar generated successfully at: ${result.path}`);
  } catch (err: any) {
    const message = err?.message || String(err);
    if (
      message.includes('HOST_AGENT_IMAGE_GENERATION_REQUIRED') ||
      message.includes('HOST_BRIDGE_IMAGE_GENERATION_REQUIRED')
    ) {
      console.error(message);
      process.exit(100);
    }
    console.error(`Avatar generation failed: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
