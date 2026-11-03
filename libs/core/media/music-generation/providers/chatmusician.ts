import * as path from 'node:path';
import { safeExistsSync, safeExecResult, safeMkdir, safeWriteFile } from '../../../secure-io.js';
import { commandLocatorAdapter } from '../../../platform-command-adapters.js';
import { probeToolRuntime } from '../../../tool/tool-runtime-registry.js';
import { isAppleSilicon } from '../../../platform.js';
import { resolveChatMusicianGenerationPolicy } from '../../music-generation-policy.js';
import type {
  MusicGenerationProvider,
  MusicGenerationRequest,
  MusicGenerationResult,
} from '../../music-generation-types.js';
import {
  getFallbackTargetPath,
  ensureWavTargetPath,
  patchUvxPackageSpec,
} from '../provider-support.js';

/**
 * Extract an ABC notation block from free-form LLM output. ChatMusician
 * answers with prose around the score; the score starts at the first `X:`
 * reference-number header.
 */
export function extractAbcNotation(output: string): string | null {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^X:\s*\d/.test(line.trim()));
  if (start < 0) return null;
  const abc = lines.slice(start).join('\n').trim();
  return abc && /^(T|M|L|R|K):/m.test(abc) ? abc : null;
}

function locateSystemCommand(command: string): string | null {
  const found = commandLocatorAdapter.locate(command);
  return found.length > 0 ? found[0]! : null;
}

