import type { CommonArgs, PerceptionDeps } from './perception.js';
import { ScriptExitError } from './harness.js';
import type { Observation, PerceptionSource } from '@agent/core/perception/observation';
import type * as Audio from '@agent/core/perception/audio-analysis';
import type * as Tracking from '@agent/core/perception/tracking';
import type * as Visual from '@agent/core/perception/visual-change';
import type * as Semantic from '@agent/core/perception/semantic-index';

export interface PerceptionOptions {
  grounded?: boolean;
  compare?: string;
  changes?: boolean;
  track?: boolean;
  diarize?: boolean;
  events?: boolean;
  noTranscript?: boolean;
  faceModel?: string;
  poseModel?: string;
  gestureModel?: string;
  diarizationModel?: string;
  audioModel?: string;
  python?: string;
  avatarId?: string;
  index?: string;
  search?: string;
  embeddingModel?: string;
}
export interface PerceptionEnhancementDeps {
  source?: (path: string) => PerceptionSource;
  ocrObservations?: typeof import('@agent/core/perception/observation').ocrObservations;
  transcriptObservations?: typeof import('@agent/core/perception/observation').transcriptObservations;
  observation?: typeof import('@agent/core/perception/observation').observation;
  analyzeAudio?: typeof Audio.analyzeAudio;
  alignSpeakers?: typeof Audio.alignSpeakerSegments;
  track?: typeof Tracking.trackMedia;
  cues?: typeof Tracking.trackingFrameToAnimationCues;
  fingerprint?: typeof Visual.fingerprintImage;
  compare?: typeof Visual.compareFingerprints;
  compareImages?: typeof Visual.compareImages;
  index?: typeof Semantic.indexMedia;
  search?: typeof Semantic.searchMedia;
}
export const PERCEPTION_OPTIONS_HELP =
  '  --grounded      Include source hashes and position/time-grounded observations\n' +
  '  --compare <image> Compare this image with an earlier image (see)\n' +
  '  --changes       Detect sampled visual changes, including non-text changes (watch)\n' +
  '  --diarize --diarization-model <local-dir>  Add speaker labels (listen/watch)\n' +
  '  --events --audio-model <local.tflite>  Classify sound events (listen/watch)\n' +
  '  --no-transcript Analyze sounds without requiring speech recognition\n' +
  '  --track --face-model <local.task> [--pose-model <local.task>] [--gesture-model <local.task>]\n' +
  '  --avatar-id <id> Include animation cues from tracked faces (see/watch)\n' +
  '  --index <id> --embedding-model <local-dir> Index images/video frames\n' +
  '  --search <query> --index <id> --embedding-model <local-dir> Search an existing index (see, no file)\n' +
  '  --python <executable> Local inference Python (default python3); models never auto-download\n' +
  '  Model assets must be paths inside the repository the command may read: provision them under\n' +
  '  active/shared/cache/system/perception-models/ (the documented store) or on a public /\n' +
  '  own-tenant tmp|staging partition; other floors deny the read on protected tiers.';

export function parsePerceptionOption(
  args: CommonArgs,
  argv: string[],
  index: number
): { consumed: number } | undefined {
  const flag = argv[index]!;
  const options = args.enhancement ?? {};
  const switches: Record<string, keyof PerceptionOptions> = {
    '--grounded': 'grounded',
    '--changes': 'changes',
    '--track': 'track',
    '--diarize': 'diarize',
    '--events': 'events',
    '--no-transcript': 'noTranscript',
  };
  const values: Record<string, keyof PerceptionOptions> = {
    '--compare': 'compare',
    '--face-model': 'faceModel',
    '--pose-model': 'poseModel',
    '--gesture-model': 'gestureModel',
    '--diarization-model': 'diarizationModel',
    '--audio-model': 'audioModel',
    '--python': 'python',
    '--avatar-id': 'avatarId',
    '--index': 'index',
    '--search': 'search',
    '--embedding-model': 'embeddingModel',
  };
  if (switches[flag]) {
    Object.assign(options, { [switches[flag]!]: true });
    args.enhancement = options;
    return { consumed: 0 };
  }
  if (values[flag]) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new ScriptExitError(1, flag + ' requires a value');
    Object.assign(options, { [values[flag]!]: value });
    args.enhancement = options;
    return { consumed: 1 };
  }
  return undefined;
}
export function validatePerceptionOptions(
  command: 'see' | 'listen' | 'watch',
  options: PerceptionOptions = {}
): void {
  const unsupported =
    command === 'see'
      ? ['changes', 'diarize', 'events', 'diarizationModel', 'audioModel', 'noTranscript']
      : command === 'listen'
        ? [
            'compare',
            'changes',
            'track',
            'faceModel',
            'poseModel',
            'gestureModel',
            'avatarId',
            'index',
            'search',
            'embeddingModel',
          ]
        : ['compare', 'search'];
  for (const key of unsupported)
    if (options[key as keyof PerceptionOptions] !== undefined)
      throw new ScriptExitError(
        1,
        '[' + command + '] option ' + key + ' is unsupported for this input'
      );
  if (options.noTranscript && !options.events && !options.diarize)
    throw new ScriptExitError(1, '--no-transcript requires --events or --diarize');
  if (options.diarize && !options.diarizationModel)
    throw new ScriptExitError(1, '--diarize requires --diarization-model <local-dir>');
  if (options.events && !options.audioModel)
    throw new ScriptExitError(1, '--events requires --audio-model <local.tflite>');
  if (options.track && !options.faceModel && !options.poseModel && !options.gestureModel)
    throw new ScriptExitError(
      1,
      '--track requires a local --face-model, --pose-model or --gesture-model'
    );
  if (options.avatarId && !options.track)
    throw new ScriptExitError(1, '--avatar-id requires --track');
  if (options.index && !options.embeddingModel)
    throw new ScriptExitError(1, '--index requires --embedding-model <local-dir>');
  if (options.search && !options.index) throw new ScriptExitError(1, '--search requires --index');
}
export async function enhancementDeps(deps: PerceptionDeps) {
  const [observation, visual] = await Promise.all([
    import('@agent/core/perception/observation'),
    import('@agent/core/perception/visual-change'),
  ]);
  return {
    ...observation,
    fingerprint: visual.fingerprintImage,
    compare: visual.compareFingerprints,
    compareImages: visual.compareImages,
    ...deps.enhancements,
  };
}
export function renderObservations(observations: Observation[]): string[] {
  if (!observations.length) return [];
  return [
    '',
    '## Observations',
    '',
    ...observations.map(
      (o) =>
        '- ' +
        o.kind +
        ': ' +
        (o.text ?? o.speaker_id ?? o.provider) +
        (o.time
          ? ' [' + o.time.start_sec.toFixed(3) + '–' + o.time.end_sec.toFixed(3) + 's]'
          : '') +
        (o.region ? ' @ ' + JSON.stringify(o.region) : '') +
        ' (' +
        o.finality +
        ')'
    ),
  ];
}
