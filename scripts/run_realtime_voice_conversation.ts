import {
  createStandardYargs,
  installReasoningBackends,
  runRealtimeVoiceConversationTurn,
} from '@agent/core';

async function main() {
  await installReasoningBackends();

  const argv = await createStandardYargs()
    .option('session-id', { type: 'string', demandOption: true })
    .option('audio', { type: 'string', demandOption: true })
    .option('profile-id', { type: 'string' })
    .option('language', { type: 'string' })
    .option('assistant-name', { type: 'string', default: 'Kyberion' })
    .option('system-prompt', { type: 'string' })
    .option('surface-id', { type: 'string', default: 'presence-studio' })
    .option('source-id', { type: 'string', default: 'local-mic' })
    .option('delivery-mode', {
      type: 'string',
      choices: ['none', 'artifact', 'artifact_and_playback'] as const,
      default: 'artifact_and_playback',
    })
    .option('personal-voice-mode', {
      type: 'string',
      choices: ['allow_fallback', 'require_personal_voice'] as const,
      default: 'require_personal_voice',
    })
    .parse();

  const result = await runRealtimeVoiceConversationTurn({
    sessionId: String(argv['session-id']),
    audioPath: String(argv.audio),
    ...(argv['profile-id'] ? { profileId: String(argv['profile-id']) } : {}),
    ...(argv.language ? { language: String(argv.language) } : {}),
    assistantName: String(argv['assistant-name']),
    ...(argv['system-prompt'] ? { systemPrompt: String(argv['system-prompt']) } : {}),
    surfaceId: String(argv['surface-id']),
    sourceId: String(argv['source-id']),
    deliveryMode: argv['delivery-mode'] as 'none' | 'artifact' | 'artifact_and_playback',
    personalVoiceMode: argv['personal-voice-mode'] as 'allow_fallback' | 'require_personal_voice',
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
