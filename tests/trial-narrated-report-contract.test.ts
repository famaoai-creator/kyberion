import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core';

describe('trial narrated report pipeline contract', () => {
  it('uses built actuator entrypoints and a runtime preflight with strict ADF compliance', () => {
    const pipeline = JSON.parse(
      safeReadFile('pipelines/trial-narrated-report.json', { encoding: 'utf8' }) as string
    ) as {
      context?: Record<string, string>;
      steps: Array<{ id?: string; op: string; params?: Record<string, any> }>;
    };

    const pipelineStr = JSON.stringify(pipeline);

    const checkVoiceBuild = pipeline.steps.find((step) => step.id === 'check_voice_actuator_build');
    const checkVideoBuild = pipeline.steps.find((step) => step.id === 'check_video_actuator_build');
    const writeVoiceAction = pipeline.steps.find((step) => step.id === 'write_voice_action');
    const writeRenderPolicy = pipeline.steps.find(
      (step) => step.id === 'write_video_render_policy'
    );
    const audio = pipeline.steps.find((step) => step.id === 'generate_audio');
    const video = pipeline.steps.find((step) => step.id === 'generate_video');
    const finalLog = pipeline.steps.find((step) => step.id === 'final_log');

    // Preflight verifies actuator build artifacts exist
    expect(checkVoiceBuild?.params?.dir).toContain('dist/libs/actuators/voice-actuator/src');
    expect(checkVideoBuild?.params?.dir).toContain(
      'dist/libs/actuators/video-composition-actuator/src'
    );

    // Runtime tool checks nested inside preflight_artifacts
    expect(pipelineStr).toContain('say');
    expect(pipelineStr).toContain('espeak');
    expect(pipelineStr).toContain('ffmpeg');
    expect(pipelineStr).toContain('ffprobe');

    // Strict ADF compliance checks for voice-action.json
    expect(writeVoiceAction?.params?.content).toContain('"action":"generate_voice"');
    expect(writeVoiceAction?.params?.content).toContain('"engine":{"engine_id":"local_say"}');
    expect(writeVoiceAction?.params?.content).toContain(
      '"delivery":{"mode":"artifact","format":"aiff"'
    );
    expect(writeVoiceAction?.params?.content).toContain('"rendering":{"language":"ja"');
    expect(writeRenderPolicy?.params?.content).toContain('"enable_backend_rendering":true');
    expect(writeRenderPolicy?.params?.content).toContain('"backend":"hyperframes_cli"');

    // SX-11: generation and validation moved off `system:exec node dist/...`
    // wrappers onto the actuators' typed ops. The contract is unchanged: the
    // narration is produced by the voice actuator into {{audio_path}}, and the
    // video is composed and validated by the video-composition actuator.
    expect(audio?.op).toBe('voice:generate_voice');
    expect(audio?.params?.engine).toEqual({ engine_id: 'local_say' });
    expect(audio?.params?.delivery?.mode).toBe('artifact');
    expect(audio?.params?.delivery?.format).toBe('aiff');
    expect(audio?.params?.delivery?.artifact_path).toBe('{{audio_path}}');

    // Audio artifact + stream verification runs before the video is composed
    const validateAudio = pipeline.steps.find((step) => step.id === 'validate_audio_output');
    expect(validateAudio?.params?.cmd).toContain('test -f {{audio_path}}');
    expect(validateAudio?.params?.cmd).toContain('ffprobe -v error -select_streams a:0');

    expect(video?.op).toBe('video-composition:create_narrated_intro_movie');
    expect(video?.params?.narrated_video_brief?.narration_artifact_ref).toBe('{{audio_path}}');
    expect(video?.params?.narrated_video_brief?.output?.target_path).toBe('{{video_output_path}}');
    expect(video?.params?.narrated_video_brief?.output?.bundle_dir).toBe('{{video_bundle_dir}}');

    // The typed validate op checks narration, video, the HTML bundle, the render
    // plan and the audio/video streams; the pipeline must hand it every path.
    const validateVideo = pipeline.steps.find((step) => step.id === 'validate_video_output');
    expect(validateVideo?.op).toBe('video-composition:validate_narrated_video_artifact');
    expect(validateVideo?.params?.narration_path).toBe('{{audio_path}}');
    expect(validateVideo?.params?.video_output_path).toBe('{{video_output_path}}');
    expect(validateVideo?.params?.video_bundle_dir).toBe('{{video_bundle_dir}}');
    expect(validateVideo?.params?.mission_evidence_dir).toBe('{{mission_evidence_dir}}');
    expect(validateVideo?.params?.video_slug).toBe('{{video_slug}}');
    expect(pipeline.context?.video_bundle_dir).toBe(
      'active/shared/tmp/video-composition/executive-summary'
    );

    expect(finalLog?.params?.message).toContain('{{audio_gen_result}}');
  });
});