async function runChatMusicianGeneration(
  request: MusicGenerationRequest,
  startedAt: number,
  providerId: string
): Promise<MusicGenerationResult> {
  const failed = (error: string): MusicGenerationResult => ({
    status: 'failed',
    provider: providerId,
    elapsedMs: Date.now() - startedAt,
    error,
  });

  const outputPath = ensureWavTargetPath(getFallbackTargetPath(request));
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  const policy = resolveChatMusicianGenerationPolicy();
  const prompt = request.prompt.trim();
  if (!prompt) return failed('chatmusician_prompt_required');

  // Cheap static preconditions first: never burn a full LLM composition run
  // when the render toolchain is missing (explicit preferences bypass
  // isAvailable, so this check must live on the generate path too).
  if (!locateSystemCommand('abc2midi')) return failed('chatmusician_abc2midi_install_required');
  if (!locateSystemCommand('fluidsynth')) return failed('chatmusician_fluidsynth_install_required');
  if (!policy.soundfont || !safeExistsSync(policy.soundfont)) {
    return failed('chatmusician_soundfont_missing');
  }

  const runtime = probeToolRuntime('chatmusician_mlx', 'trial');
  if (runtime.selected_action === 'install') {
    return failed('chatmusician_mlx_install_required');
  }
  const runner = runtime.selected_backend || runtime.trial_backend;
  let llmArgs = [...(runner.args || [])];
  if (runner.command === 'uvx') {
    llmArgs = patchUvxPackageSpec(llmArgs, policy.packageSpec);
  }

  // Stage 1: compose ABC notation with the ChatMusician LLM. durationSec
  // cannot clamp symbolic composition, so it rides along as a soft hint.
  const durationHint =
    typeof request.durationSec === 'number' && Number.isFinite(request.durationSec)
      ? ` Aim for approximately ${Math.round(request.durationSec)} seconds of music.`
      : '';
  const abcPrompt =
    `Using ABC notation, compose a well-structured instrumental score for the following brief. ` +
    `Output the ABC notation (X:/T:/M:/L:/K: headers followed by the tune) and keep prose minimal.${durationHint}\n${prompt}`;
  llmArgs.push(
    '--model',
    policy.model || policy.hfRepo,
    '--prompt',
    abcPrompt,
    '--max-tokens',
    String(policy.maxTokens),
    '--temp',
    String(policy.temperature)
  );
  const seed = request.seed?.trim() || policy.seed;
  if (seed) {
    llmArgs.push('--seed', seed);
  }
  const llmResult = safeExecResult(runner.command, llmArgs, {
    timeoutMs: policy.timeoutMs,
    maxOutputMB: 10,
  });
  if (llmResult.status !== 0 || llmResult.error) {
    return failed(
      llmResult.stderr?.trim() ||
        llmResult.stdout?.trim() ||
        llmResult.error?.message ||
        'chatmusician_compose_failed'
    );
  }
  const abc = extractAbcNotation(llmResult.stdout ?? '');
  if (!abc) return failed('chatmusician_abc_parse_failed');

  const stem = outputPath.slice(0, -'.wav'.length);
  const abcPath = `${stem}.abc`;
  const midiPath = `${stem}.midi`;
  safeWriteFile(abcPath, abc + '\n');

  // Stage 2: ABC -> MIDI.
  if (!locateSystemCommand('abc2midi')) return failed('chatmusician_abc2midi_install_required');
  // Sub-stage budget: bounded by the policy timeout, never more than 5 min.
  const convertBudgetMs = Math.min(5 * 60 * 1000, policy.timeoutMs);
  const abc2midiDirect = safeExecResult('abc2midi', [abcPath, '-o', midiPath], {
    timeoutMs: convertBudgetMs,
    maxOutputMB: 10,
  });
  let renderedMidi: string | null = safeExistsSync(midiPath) ? midiPath : null;
  let legacyStderr = '';
  if (!renderedMidi) {
    // Older abcmidi builds ignore -o; fall back to the default output name.
    const legacy = safeExecResult('abc2midi', [abcPath], {
      timeoutMs: convertBudgetMs,
      maxOutputMB: 10,
    });
    legacyStderr = legacy.stderr?.trim() || '';
    renderedMidi =
      [`${stem}.midi`, `${stem}.mid`].find((candidate) => safeExistsSync(candidate)) || null;
    if (!renderedMidi) {
      return failed(legacyStderr || abc2midiDirect.stderr?.trim() || 'chatmusician_midi_missing');
    }
  }

  // Stage 3: MIDI -> WAV via a SoundFont synthesizer.
  if (!locateSystemCommand('fluidsynth')) return failed('chatmusician_fluidsynth_install_required');
  if (!policy.soundfont || !safeExistsSync(policy.soundfont)) {
    return failed('chatmusician_soundfont_missing');
  }
  // NB: fluidsynth parses options positionally — every flag must precede
  // the SoundFont and MIDI file arguments.
  const render = safeExecResult(
    'fluidsynth',
    ['-ni', '-F', outputPath, '-r', '44100', policy.soundfont, renderedMidi],
    { timeoutMs: policy.timeoutMs, maxOutputMB: 20 }
  );
  if (render.status !== 0 || render.error) {
    return failed(render.stderr?.trim() || 'chatmusician_render_failed');
  }
  if (!safeExistsSync(outputPath)) return failed('chatmusician_output_missing');

  return {
    status: 'succeeded',
    provider: providerId,
    path: outputPath,
    elapsedMs: Date.now() - startedAt,
  };
}

export class ChatMusicianGenerationProvider implements MusicGenerationProvider {
  readonly id = 'chatmusician_mlx';
  readonly costTier = 'self_hosted';
  readonly dataPolicy = 'local_only';
  readonly executionLocality = 'local';
  readonly outputFormats = ['wav'] as const;
  /** ABC scores render through a GM SoundFont — instrumental only. */
  readonly supportsVocals = false;

  async isAvailable(): Promise<boolean> {
    try {
      if (!isAppleSilicon()) return false;
      if (probeToolRuntime('chatmusician_mlx').selected_action === 'install') return false;
      const policy = resolveChatMusicianGenerationPolicy();
      return (
        locateSystemCommand('abc2midi') !== null &&
        locateSystemCommand('fluidsynth') !== null &&
        Boolean(policy.soundfont && safeExistsSync(policy.soundfont))
      );
    } catch {
      // Availability probes must never throw — an unprovable toolchain
      // simply means the provider cannot run here.
      return false;
    }
  }

  async generate(request: MusicGenerationRequest): Promise<MusicGenerationResult> {
    return await runChatMusicianGeneration(request, Date.now(), this.id);
  }
}
