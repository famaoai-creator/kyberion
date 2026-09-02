import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessDesktopObservationReadiness,
  buildDesktopRecording,
  computeDesktopRecordingHash,
  DesktopDemonstrationRecorder,
  loadDesktopRecordingAtPath,
  listDesktopObservationSources,
  validateDesktopRecording,
} from './desktop-recording.js';
import { parseDesktopEventLine } from './desktop-event-feed.js';
import { reconstructDesktopIntent, reviewDesktopIntent } from './desktop-intent-reconstruction.js';
import { assertObservationOpMappingsValid, chooseNativeOps } from './native-op-mapping.js';
import { compileDesktopRecording } from './desktop-recording-compiler.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const RECORDING_TEST_ROOT = pathResolver.sharedTmp('desktop-recording-loader-test');

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  application: 'Notes',
  window_title: 'Inbox',
  focused_input: {
    application: 'Notes',
    windowTitle: 'Inbox',
    role: 'textbox',
    description: 'Message',
    editable: true,
  },
  event: { op: 'click_at', x: 10, y: 20 },
  ...overrides,
});

describe('desktop recording and distillation', () => {
  it('normalizes native desktop events before they enter the recording queue', () => {
    expect(parseDesktopEventLine({ op: 'click_at', x: 10, y: 20, click_count: 2 })).toEqual({
      op: 'click_at',
      x: 10,
      y: 20,
      click_count: 2,
    });
    expect(parseDesktopEventLine({ op: 'press_key', params: { key_code: 36 } })).toEqual({
      op: 'press_key',
      params: { key_code: 36 },
    });
  });

  it('rejects malformed or privacy-unsafe native event shapes', () => {
    expect(parseDesktopEventLine([])).toBeUndefined();
    expect(parseDesktopEventLine({ op: 'click_at', x: '10', y: 20 })).toBeUndefined();
    expect(
      parseDesktopEventLine({ op: 'click_at', x: 10, y: 20, params: { text: 'secret' } })
    ).toBe(undefined);
    expect(
      parseDesktopEventLine({ op: 'press_key', params: { key_code: 36, key: 'return' } })
    ).toBe(undefined);
    expect(
      parseDesktopEventLine({ op: 'press_key', params: { key_code: 70_000 } })
    ).toBeUndefined();
    expect(
      parseDesktopEventLine({ op: 'press_key', params: { constructor: { polluted: true } } })
    ).toBeUndefined();
  });

  it('keeps observation tier separate and explains unavailable permissions', () => {
    expect(listDesktopObservationSources().map((source) => source.id)).toEqual([
      'active_window',
      'clipboard',
      'browser_tabs',
      'focused_input',
      'screen_frame',
    ]);
    const readiness = assessDesktopObservationReadiness({
      platform: 'darwin',
      available: true,
      permissions: {
        automation: 'granted',
        accessibility: 'denied',
        screen_recording: 'unknown',
      },
    });
    expect(readiness.find((entry) => entry.source_id === 'clipboard')).toMatchObject({
      available: true,
      reason: 'permission_not_required',
    });
    expect(readiness.find((entry) => entry.source_id === 'screen_frame')).toMatchObject({
      available: false,
      reason: 'screen_recording_permission_unknown',
    });
  });

  it('records human observations with semantic target evidence and no clipboard body', () => {
    const recording = buildDesktopRecording([snapshot({ clipboard_text: 'super-secret-token' })]);
    expect(recording.steps[0].selector).toMatchObject({
      app: 'Notes',
      window_title: 'Inbox',
      role: 'textbox',
    });
    expect(JSON.stringify(recording)).not.toContain('super-secret-token');
    expect(recording.steps[0].evidence.some((value) => value.startsWith('clipboard:sha256:'))).toBe(
      true
    );
  });

  it('gates static frames by change plus heartbeat instead of linear growth', () => {
    let count = 0;
    const recorder = new DesktopDemonstrationRecorder({
      sample: () => snapshot({ frame_hash: 'same', event: { op: 'screenshot' } }),
      heartbeatMs: 5_000,
    });
    recorder.start();
    for (let ms = 0; ms < 60_000; ms += 1_000) {
      recorder.pollOnce(ms);
      count += 1;
    }
    expect(recorder.getSamples().length).toBe(12);
    expect(recorder.getSamples().length).toBeLessThan(count);
    expect(recorder.getSamples().every((sample) => sample.clipboard_text === undefined)).toBe(true);
  });

  it('accepts a host event source and infers app transitions into executable steps', () => {
    let index = 0;
    const recorder = new DesktopDemonstrationRecorder({
      sample: () =>
        snapshot({ application: index++ === 0 ? 'Notes' : 'Calendar', event: undefined }),
      eventSource: () => undefined,
    });
    recorder.start();
    recorder.pollOnce(0);
    recorder.pollOnce(1_000);
    const recording = recorder.stop();
    expect(recording.steps.map((step) => step.op)).toEqual([
      'activate_application',
      'activate_application',
    ]);
  });

  it('drains a burst of host events in one poll without dropping the tail', () => {
    let events = [
      { op: 'click_at', x: 10, y: 20 },
      { op: 'click_at', x: 30, y: 40 },
      { op: 'press_key', params: { key_code: 36 } },
    ];
    const recorder = new DesktopDemonstrationRecorder({
      sample: () => snapshot({ event: undefined, frame_hash: 'same' }),
      eventSource: () => {
        const batch = events;
        events = [];
        return batch;
      },
    });
    recorder.start();
    recorder.pollOnce(0);
    expect(recorder.getSamples()).toHaveLength(3);
    expect(recorder.stop().steps.map((step) => step.op)).toEqual([
      'mouse_click',
      'mouse_click',
      'press_key',
    ]);
  });

  it('preserves native event parameters without recording typed text', () => {
    const recording = buildDesktopRecording([
      snapshot({ event: { op: 'press_key', params: { key_code: 36 } } }),
    ]);
    expect(recording.steps[0]).toMatchObject({
      op: 'press_key',
      params: { key_code: 36 },
      risk_class: 'high',
    });
    expect(JSON.stringify(recording)).not.toContain('typed_text');
  });

  it('drops arbitrary event parameters and blocks coordinate-only semantic targets', () => {
    const recording = buildDesktopRecording([
      {
        event: {
          op: 'click_at',
          x: 10,
          y: 20,
          params: { token: 'raw-secret', message: 'private' },
        },
      },
      { event: { op: 'press_key', params: { key_code: 36, key: 'Return', secret: 'raw-secret' } } },
    ]);
    expect(JSON.stringify(recording)).not.toContain('raw-secret');
    expect(recording.steps[0]?.params).toBeUndefined();
    expect(recording.steps[0]?.needs_semantic_resolution).toBe(true);
    expect(recording.steps[1]?.params).toEqual({ key_code: 36 });
  });

  it('rejects a persisted recording when required integrity fields are missing or changed', () => {
    const recording = buildDesktopRecording([snapshot({ event: { op: 'screenshot' } })]);
    const missing = { ...recording } as Record<string, unknown>;
    delete missing.recording_hash;
    expect(validateDesktopRecording(missing).valid).toBe(false);

    const changed = {
      ...recording,
      steps: recording.steps.map((step) => ({ ...step, summary: 'tampered' })),
    };
    expect(validateDesktopRecording(changed)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining(['recording_hash does not match the reviewed recording body']),
    });
  });

  it('loads persisted recordings through the regular-file contract boundary', () => {
    safeRmSync(RECORDING_TEST_ROOT, { recursive: true, force: true });
    safeMkdir(RECORDING_TEST_ROOT, { recursive: true });
    const recording = buildDesktopRecording([snapshot({ event: { op: 'screenshot' } })]);
    const recordingPath = path.join(RECORDING_TEST_ROOT, 'recording.json');
    safeWriteFile(recordingPath, `${JSON.stringify(recording)}\n`);

    expect(loadDesktopRecordingAtPath(recordingPath).recording_id).toBe(recording.recording_id);
  });

  it('rejects a directory at the persisted recording path', () => {
    safeRmSync(RECORDING_TEST_ROOT, { recursive: true, force: true });
    safeMkdir(path.join(RECORDING_TEST_ROOT, 'recording.json'), { recursive: true });

    expect(() =>
      loadDesktopRecordingAtPath(path.join(RECORDING_TEST_ROOT, 'recording.json'))
    ).toThrow('recording must be a regular file');
  });

  it('keeps an empty observation capture valid but non-executable', () => {
    const recording = buildDesktopRecording([]);
    expect(validateDesktopRecording(recording)).toMatchObject({ valid: true });
    expect(recording.steps).toHaveLength(0);
    expect(() =>
      compileDesktopRecording(recording, {
        procedureId: 'desktop.empty.capture',
        intentPhrases: ['empty capture'],
      })
    ).toThrow('no executable steps');
  });

  it('validates the persisted contract and compiles a reviewed desktop procedure', () => {
    const recording = buildDesktopRecording([snapshot({ event: { op: 'screenshot' } })]);
    expect(validateDesktopRecording(recording)).toMatchObject({ valid: true });
    const compiled = compileDesktopRecording(recording, {
      procedureId: 'desktop.notes.capture',
      intentPhrases: ['capture the desktop state'],
      recordingRef: 'active/shared/runtime/recordings/recording.json',
    });
    expect(compiled.procedureEntry).toMatchObject({
      substrate: 'desktop',
      adapter: { recorder: 'desktop-capture', executor: 'system' },
      pipeline_ref: 'pipelines/desktop/desktop.notes.capture.json',
    });
    expect(compiled.pipeline.steps[0]?.op).toBe('system:screenshot');
  });

  it('keeps inferred native suggestions in intent without turning them into an execution binding', () => {
    const recording = buildDesktopRecording([
      snapshot({ application: 'GitHub issue tracker', event: { op: 'click_at', x: 10, y: 20 } }),
    ]);
    const compiled = compileDesktopRecording(recording, {
      procedureId: 'desktop.github.issue',
      intentPhrases: ['update a GitHub issue'],
    });
    expect(compiled.pipeline.steps[0]?.native_op).toBeUndefined();
    expect(reconstructDesktopIntent(recording).steps[0]?.native_op).toBe('gh:issue');
  });

  it('rejects an explicit native binding until a governed executor is registered', () => {
    const recording = buildDesktopRecording([
      snapshot({ application: 'GitHub issue tracker', event: { op: 'click_at', x: 10, y: 20 } }),
    ]);
    recording.steps[0] = { ...recording.steps[0], native_op: 'gh:issue' };
    recording.recording_hash = computeDesktopRecordingHash(recording);
    expect(() =>
      compileDesktopRecording(recording, {
        procedureId: 'desktop.github.issue.explicit',
        intentPhrases: ['update a GitHub issue'],
      })
    ).toThrow('no native executor is registered');
  });

  it('returns a deterministic, human-reviewable intent baseline and preserves edits', () => {
    const recording = buildDesktopRecording([
      snapshot({ event: { op: 'activate_application' } }),
      snapshot({ event: { op: 'click_at', x: 1, y: 2 } }),
      snapshot({ event: { op: 'click_at', x: 3, y: 4 } }),
    ]);
    const draft = reconstructDesktopIntent(recording);
    expect(draft.steps.every((step) => step.evidence.length > 0)).toBe(true);
    const approved = reviewDesktopIntent(
      { ...draft, steps: draft.steps.slice(0, 1) },
      'approved',
      'operator'
    );
    expect(approved.review.status).toBe('approved');
    expect(approved.steps).toHaveLength(1);
  });

  it('validates the native-op mapping and leaves GUI as an explicit fallback', () => {
    expect(() => assertObservationOpMappingsValid()).not.toThrow();
    expect(chooseNativeOps('Update a GitHub issue').ops).toContain('gh:issue');
    expect(chooseNativeOps('Unknown web app form').gui_fallback).toBe(true);
  });
});
