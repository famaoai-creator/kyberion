import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateUnattendedRepair,
  measureVerifier,
  restoreRepairSnapshot,
  saveRepairSnapshot,
} from './repair-assurance.js';
import { safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { resolveStorageFloor } from '../storage-layout.js';

const samples = [
  { id: 'valid-a', value: 1, expected: true },
  { id: 'valid-b', value: 2, expected: true },
  { id: 'invalid-a', value: -1, expected: false },
  { id: 'invalid-b', value: -2, expected: false },
];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('measured verifier and saved-version recoverability', () => {
  it.each([true, false])(
    'rejects constant %s verifiers rather than accepting healthy-looking scores',
    (answer) => {
      const measurement = measureVerifier(samples, () => answer);
      expect(measurement.discriminates).toBe(false);
      expect(measurement.agreement).toBe(0.5);
      expect(
        evaluateUnattendedRepair({ measurement, snapshotVerified: true, externalEffects: false })
          .allowed
      ).toBe(false);
    }
  );
  it('rejects measured false admissions, missing snapshots and external effects', () => {
    const faulty = measureVerifier(samples, (value) => value !== -2);
    expect(faulty.false_admits).toBe(1);
    expect(
      evaluateUnattendedRepair({
        measurement: faulty,
        snapshotVerified: true,
        externalEffects: false,
      }).allowed
    ).toBe(false);
    const measurement = measureVerifier(samples, (value) => Number(value) > 0);
    expect(measurement.agreement).toBe(1);
    expect(
      evaluateUnattendedRepair({ measurement, snapshotVerified: false, externalEffects: false })
        .allowed
    ).toBe(false);
    expect(
      evaluateUnattendedRepair({ measurement, snapshotVerified: true, externalEffects: true })
        .allowed
    ).toBe(false);
    expect(
      evaluateUnattendedRepair({ measurement, snapshotVerified: true, externalEffects: false })
        .allowed
    ).toBe(true);
  });
  it('restores exactly saved bytes, never a generated inverse edit', () => {
    const root = resolveStorageFloor(
      'scratch',
      { kind: 'tier', tier: 'public' },
      'repair-assurance-tests',
      `exact-${process.pid}`
    );
    roots.push(root);
    const target = path.join(root, 'target.json');
    const original = Buffer.from('{ "version": 1 }\r\n\t');
    safeWriteFile(target, original, { mkdir: true });
    const snapshot = saveRepairSnapshot(target);
    roots.push(path.dirname(pathResolver.rootResolve(snapshot.snapshot_ref)));
    safeWriteFile(target, '{"version":999}');
    restoreRepairSnapshot(snapshot);
    expect(safeReadFile(target, { encoding: null })).toEqual(original);
    expect(() => restoreRepairSnapshot({ ...snapshot })).toThrow('not issued by this repair host');
  });
  it('refuses a corrupted saved version', () => {
    const root = resolveStorageFloor(
      'scratch',
      { kind: 'tier', tier: 'public' },
      'repair-assurance-tests',
      `corrupt-${process.pid}`
    );
    roots.push(root);
    const target = path.join(root, 'target.json');
    safeWriteFile(target, 'old bytes', { mkdir: true });
    const snapshot = saveRepairSnapshot(target);
    roots.push(path.dirname(pathResolver.rootResolve(snapshot.snapshot_ref)));
    safeWriteFile(pathResolver.rootResolve(snapshot.snapshot_ref), 'tampered snapshot');
    safeWriteFile(target, 'new bytes');
    expect(() => restoreRepairSnapshot(snapshot)).toThrow('snapshot digest mismatch');
    expect(String(safeReadFile(target))).toBe('new bytes');
  });
});
