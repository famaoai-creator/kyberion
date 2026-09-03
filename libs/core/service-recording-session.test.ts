import { describe, expect, it } from 'vitest';
import { safeReadFile, safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { ServiceRecordingSession } from './service-recording-session.js';
import { validateServiceRecording } from './service-recording.js';
import { compileServiceRecording } from './service-recording-compiler.js';

describe('ServiceRecordingSession', () => {
  it('rejects recording ids that could escape the runtime recording store', () => {
    expect(
      () =>
        new ServiceRecordingSession({
          target_name: 'Issue intake',
          recording_id: '../escape',
        })
    ).toThrow('recording_id');
  });

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
    expect(compiled.pipeline.steps[1]).toMatchObject({
      op: 'service:preset',
      params: { service_id: 'github', action: 'create_issue', auth: 'secret-guard' },
    });
    expect(compiled.pipeline.steps[0]).toMatchObject({
      role: 'gate',
      op: 'core:await_decision',
    });
    expect(compiled.warnings).toContain('step-001 requires human secret binding: authorization');
  });

  it('persists the catalog canonical payload', () => {
    const session = new ServiceRecordingSession({
      recording_id: 'svc-session-canonical',
      target_name: 'Canonical recording',
      now: () => '2026-08-16T00:00:00.000Z',
    });
    session.recordCall({ service_id: 'github', action: 'create_issue' });
    const originalToRecording = session.toRecording.bind(session);
    session.toRecording = (() => ({
      ...originalToRecording(),
      $schema: 'https://example.invalid/service-recording.json',
    })) as typeof session.toRecording;

    const logicalPath = session.persist();
    const filePath = pathResolver.rootResolve(logicalPath);
    try {
      const persisted = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' })));
      expect(persisted.$schema).toBeUndefined();
      expect(persisted.schema_version).toBe('service-recording.v1');
    } finally {
      safeRmSync(filePath);
    }
  });
});
