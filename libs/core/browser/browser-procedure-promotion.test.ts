import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promoteBrowserProcedure } from './browser-procedure-promotion.js';
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

// The loader reads the recording through the governed catalog boundary, so the
// fixture has to be a real file inside the allowlisted personal recording
// store — the review check below is only reached once the catalog can load it.
const recordingDirs: string[] = [];

/**
 * The personal tier is a Sovereign Sanctuary: every access — the fixture
 * writes here and the promotion's own read of the recording — needs an
 * authorized persona. This test has to place its fixture there because that
 * store is the only allowlisted home for a *personal* recording, which is
 * exactly what the assertions below are about. Each fixture lives in its own
 * directory and is removed in afterEach.
 */
function withPersonalAccess<T>(fn: () => T): T {
  const savedPersona = process.env.KYBERION_PERSONA;
  process.env.KYBERION_PERSONA = 'sovereign';
  try {
    return fn();
  } finally {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
  }
}

function writeRecordingFixture(value: Record<string, unknown>): string {
  const dir = pathResolver.knowledge(`personal/browser-recordings/promotion-test-${randomUUID()}`);
  recordingDirs.push(dir);
  const filePath = path.join(dir, 'REC-personal-1.json');
  withPersonalAccess(() => {
    secureIo.safeMkdir(dir, { recursive: true });
    secureIo.safeWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  });
  return pathResolver.toRepoRelative(filePath);
}

describe('promoteBrowserProcedure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    withPersonalAccess(() => {
      while (recordingDirs.length > 0) {
        secureIo.safeRmSync(recordingDirs.pop() as string);
      }
    });
  });

  it('promotes an approved personal recording without writing the public catalog', () => {
    const recordingRef = writeRecordingFixture(recording);
    // Only the promotion's own writes are intercepted, so the personal catalog
    // under knowledge/ is never mutated by the test.
    vi.spyOn(secureIo, 'safeExistsSync').mockReturnValue(false);
    const mkdir = vi.spyOn(secureIo, 'safeMkdir').mockImplementation(() => undefined as any);
    const write = vi.spyOn(secureIo, 'safeWriteFile').mockImplementation(() => undefined);

    const result = withPersonalAccess(() =>
      promoteBrowserProcedure({
        recordingRef,
        procedureId: 'personal.example.continue',
        intentPhrases: ['Continue を押す', '続行'],
      })
    );

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
    // The golden scenario is stored in the same (personal) tier as the catalog.
    expect(result.procedureEntry.golden_scenario_ref).toBe(
      'knowledge/personal/golden/personal.example.continue.v1.0.0.json'
    );
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('knowledge/personal/golden/personal.example.continue.v1.0.0.json'),
      expect.stringContaining('"schema_version": "golden-scenario.v1"')
    );
  });

  it('refuses an unapproved recording', () => {
    const recordingRef = writeRecordingFixture({
      ...recording,
      review: { ...recording.review, status: 'pending' },
    });

    expect(() =>
      withPersonalAccess(() =>
        promoteBrowserProcedure({
          recordingRef,
          procedureId: 'personal.example.pending',
          intentPhrases: ['続行'],
        })
      )
    ).toThrow('approved');
  });
});
