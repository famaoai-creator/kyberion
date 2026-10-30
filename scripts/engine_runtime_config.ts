import {
  getEngineRuntimePreferences,
  getEngineRuntimePreferencesPath,
  resetEngineRuntimePreferences,
  previewEngineRuntimePreferences,
  saveEngineRuntimePreferences,
  type EngineRuntimePreferences,
  type EngineRuntimePreferencesPatch,
} from '@agent/core/voice/engine-runtime-preferences';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

import { hasCliFlag, hasHelpFlag } from './lib/cli-guard.js';

type Command = 'show' | 'set' | 'unset' | 'reset' | 'help';

const HELP = `Usage:
  pnpm voice:engine-config show [--json]
  pnpm voice:engine-config set [options] [--dry-run]
  pnpm voice:engine-config unset <option> [...] [--dry-run]
  pnpm voice:engine-config reset [--dry-run]

Set options (all take one value; use --flag=value for values starting with --):
  --ffmpeg-bin <path>           ffmpeg executable (env: KYBERION_FFMPEG_BIN)
  --ffprobe-bin <path>          ffprobe executable (KYBERION_FFPROBE_BIN)
  --python-bin <path>           Python interpreter (KYBERION_PYTHON_BIN)
  --audio-record-command <cmd>  Voice sample recorder command (KYBERION_AUDIO_RECORD_COMMAND)
  --playback-backend <id>       Audio playback backend id (KYBERION_AUDIO_PLAYBACK_BACKEND)
  --fluid-stt-command <cmd>     FluidAudio/Parakeet STT bridge (KYBERION_FLUID_AUDIO_STT_COMMAND)
  --streaming-stt-bridge <id>   Streaming STT bridge id (KYBERION_STREAMING_STT_BRIDGE)
  --streaming-tts-bridge <id>   Streaming TTS bridge id (KYBERION_STREAMING_TTS_BRIDGE)
  --agent-runtime-backend <m>   Agent launch mode: pipe or pane (KYBERION_AGENT_RUNTIME_BACKEND)
  --pane-runtime-provider <id>  Pane runtime provider id (KYBERION_AGENT_PANE_RUNTIME_PROVIDER)

Unset options: ffmpeg-bin, ffprobe-bin, python-bin, audio-record-command, playback-backend,
fluid-stt-command, streaming-stt-bridge, streaming-tts-bridge, agent-runtime-backend,
pane-runtime-provider.
Resolution order at consumers: env > this preference > managed/registry > built-in default.
Paths must be absolute; values may not contain NUL or line breaks.`;

