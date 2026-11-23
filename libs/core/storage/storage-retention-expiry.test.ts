import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { rotatedSegmentPath, rotatedSegmentStem } from './append-only-store.js';
import { randomUUID } from 'node:crypto';
import { rootDir } from '../path-resolver.js';
import {
  expireFilePerPolicy,
  isRotatedSegmentName,
  ROTATED_SEGMENT_SUFFIX_PATTERN,
} from './storage-retention-expiry.js';

describe('rotated segment naming (C-EXP-008)', () => {
  it('ROTATED_SEGMENT_SUFFIX_PATTERN matches plain and -<n> collision segments', () => {
    expect(ROTATED_SEGMENT_SUFFIX_PATTERN.test('items-20261101-123456.jsonl')).toBe(true);
    expect(ROTATED_SEGMENT_SUFFIX_PATTERN.test('items-20261101-123456-1.jsonl')).toBe(true);
    expect(ROTATED_SEGMENT_SUFFIX_PATTERN.test('items-20261101-123456-12.jsonl')).toBe(true);
    expect(ROTATED_SEGMENT_SUFFIX_PATTERN.test('items.jsonl')).toBe(false);
    expect(ROTATED_SEGMENT_SUFFIX_PATTERN.test('items-20261101-123456.json')).toBe(false);
  });

  it('isRotatedSegmentName recognises exactly the names rotatedSegmentPath produces for a stem', () => {
    const live = path.join('/x', 'items.jsonl');
    const stem = rotatedSegmentStem(live);
    const now = new Date('2026-11-01T12:34:56.000Z');
    const first = path.basename(rotatedSegmentPath(live, now));
    expect(isRotatedSegmentName(first, stem)).toBe(true);
    expect(isRotatedSegmentName('items-20261101-123456-3.jsonl', stem)).toBe(true);
    // Another store's segment, the live file, and stray names are not segments of `items`.
    expect(isRotatedSegmentName('items-archive-20261101-123456.jsonl', stem)).toBe(false);
    expect(isRotatedSegmentName('other-20261101-123456.jsonl', stem)).toBe(false);
    expect(isRotatedSegmentName('items.jsonl', stem)).toBe(false);
    expect(isRotatedSegmentName('items-20261101-123456-x.jsonl', stem)).toBe(false);
  });
});

describe('expiry of a file that is already gone', () => {
  it('treats a file removed before its expiry step as already expired, not as a failure', () => {
    const gone = path.join(rootDir(), 'active/shared/tmp', `expiry-gone-${randomUUID()}.txt`);
    const outcome = { deleted: [], softDeleted: [], archived: [] };
    expect(() => expireFilePerPolicy(gone, null, outcome)).not.toThrow();
    expect(outcome).toEqual({ deleted: [], softDeleted: [], archived: [] });
  });
});
