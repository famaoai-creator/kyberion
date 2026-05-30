import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeExistsSync } from './secure-io.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
import {
  type VoiceBridge,
  type RoleplaySessionInput,
  type RoleplaySessionResult,
  type OneOnOneSessionInput,
  type OneOnOneSessionResult,
  type RoleplayTurn,
  registerVoiceBridge,
} from './voice-bridge.js';

export interface PythonVoiceBridgeOptions {
  profileId: string;
  voiceBridgePath: string;
  audioOutputDir: string;
  language?: string;
  pythonBin?: string;
  textBridge?: VoiceBridge;
  blackholePath?: string;
  playThroughBlackhole?: boolean;
}

export class PythonVoiceBridge implements VoiceBridge {
  readonly name = 'python-tts';

  private readonly profileId: string;
  private readonly voiceBridgePath: string;
  private readonly audioOutputDir: string;
  private readonly language: string;
  private readonly pythonBin: string;
  private readonly textBridge: VoiceBridge | null;
  private readonly blackholePath: string | null;
  private readonly playThroughBlackhole: boolean;

  constructor(opts: PythonVoiceBridgeOptions) {
    this.profileId = opts.profileId;
    this.voiceBridgePath = opts.voiceBridgePath;
    this.audioOutputDir = opts.audioOutputDir;
    this.language = opts.language ?? 'ja';
    this.pythonBin = opts.pythonBin ?? 'python3';
    this.textBridge = opts.textBridge ?? null;
    this.blackholePath = opts.blackholePath ?? null;
    this.playThroughBlackhole = opts.playThroughBlackhole ?? false;
  }

  private generateAudio(text: string, outputPath: string): string | undefined {
    const payload = JSON.stringify({
      action: 'generate',
      params: { text, output_path: outputPath, language: this.language },
    });
    try {
      const raw = execFileSync(
        this.pythonBin,
        [this.voiceBridgePath, payload],
        { encoding: 'utf8' },
      );
      const result = JSON.parse(raw.trim());
      if (result.status !== 'success' && result.status !== 'ok') return undefined;
      return outputPath;
    } catch {
      return undefined;
    }
  }

  private playBlackhole(audioPath: string): void {
    if (!this.blackholePath) return;
    const payload = JSON.stringify({ action: 'play_to_blackhole', params: { path: audioPath } });
    try {
      execFileSync(this.pythonBin, [this.blackholePath, payload], { encoding: 'utf8' });
    } catch {
      // non-fatal
    }
  }

  private augmentTurns(turns: RoleplayTurn[], subDir: string): RoleplayTurn[] {
    return turns.map((turn) => {
      if (turn.speaker !== 'sovereign') return turn;
      const ts = Date.now();
      const outPath = path.join(this.audioOutputDir, this.profileId, subDir, `${ts}.wav`);
      const audioRef = this.generateAudio(turn.text, outPath);
      if (audioRef && this.playThroughBlackhole) {
        this.playBlackhole(audioRef);
      }
      return audioRef ? { ...turn, audio_ref: audioRef } : turn;
    });
  }

  async runRoleplaySession(input: RoleplaySessionInput): Promise<RoleplaySessionResult> {
    if (!this.textBridge) throw new Error('textBridge is required for PythonVoiceBridge');
    const base = await this.textBridge.runRoleplaySession(input);
    return { ...base, turns: this.augmentTurns(base.turns, 'roleplay') };
  }

  async runOneOnOneSession(input: OneOnOneSessionInput): Promise<OneOnOneSessionResult> {
    if (!this.textBridge) throw new Error('textBridge is required for PythonVoiceBridge');
    const base = await this.textBridge.runOneOnOneSession(input);
    return { ...base, transcript: this.augmentTurns(base.transcript, 'one-on-one') };
  }
}

const DEFAULT_VOICE_BRIDGE_SCRIPT = path.join(
  moduleDir,
  '../../actuators/voice-actuator/scripts/voice_learning_bridge.py',
);

export function installPythonVoiceBridgeIfAvailable(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  const profileId = env.KYBERION_VOICE_PROFILE_ID;
  if (!profileId) return false;

  const bridgePath = env.KYBERION_VOICE_BRIDGE_PATH ?? DEFAULT_VOICE_BRIDGE_SCRIPT;
  if (!safeExistsSync(bridgePath)) return false;

  const audioOutputDir = env.KYBERION_VOICE_OUTPUT_DIR ?? path.join(process.cwd(), 'active/shared/tmp/voice-out');
  const blackholePath = env.KYBERION_BLACKHOLE_SCRIPT ?? null;
  const playThroughBlackhole = env.KYBERION_VOICE_PLAY_BLACKHOLE === '1';

  const bridge = new PythonVoiceBridge({
    profileId,
    voiceBridgePath: bridgePath,
    audioOutputDir,
    language: env.KYBERION_VOICE_LANGUAGE ?? 'ja',
    pythonBin: env.KYBERION_PYTHON_BIN ?? 'python3',
    blackholePath: blackholePath ?? undefined,
    playThroughBlackhole,
  });

  registerVoiceBridge(bridge);
  return true;
}