interface ParsedArgs {
  command: Command;
  json: boolean;
  dryRun: boolean;
  patch: EngineRuntimePreferencesPatch;
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

const OPTIONS = {
  'ffmpeg-bin': 'ffmpeg_bin',
  'ffprobe-bin': 'ffprobe_bin',
  'python-bin': 'python_bin',
  'audio-record-command': 'audio_record_command',
  'playback-backend': 'audio_playback_backend',
  'fluid-stt-command': 'fluid_audio_stt_command',
  'streaming-stt-bridge': 'streaming_stt_bridge',
  'streaming-tts-bridge': 'streaming_tts_bridge',
  'agent-runtime-backend': 'agent_runtime_backend',
  'pane-runtime-provider': 'agent_pane_runtime_provider',
} as const;

function parseArgs(input: string[], inheritedDryRun = false, inheritedJson = false): ParsedArgs {
  const args = stripSharedScriptFlags(input);
  const json = inheritedJson || hasCliFlag(input, '--json') || hasCliFlag(args, '--json');
  const rawCommand = args[0] || 'show';
  if (
    rawCommand === '--help' ||
    rawCommand === '-h' ||
    rawCommand === 'help' ||
    hasHelpFlag(args)
  ) {
    return { command: 'help', json, dryRun: false, patch: {} };
  }
  if (!['show', 'set', 'unset', 'reset'].includes(rawCommand)) {
    throw new Error(`unknown engine config command '${rawCommand}'`);
  }
  const parsed: ParsedArgs = {
    command: rawCommand as Exclude<Command, 'help'>,
    json,
    dryRun: inheritedDryRun || hasCliFlag(input, '--dry-run'),
    patch: {},
  };
  if (rawCommand === 'unset') {
    if (args.length < 2) throw new Error('unset requires at least one option name');
    for (const field of args.slice(1)) {
      const option = field.replace(/^--/u, '');
      if (!Object.hasOwn(OPTIONS, option)) throw new Error('unknown engine option: ' + field);
      const key = OPTIONS[option as keyof typeof OPTIONS];
      parsed.patch = { ...parsed.patch, [key]: undefined };
    }
    return parsed;
  }
  if (rawCommand !== 'set' && args.length > 1) {
    throw new Error(rawCommand + ' does not accept preference options');
  }
  for (let index = 1; index < args.length; index += 1) {
    let flag = args[index];
    const separator = flag.indexOf('=');
    let value: string;
    if (separator > 0) {
      value = flag.slice(separator + 1);
      flag = flag.slice(0, separator);
    } else {
      value = valueAfter(args, index, flag);
      index += 1;
    }
    const option = flag.replace(/^--/u, '');
    if (!Object.hasOwn(OPTIONS, option)) throw new Error(`unknown option '${flag}'`);
    const key = OPTIONS[option as keyof typeof OPTIONS];
    if (key === 'agent_runtime_backend') {
      if (value !== 'pipe' && value !== 'pane')
        throw new Error('--agent-runtime-backend must be pipe or pane');
      parsed.patch.agent_runtime_backend = value;
    } else {
      parsed.patch = { ...parsed.patch, [key]: value };
    }
  }
  return parsed;
}

function render(preferences: EngineRuntimePreferences): string {
  return [
    `ffmpeg_bin=${preferences.ffmpeg_bin ?? '(not configured)'}`,
    `ffprobe_bin=${preferences.ffprobe_bin ?? '(not configured)'}`,
    `python_bin=${preferences.python_bin ?? '(not configured)'}`,
    `audio_record_command=${preferences.audio_record_command ?? '(not configured)'}`,
    `audio_playback_backend=${preferences.audio_playback_backend ?? '(not configured)'}`,
    `fluid_audio_stt_command=${preferences.fluid_audio_stt_command ?? '(not configured)'}`,
    `streaming_stt_bridge=${preferences.streaming_stt_bridge ?? '(not configured)'}`,
    `streaming_tts_bridge=${preferences.streaming_tts_bridge ?? '(not configured)'}`,
    `agent_runtime_backend=${preferences.agent_runtime_backend ?? '(not configured)'}`,
    `agent_pane_runtime_provider=${preferences.agent_pane_runtime_provider ?? '(not configured)'}`,
    `path=${getEngineRuntimePreferencesPath()}`,
  ].join('\n');
}

export async function runEngineRuntimeConfig(
  argv: string[],
  print: (value: unknown) => void = console.log,
  options: { dryRun?: boolean; json?: boolean } = {}
): Promise<void> {
  const parsed = parseArgs(argv, options.dryRun === true, options.json === true);
  if (parsed.command === 'help') return print(HELP);
  if (parsed.command === 'show') {
    return print(
      parsed.json ? getEngineRuntimePreferences() : render(getEngineRuntimePreferences())
    );
  }
  if (parsed.command === 'reset') {
    if (parsed.dryRun) {
      return print({
        dry_run: true,
        current: getEngineRuntimePreferences(),
        reset_to: 'empty defaults',
        path: getEngineRuntimePreferencesPath(),
      });
    }
    const preferences = resetEngineRuntimePreferences();
    return print(parsed.json ? preferences : render(preferences));
  }
  if (!Object.keys(parsed.patch).length) {
    throw new Error(parsed.command + ' requires at least one preference option');
  }
  if (parsed.dryRun) {
    return print({
      dry_run: true,
      current: getEngineRuntimePreferences(),
      patch: parsed.patch,
      ...(parsed.command === 'unset' ? { cleared: Object.keys(parsed.patch) } : {}),
      proposed: previewEngineRuntimePreferences(parsed.patch),
      path: getEngineRuntimePreferencesPath(),
    });
  }
  const preferences = saveEngineRuntimePreferences(parsed.patch);
  return print(parsed.json ? preferences : render(preferences));
}

const engineRuntimeConfigScript = defineScript({
  name: 'voice:engine-config',
  run: ({ argv, dryRun, json, print }) => runEngineRuntimeConfig(argv, print, { dryRun, json }),
});

if (
  isDirectScript(import.meta.url, 'engine_runtime_config.ts') ||
  isDirectScript(import.meta.url, 'engine_runtime_config.js')
) {
  void engineRuntimeConfigScript();
}
