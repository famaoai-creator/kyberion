import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

describe('trial narrated report pipeline contract', () => {
  it('uses built actuator entrypoints and a runtime preflight with strict ADF compliance', () => {
    const pipeline = JSON.parse(
      safeReadFile('pipelines/trial-narrated-report.json', { encoding: 'utf8' }) as string,
    ) as { steps: Array<{ id?: string; op: string; params?: Record<string, any> }> };

    const pipelineStr = JSON.stringify(pipeline);

    const checkVoiceBuild = pipeline.steps.find((step) => step.id === 'check_voice_actuator_build');
    const checkVideoBuild = pipeline.steps.find((step) => step.id === 'check_video_actuator_build');
    const writeVoiceAction = pipeline.steps.find((step) => step.id === 'write_voice_action');
    const writeRenderPolicy = pipeline.steps.find((step) => step.id === 'write_video_render_policy');
    const audio = pipeline.steps.find((step) => step.id === 'generate_audio');
    const video = pipeline.steps.find((step) => step.id === 'generate_video');
    const finalLog = pipeline.steps.find((step) => step.id === 'final_log');

    // Preflight verifies actuator build artifacts exist
    expect(checkVoiceBuild?.params?.dir).toContain('dist/libs/actuators/voice-actuator/src');
    expect(checkVideoBuild?.params?.dir).toContain('dist/libs/actuators/video-composition-actuator/src');

    // Runtime tool checks nested inside preflight_artifacts
    expect(pipelineStr).toContain('say');
    expect(pipelineStr).toContain('espeak');
    expect(pipelineStr).toContain('ffmpeg');
    expect(pipelineStr).toContain('ffprobe');

    // Strict ADF compliance checks for voice-action.json
    expect(writeVoiceAction?.params?.content).toContain('"action":"generate_voice"');
    expect(writeVoiceAction?.params?.content).toContain('"engine":{"engine_id":"local_say"}');
    expect(writeVoiceAction?.params?.content).toContain('"delivery":{"mode":"artifact","format":"aiff"');
    expect(writeVoiceAction?.params?.content).toContain('"rendering":{"language":"ja"');
    expect(writeRenderPolicy?.params?.content).toContain('"enable_backend_rendering":true');
    expect(writeRenderPolicy?.params?.content).toContain('"backend":"hyperframes_cli"');

    expect(audio?.params?.cmd).toContain('dist/libs/actuators/voice-actuator/src/index.js');

    // Audio verification is embedded in the validate_video_output step
    expect(pipelineStr).toContain('test -f {{audio_path}}');

    expect(video?.params?.cmd).toContain('KYBERION_VIDEO_RENDER_RUNTIME_POLICY_PATH={{video_render_policy_json}}');
    expect(video?.params?.cmd).toContain('dist/libs/actuators/video-composition-actuator/src/index.js');

    // Output verification step checks audio, video, HTML bundle, render plan, and audio stream
    expect(pipelineStr).toContain('test -f {{video_output_path}}');
    expect(pipelineStr).toContain('ffprobe -v error -select_streams a:0');
    expect(pipelineStr).toContain('test -f active/shared/tmp/video-composition/executive-summary/index.html');
    expect(pipelineStr).toContain('test -f active/shared/tmp/video-composition/executive-summary/render-plan.json');

    expect(finalLog?.params?.message).toContain('{{audio_gen_result}}');
  });
});
