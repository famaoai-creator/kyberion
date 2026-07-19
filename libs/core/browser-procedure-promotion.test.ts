import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promoteBrowserProcedure } from './browser-procedure-promotion.js';
import * as secureIo from './secure-io.js';

const recording = {
  schema_version: 'browser-recording.v1',
  recording_id: 'REC-personal-1',
  source: 'chrome-extension',
  created_at: '2026-06-23T00:00:00.000Z',
  tab: {
    origin: 'https://example.com',
    origin_hash: createHash('sha256').update('https://example.com').digest('hex'),
    title: 'Example',
  },
  extension: { version: '0.1.0' },
  actions: [
    {
      action_id: 'step-1',
      op: 'click_ref',
      summary: 'Continue を選択',
      risk: 'low',
      captured_at: '2026-06-23T00:00:01.000Z',
      target: {
        ref: '@e1',
        role: 'button',
        name: 'Continue',
        snapshot_hash: createHash('sha256').update('snapshot-1').digest('hex'),
      },
    },
  ],
  risk_summary: {
    requires_manual_review: true,
    sensitive_input_omitted: 0,
    approval_required_count: 0,
  },
  review: {
    status: 'approved',
    decisions: [{ action_id: 'step-1', status: 'approved' }],
  },
};

describe('promoteBrowserProcedure', () => {
  afterEach(() => vi.restoreAllMocks());

  it('promotes an approved personal recording without writing the public catalog', () => {
    const actualRead = secureIo.safeReadFile;
    vi.spyOn(secureIo, 'safeReadFile').mockImplementation((filePath, options) => {
      if (filePath.includes('browser-recordings/REC-personal-1.json')) {
        return JSON.stringify(recording);
      }
      if (filePath.includes('browser-procedures.json')) throw new Error('ENOENT');
      return actualRead(filePath, options);
    });
    vi.spyOn(secureIo, 'safeExistsSync').mockReturnValue(false);
    const mkdir = vi.spyOn(secureIo, 'safeMkdir').mockImplementation(() => undefined as any);
    const write = vi.spyOn(secureIo, 'safeWriteFile').mockImplementation(() => undefined);

    const result = promoteBrowserProcedure({
      recordingRef: 'knowledge/personal/browser-recordings/REC-personal-1.json',
      procedureId: 'personal.example.continue',
      intentPhrases: ['Continue を押す', '続行'],
    });

    expect(result.procedureEntry.procedure_id).toBe('personal.example.continue');
    expect(result.procedureEntry.adapter.recording_ref).toContain('knowledge/personal/');
    expect(result.catalogPath).toContain('knowledge/personal/browser-procedures.json');
    expect(mkdir).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('knowledge/personal/browser-procedures.json'),
      expect.stringContaining('personal.example.continue')
    );
    expect(write).not.toHaveBeenCalledWith(
      expect.stringContaining('knowledge/product/orchestration/procedures.json'),
      expect.anything()
    );
  });

  it('refuses an unapproved recording', () => {
    const actualRead = secureIo.safeReadFile;
    vi.spyOn(secureIo, 'safeReadFile').mockImplementation((filePath, options) => {
      if (filePath.includes('browser-recordings/REC-personal-1.json')) {
        return JSON.stringify({ ...recording, review: { ...recording.review, status: 'pending' } });
      }
      return actualRead(filePath, options);
    });
    expect(() =>
      promoteBrowserProcedure({
        recordingRef: 'knowledge/personal/browser-recordings/REC-personal-1.json',
        procedureId: 'personal.example.pending',
        intentPhrases: ['続行'],
      })
    ).toThrow('approved');
  });
});
