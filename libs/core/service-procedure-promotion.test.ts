import { afterEach, describe, expect, it, vi } from 'vitest';
import { promoteServiceProcedure } from './service-procedure-promotion.js';
import { serviceRecordingContentHash, type ServiceRecording } from './service-recording.js';
import * as secureIo from './secure-io.js';

const recording: ServiceRecording = {
  schema_version: 'service-recording.v1',
  recording_id: 'svc-promotion-test',
  source: 'service-capture',
  created_at: '2026-06-24T00:00:00.000Z',
  target: { name: 'Issue intake', services: ['github'] },
  steps: [
    {
      step_id: 'step-001',
      service_id: 'github',
      action: 'create_issue',
      summary: 'Create issue',
      risk_class: 'high',
      params: { owner: 'famaoai', repo: 'kyberion', title: '{{input.title}}' },
    },
  ],
  risk_summary: { requires_manual_review: true, approval_required_count: 1 },
  review: {
    status: 'approved',
    reviewer: 'human:test',
    decisions: [{ step_id: 'step-001', status: 'approved' }],
  },
};
recording.review!.content_hash = serviceRecordingContentHash(recording);

describe('promoteServiceProcedure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('promotes an approved recording into a non-draft pipeline and personal catalog', () => {
    const actualRead = secureIo.safeReadFile;
    vi.spyOn(secureIo, 'safeReadFile').mockImplementation((filePath, options) => {
      if (filePath.includes('service-promotion-test.json')) return JSON.stringify(recording);
      return actualRead(filePath, options);
    });
    vi.spyOn(secureIo, 'safeExistsSync').mockReturnValue(false);
    vi.spyOn(secureIo, 'loadJson').mockImplementation((filePath) => {
      if (filePath.includes('service-promotion-test.json')) return recording;
      return JSON.parse(String(actualRead(filePath, { encoding: 'utf8' })));
    });
    const mkdir = vi.spyOn(secureIo, 'safeMkdir').mockImplementation(() => undefined as any);
    const write = vi.spyOn(secureIo, 'safeWriteFile').mockImplementation(() => undefined);

    const result = promoteServiceProcedure({
      recordingRef: 'active/shared/runtime/recordings/service-promotion-test.json',
      procedureId: 'service.issue-intake.test',
      intentPhrases: ['create an issue'],
      catalogPath: 'active/shared/tmp/service-promotion-test/procedures.json',
    });

    expect(result.procedureEntry.procedure_id).toBe('service.issue-intake.test');
    expect(result.pipeline).not.toHaveProperty('_draft');
    expect(result.pipeline.steps[1]).toMatchObject({
      op: 'service:preset',
      budget: { approval_required: true },
    });
    expect(mkdir).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('pipelines/service/service.issue-intake.test.json'),
      expect.not.stringContaining('"_draft"')
    );
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('service-promotion-test/procedures.json'),
      expect.stringContaining('service.issue-intake.test')
    );
  });

  it('refuses a recording that has not passed review', () => {
    const actualRead = secureIo.safeReadFile;
    vi.spyOn(secureIo, 'safeReadFile').mockImplementation((filePath, options) => {
      if (filePath.includes('service-promotion-test.json')) {
        return JSON.stringify({ ...recording, review: { ...recording.review, status: 'pending' } });
      }
      return actualRead(filePath, options);
    });
    vi.spyOn(secureIo, 'loadJson').mockImplementation((filePath) => {
      if (filePath.includes('service-promotion-test.json')) {
        return { ...recording, review: { ...recording.review, status: 'pending' } };
      }
      return JSON.parse(String(actualRead(filePath, { encoding: 'utf8' })));
    });

    expect(() =>
      promoteServiceProcedure({
        recordingRef: 'active/shared/runtime/recordings/service-promotion-test.json',
        procedureId: 'service.issue-intake.pending',
        intentPhrases: ['create an issue'],
      })
    ).toThrow('approved');
  });
});
