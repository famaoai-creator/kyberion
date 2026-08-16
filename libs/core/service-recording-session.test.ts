import { describe, expect, it } from 'vitest';
import { ServiceRecordingSession } from './service-recording-session.js';
import { validateServiceRecording } from './service-recording.js';
import { compileServiceRecording } from './service-recording-compiler.js';

describe('ServiceRecordingSession', () => {
  it('records canonical service calls as redacted reviewable steps', () => {
    const session = new ServiceRecordingSession({
      recording_id: 'svc-session-test',
      target_name: 'GitHub issue intake',
      now: () => '2026-08-16T00:00:00.000Z',
    });
    session.recordCall({
      service_id: 'github',
      action: 'create_issue',
      params: {
        owner: 'famaoai',
        repo: 'kyberion',
        title: '{{input.title}}',
        authorization: 'Bearer should-not-persist',
      },
      result: { number: 42, url: 'https://github.com/HKUDS/CLI-Anything/issues/42' },
      produces: 'issue',
    });

    const recording = session.toRecording();
    expect(validateServiceRecording(recording).valid).toBe(true);
    expect(recording.steps[0].params).toMatchObject({
      owner: 'famaoai',
      title: '{{input.title}}',
      authorization: '{{secret.authorization}}',
    });
    expect(JSON.stringify(recording)).not.toContain('should-not-persist');
    expect(recording.steps[0].param_bindings).toMatchObject({
      title: 'input',
      authorization: 'secret',
    });
    expect(recording.steps[0].result_summary).toEqual({
      kind: 'object',
      keys: ['number', 'url'],
    });

    const compiled = compileServiceRecording(recording, {
      procedureId: 'service.github.issue-intake',
      intentPhrases: ['GitHub issueを作成'],
    });
    expect(compiled.pipeline._draft).toBe(true);
    expect(compiled.pipeline.steps[0]).toMatchObject({
      op: 'service:preset',
      params: { service_id: 'github', action: 'create_issue', auth: 'secret-guard' },
    });
    expect(compiled.warnings).toContain('step-001 requires human secret binding: authorization');
  });
});
