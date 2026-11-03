import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeAppendFileSync,
  safeReadFileRange,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  IntelligenceObservationReadCache,
  readSafeObservationFile,
} from './intelligence-control-data';

const suffix = `${process.pid}-${Date.now()}`;
const target = pathResolver.sharedTmp(`intelligence-control-${suffix}.jsonl`);
const link = pathResolver.sharedTmp(`intelligence-control-${suffix}-link.jsonl`);
const projectionLink = pathResolver.sharedTmp(
  `intelligence-control-${suffix}-projection-link.jsonl`
);

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    safeRmSync(target, { force: true });
    safeRmSync(link, { force: true });
    safeRmSync(projectionLink, { force: true });
  });
});

describe('intelligence control observation boundary', () => {
  it('reads regular observation files but does not follow symlinks', () => {
    withExecutionContext('mission_controller', () => {
      safeWriteFile(target, '{"event":"safe"}\n');
      expect(readSafeObservationFile(target)).toContain('safe');
      safeSymlinkSync(target, link);
    });

    expect(readSafeObservationFile(link)).toBeNull();
  });

  it('reuses an append-offset projection and recovers from rotation and partial lines', () => {
    const first = JSON.stringify({ ts: '2026-10-07T00:00:00.000Z', event: 'first' }) + '\n';
    const second = JSON.stringify({ ts: '2026-10-07T00:00:01.000Z', event: 'second' }) + '\n';
    const ranges: Array<{ position: number; length: number }> = [];
    const reader = new IntelligenceObservationReadCache((file, position, length) => {
      ranges.push({ position, length });
      return safeReadFileRange(file, position, length);
    });

    withExecutionContext('mission_controller', () => safeWriteFile(target, first));
    expect(reader.read(target)).toEqual([JSON.parse(first)]);
    const initialBytes = ranges.reduce((sum, range) => sum + range.length, 0);
    expect(initialBytes).toBe(Buffer.byteLength(first));

    reader.beginSnapshot();
    expect(reader.read(target)).toEqual([JSON.parse(first)]);
    expect(ranges.reduce((sum, range) => sum + range.length, 0)).toBe(initialBytes);

    withExecutionContext('mission_controller', () => safeAppendFileSync(target, second));
    reader.beginSnapshot();
    expect(reader.read(target)).toEqual([JSON.parse(first), JSON.parse(second)]);
    expect(ranges.at(-1)).toEqual({
      position: Buffer.byteLength(first),
      length: Buffer.byteLength(second),
    });

    withExecutionContext('mission_controller', () => safeWriteFile(target, second));
    reader.beginSnapshot();
    expect(reader.read(target)).toEqual([JSON.parse(second)]);
    expect(ranges.at(-1)).toEqual({ position: 0, length: Buffer.byteLength(second) });

    const partial = second.trimEnd();
    withExecutionContext('mission_controller', () => safeWriteFile(target, partial));
    reader.beginSnapshot();
    expect(reader.read(target)).toEqual([]);
    withExecutionContext('mission_controller', () => safeAppendFileSync(target, '\n'));
    reader.beginSnapshot();
    expect(reader.read(target)).toEqual([JSON.parse(second)]);

    withExecutionContext('mission_controller', () => safeSymlinkSync(target, projectionLink));
    reader.beginSnapshot();
    expect(reader.read(projectionLink)).toEqual([]);
  });
});
