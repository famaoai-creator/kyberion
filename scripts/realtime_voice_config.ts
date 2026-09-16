import {
  getRealtimeVoiceConversationPreferences,
  getRealtimeVoiceConversationPreferencesPath,
  resetRealtimeVoiceConversationPreferences,
  saveRealtimeVoiceConversationPreferences,
  type RealtimeVoiceConversationPreferences,
  type RealtimeVoiceDeliveryMode,
  type RealtimeVoiceLatencyProfile,
  type RealtimeVoicePersonalVoiceMode,
  type RealtimeVoiceReasoningEffort,
  type RealtimeVoiceReasoningTier,
} from '@agent/core/realtime-voice-preferences';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

type Command = 'show' | 'set' | 'reset' | 'help';

const HELP = `Usage:
  pnpm voice:conversation-config show [--json]
  pnpm voice:conversation-config set [options] [--dry-run]
  pnpm voice:conversation-config reset [--dry-run]

Set options:
  --voice-profile-id <id>       TTS voice profile used by new sessions
  --language <ja|en>            Conversation language
  --assistant-name <name>       Display/spoken assistant name
  --system-prompt <text>        Spoken conversation persona prompt
  --latency-profile <name>      low_latency or balanced
  --reasoning-model <id>        Exact provider model, e.g. gpt-5.6-luna
  --reasoning-model-tier <tier> fast, standard, or deep
  --reasoning-effort <level>    low, medium, or high
  --personal-voice-mode <mode>  allow_fallback or require_personal_voice
  --delivery-mode <mode>        none, artifact, or artifact_and_playback

Precedence at runtime: CLI flag > this profile preference > built-in default.
Voice profile changes apply to a new session id; model/effort changes apply to the next turn.`;

interface ParsedArgs {
  command: Command;
  json: boolean;
  dryRun: boolean;
  patch: Partial<Omit<RealtimeVoiceConversationPreferences, 'version' | 'updated_at'>>;
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(input: string[], inheritedDryRun = false, inheritedJson = false): ParsedArgs {
  const args = stripSharedScriptFlags(input);
  const json = inheritedJson || input.includes('--json') || args.includes('--json');
  const rawCommand = args[0] || 'show';
  if (rawCommand === '--help' || rawCommand === '-h' || rawCommand === 'help') {
    return { command: 'help', json, dryRun: false, patch: {} };
  }
  if (!['show', 'set', 'reset'].includes(rawCommand)) {
    throw new Error(`unknown realtime voice config command '${rawCommand}'`);
  }

  const parsed: ParsedArgs = {
    command: rawCommand as Exclude<Command, 'help'>,
    json,
    dryRun: inheritedDryRun || args.includes('--dry-run'),
    patch: {},
  };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--json' || flag === '--dry-run') continue;
    const value = valueAfter(args, index, flag);
    index += 1;
    switch (flag) {
      case '--voice-profile-id':
        parsed.patch.voice_profile_id = value;
        break;
      case '--language':
        parsed.patch.language = value;
        break;
      case '--assistant-name':
        parsed.patch.assistant_name = value;
        break;
      case '--system-prompt':
        parsed.patch.system_prompt = value;
        break;
      case '--latency-profile':
        if (value !== 'low_latency' && value !== 'balanced')
          throw new Error('--latency-profile must be low_latency or balanced');
        parsed.patch.latency_profile = value as RealtimeVoiceLatencyProfile;
        break;
      case '--reasoning-model':
        parsed.patch.reasoning_model = value;
        break;
      case '--reasoning-model-tier':
        if (!['fast', 'standard', 'deep'].includes(value))
          throw new Error('--reasoning-model-tier must be fast, standard, or deep');
        parsed.patch.reasoning_model_tier = value as RealtimeVoiceReasoningTier;
        break;
      case '--reasoning-effort':
        if (!['low', 'medium', 'high'].includes(value))
          throw new Error('--reasoning-effort must be low, medium, or high');
        parsed.patch.reasoning_effort = value as RealtimeVoiceReasoningEffort;
        break;
      case '--personal-voice-mode':
        if (!['allow_fallback', 'require_personal_voice'].includes(value))
          throw new Error('--personal-voice-mode must be allow_fallback or require_personal_voice');
        parsed.patch.personal_voice_mode = value as RealtimeVoicePersonalVoiceMode;
        break;
      case '--delivery-mode':
        if (!['none', 'artifact', 'artifact_and_playback'].includes(value))
          throw new Error('--delivery-mode must be none, artifact, or artifact_and_playback');
        parsed.patch.delivery_mode = value as RealtimeVoiceDeliveryMode;
        break;
      default:
        throw new Error(`unknown option '${flag}'`);
    }
  }
  return parsed;
}

function formatPreferences(preferences: RealtimeVoiceConversationPreferences): string {
  return [
    `voice_profile_id=${preferences.voice_profile_id}`,
    `language=${preferences.language}`,
    `assistant_name=${preferences.assistant_name}`,
    `latency_profile=${preferences.latency_profile}`,
    `reasoning_model=${preferences.reasoning_model || '(provider default)'}`,
    `reasoning_model_tier=${preferences.reasoning_model_tier || '(derived)'}`,
    `reasoning_effort=${preferences.reasoning_effort || '(derived)'}`,
    `personal_voice_mode=${preferences.personal_voice_mode}`,
    `delivery_mode=${preferences.delivery_mode}`,
    `path=${getRealtimeVoiceConversationPreferencesPath()}`,
  ].join('\n');
}

export function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined,
  options: { dryRun?: boolean; json?: boolean } = {}
): void {
  const parsed = parseArgs(argv, options.dryRun === true, options.json === true);
  if (parsed.command === 'help') return print(HELP);
  if (parsed.command === 'show') {
    const preferences = getRealtimeVoiceConversationPreferences();
    return print(
      parsed.json
        ? { preferences, path: getRealtimeVoiceConversationPreferencesPath() }
        : formatPreferences(preferences)
    );
  }
  if (parsed.command === 'reset') {
    if (parsed.dryRun) {
      return print({
        dry_run: true,
        preferences: getRealtimeVoiceConversationPreferences(),
        reset_to: 'built-in defaults',
        path: getRealtimeVoiceConversationPreferencesPath(),
      });
    }
    const preferences = resetRealtimeVoiceConversationPreferences();
    return print(
      parsed.json
        ? { preferences, path: getRealtimeVoiceConversationPreferencesPath() }
        : formatPreferences(preferences)
    );
  }
  if (!Object.keys(parsed.patch).length) {
    throw new Error('set requires at least one preference option');
  }
  if (parsed.dryRun) {
    return print({
      dry_run: true,
      current: getRealtimeVoiceConversationPreferences(),
      patch: parsed.patch,
      path: getRealtimeVoiceConversationPreferencesPath(),
    });
  }
  const preferences = saveRealtimeVoiceConversationPreferences(parsed.patch);
  return print(
    parsed.json
      ? { preferences, path: getRealtimeVoiceConversationPreferencesPath() }
      : formatPreferences(preferences)
  );
}

const script = defineScript({
  name: 'voice:conversation-config',
  run: ({ argv, dryRun, json, print }) => main(argv, print, { dryRun, json }),
});

if (
  isDirectScript(import.meta.url, 'realtime_voice_config.ts') ||
  isDirectScript(import.meta.url, 'realtime_voice_config.js')
) {
  void script();
}
