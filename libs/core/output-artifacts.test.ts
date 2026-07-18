import { describe, expect, it, vi } from 'vitest';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  compactStepOutputContext,
  DEFAULT_INLINE_OUTPUT_CHARS,
  offloadLargeOutput,
} from './output-artifacts.js';

describe('output-artifacts', () => {
  it('keeps small output inline', () => {
    expect(offloadLargeOutput('small', { maxInlineChars: 10 })).toBeNull();
  });

  it('offloads oversized output to shared tmp and returns a bounded reference', () => {
    const body = 'x'.repeat(DEFAULT_INLINE_OUTPUT_CHARS + 100);
    const recordArtifact = vi.fn();
    const reference = offloadLargeOutput(body, {
      stepOp: 'system:exec',
      stepNumber: 3,
      missionId: 'mission-oh04-test',
      recordArtifact,
    });

    expect(reference).toMatchObject({
      truncated: true,
      chars: body.length,
      media_type: 'text/plain',
    });
    expect(reference?.preview.length).toBeLessThan(body.length);
    expect(reference?.artifact_path).toMatch(/^active\/shared\/tmp\/tool-output\//);
    expect(reference?.artifact_path && safeExistsSync(reference.artifact_path)).toBe(true);
    expect(
      reference?.artifact_path && safeReadFile(reference.artifact_path, { encoding: 'utf8' })
    ).toBe(body);
    expect(recordArtifact).toHaveBeenCalledWith(
      reference?.artifact_path,
      expect.stringContaining('system:exec')
    );
  });

  it('compacts only the exported step channel', () => {
    const body = 'y'.repeat(300);
    const context = { input: body, exec_result: body };
    const compacted = compactStepOutputContext(context, ['exec_result'], {
      maxInlineChars: 100,
      stepOp: 'system:exec',
    });

    expect(compacted.input).toBe(body);
    expect(compacted.exec_result).toMatchObject({ truncated: true });
  });
});
