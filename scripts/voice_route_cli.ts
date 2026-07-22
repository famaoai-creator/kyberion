#!/usr/bin/env node
import { handleAction } from '../libs/actuators/voice-actuator/src/index.js';

type Command = 'list' | 'probe' | 'test';

interface CliOptions {
  bus: 'blackhole' | 'stub';
  json: boolean;
  text?: string;
  language?: string;
  voiceProfileId?: string;
  sttBridgeId?: string;
  requestId?: string;
  inputDeviceUid?: string;
  outputDeviceUid?: string;
  deviceLabel?: string;
  confirm: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): { command: Command; options: CliOptions } {
  const command = (argv.shift() || 'list') as Command;
  if (!['list', 'probe', 'test'].includes(command)) {
    throw new Error(`unknown voice route command '${command}'`);
  }
  const options: CliOptions = { bus: 'blackhole', json: false, confirm: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case '--bus': {
        const next = value();
        if (next !== 'blackhole' && next !== 'stub')
          throw new Error('--bus must be blackhole or stub');
        options.bus = next;
        break;
      }
      case '--text':
        options.text = value();
        break;
      case '--language':
        options.language = value();
        break;
      case '--voice-profile-id':
        options.voiceProfileId = value();
        break;
      case '--stt-bridge-id':
        options.sttBridgeId = value();
        break;
      case '--request-id':
        options.requestId = value();
        break;
      case '--input-device-uid':
        options.inputDeviceUid = value();
        break;
      case '--output-device-uid':
        options.outputDeviceUid = value();
        break;
      case '--device-label':
        options.deviceLabel = value();
        break;
      case '--json':
        options.json = true;
        break;
      case '--confirm':
        options.confirm = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
        console.log('voice route commands: list | probe | test');
        console.log(
          'test requires --text and --confirm; BlackHole live test also requires KYBERION_LIVE_BLACKHOLE_TEST=1'
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option '${arg}'`);
    }
  }
  return { command, options };
}

function routeParams(options: CliOptions): Record<string, unknown> {
  return {
    bus: options.bus,
    ...(options.inputDeviceUid ? { input_device_uid: options.inputDeviceUid } : {}),
    ...(options.outputDeviceUid ? { output_device_uid: options.outputDeviceUid } : {}),
    ...(options.deviceLabel ? { expected_device_label: options.deviceLabel } : {}),
  };
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  let result: unknown;
  if (command === 'list') {
    result = await handleAction({
      action: 'list_audio_routes',
      params: { bus: options.bus },
    } as never);
  } else if (command === 'probe') {
    result = await handleAction({
      action: 'probe_audio_route',
      params: routeParams(options),
    } as never);
  } else {
    if (!options.text?.trim()) throw new Error('voice:loopback:test requires --text');
    if (!options.dryRun && !options.confirm) {
      throw new Error('voice:loopback:test requires explicit --confirm before audio output');
    }
    if (
      !options.dryRun &&
      options.bus === 'blackhole' &&
      process.env.KYBERION_LIVE_BLACKHOLE_TEST !== '1'
    ) {
      result = {
        status: 'blocked',
        action: 'verify_tts_loopback',
        reason_code: 'LIVE_BLACKHOLE_OPT_IN_REQUIRED',
        operator_action:
          'Set KYBERION_LIVE_BLACKHOLE_TEST=1 only after preflight and operator confirmation',
      };
    } else {
      result = await handleAction({
        action: 'verify_tts_loopback',
        params: {
          request_id: options.requestId || `voice-loopback-${Date.now()}`,
          text: options.text,
          language: options.language || 'ja',
          ...(options.voiceProfileId ? { voice_profile_id: options.voiceProfileId } : {}),
          ...(options.sttBridgeId ? { stt_bridge_id: options.sttBridgeId } : {}),
          audio_route: routeParams(options),
          operator_confirmed: options.confirm,
          dry_run: options.dryRun,
        },
      } as never);
    }
  }
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
  const status =
    typeof result === 'object' && result !== null && 'status' in result
      ? String((result as { status: unknown }).status)
      : 'succeeded';
  if (status === 'error' || status === 'failed') process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
