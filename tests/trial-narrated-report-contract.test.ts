import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

describe('trial narrated report pipeline contract', () => {
  it('uses built actuator entrypoints and a runtime preflight with strict ADF compliance', () => {
    const pipeline = JSON.parse(
      safeReadFile('pipelines/trial-narrated-report.json', { encoding: 'utf8' }) as string,
    ) as { steps: Array<{ id?: string; op: string; params?: { cmd?: string } }> };

    const preflight = pipeline.steps.find((step) => step.id === 'preflight_runtime');
    const audioVerify = pipeline.steps.find((step) => step.id === 'verify_audio_after_generation');
    const audio = pipeline.steps.find((step) => step.id === 'generate_audio');
    const video = pipeline.steps.find((step) => step.id === 'create_video_action');
    const verify = pipeline.steps.find((step) => step.id === 'verify_outputs');
    const prepare = pipeline.steps.find((step) => step.id === 'prepare_action_json');
    const finalLog = pipeline.steps.find((step) => step.id === 'final_log');

    expect(preflight?.params?.cmd).toContain('dist/libs/actuators/voice-actuator/src/index.js');
    expect(preflight?.params?.cmd).toContain('dist/libs/actuators/video-composition-actuator/src/index.js');
    expect(preflight?.params?.cmd).toContain('say');
    expect(preflight?.params?.cmd).toContain('espeak');
    expect(preflight?.params?.cmd).toContain('ffmpeg');
    expect(preflight?.params?.cmd).toContain('ffprobe');
    
    // Strict ADF compliance checks for voice-action.json
    expect(prepare?.params?.cmd).toContain('"action":"generate_voice"');
    expect(prepare?.params?.cmd).toContain('"engine":{"engine_id":"local_say"}');
    expect(prepare?.params?.cmd).toContain('"delivery":{"mode":"artifact","format":"aiff"');
    expect(prepare?.params?.cmd).toContain('"rendering":{"language":"ja"');
    expect(prepare?.params?.cmd).toContain('"enable_backend_rendering":true');
    expect(prepare?.params?.cmd).toContain('"backend":"hyperframes_cli"');

    expect(audio?.params?.cmd).toContain('dist/libs/actuators/voice-actuator/src/index.js');
    expect(audioVerify?.params?.cmd).toContain('test -f {{audio_path}}');
    expect(video?.params?.cmd).toContain('KYBERION_VIDEO_RENDER_RUNTIME_POLICY_PATH={{video_render_policy_json}}');
    expect(video?.params?.cmd).toContain('dist/libs/actuators/video-composition-actuator/src/index.js');
    expect(verify?.params?.cmd).toContain('test -f {{audio_path}}');
    expect(verify?.params?.cmd).toContain('test -f {{video_output_path}}');
    expect(verify?.params?.cmd).toContain('ffprobe -v error -select_streams a:0');
    expect(verify?.params?.cmd).toContain('test -f active/shared/tmp/video-composition/executive-summary/index.html');
    expect(verify?.params?.cmd).toContain('test -f active/shared/tmp/video-composition/executive-summary/render-plan.json');
    expect(finalLog?.params?.message).toContain('Audio verify: {{audio_verify_result}}');
  });
});
