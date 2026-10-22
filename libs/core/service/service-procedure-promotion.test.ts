import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promoteServiceProcedure } from './service-procedure-promotion.js';
import { serviceRecordingContentHash, type ServiceRecording } from './service-recording.js';
import * as secureIo from '../secure-io.js';
import * as foundationJson from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';

import { getFoundationIo, registerFoundationIo } from '../foundation/io.js';

// defineCatalog reads presence through FoundationIo rather than secure-io's
// exports directly, so spying on secureIo.safeExistsSync alone does not
// reach the catalog's exists()/stat() checks — the registered io object
// captured a direct reference to the real function at module load. Patch
// the live registration instead, and restore it after each test.
function overrideFoundationIoExists(matchesRecording: (filePath: string) => boolean): void {
  const original = getFoundationIo();
  registerFoundationIo({
    ...original,
    exists: (filePath) => (matchesRecording(filePath) ? true : original.exists(filePath)),
    stat: (filePath) =>
      matchesRecording(filePath) ? { mtimeMs: 1, size: 1 } : original.stat(filePath),
  });
}

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

// The loader reads the recording through the governed catalog boundary, so the
// fixture has to be a real file inside the allowlisted recording store — the
// domain checks below are only reached once the catalog can actually load it.
const recordingDirs: string[] = [];

function writeRecordingFixture(value: ServiceRecording): string {
  const dir = pathResolver.shared(`runtime/recordings/service-promotion-test-${randomUUID()}`);
  recordingDirs.push(dir);
  const filePath = path.join(dir, 'service-promotion-test.json');
  secureIo.safeMkdir(dir, { recursive: true });
  secureIo.safeWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return pathResolver.toRepoRelative(filePath);
}

describe('promoteServiceProcedure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (recordingDirs.length > 0) {
      secureIo.safeRmSync(recordingDirs.pop() as string);
    }
  });

  it('promotes an approved recording into a non-draft pipeline and personal catalog', () => {
    const recordingRef = writeRecordingFixture(recording);
    // Only the promotion's own writes are intercepted: the compiled pipeline
    // would otherwise land in the tracked pipelines/ tree.
    vi.spyOn(secureIo, 'safeExistsSync').mockReturnValue(false);
    const mkdir = vi.spyOn(secureIo, 'safeMkdir').mockImplementation(() => undefined as any);
    const write = vi.spyOn(secureIo, 'safeWriteFile').mockImplementation(() => undefined);

    const result = promoteServiceProcedure({
      recordingRef,
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
    expect(result.procedureEntry.golden_scenario_ref).toBe(
      'active/shared/tmp/service-promotion-test/golden/service.issue-intake.test.v1.0.0.json'
    );
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining(
        'service-promotion-test/golden/service.issue-intake.test.v1.0.0.json'
      ),
      expect.stringContaining('"procedure_id": "service.issue-intake.test"')
    );
  });

  it('refuses a recording that has not passed review', () => {
    const pending: ServiceRecording = {
      ...recording,
      review: { ...recording.review!, status: 'pending' },
    };
    pending.review!.content_hash = serviceRecordingContentHash(pending);
    const recordingRef = writeRecordingFixture(pending);

    expect(() =>
      promoteServiceProcedure({
        recordingRef,
        procedureId: 'service.issue-intake.pending',
        intentPhrases: ['create an issue'],
      })
    ).toThrow('approved');
  });
});
