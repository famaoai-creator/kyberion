import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeMkdir, safeWriteFile } from '../secure-io.js';
import { isValidRelPath, validateOverlay, type SurfaceSpec } from './surface-spec.js';

const root = path.join(process.cwd(), 'active/shared/tmp/harnessing-surface-test');
const spec: SurfaceSpec = {
  allowed_paths: ['config/', 'skills/*.md'],
  max_files: 5,
  max_file_bytes: 1024,
};

function write(rel: string, content = 'x'): void {
  const target = path.join(root, 'ov', rel);
  safeMkdir(path.dirname(target), { recursive: true });
  safeWriteFile(target, content);
}

describe('validateOverlay', () => {
  it('accepts files inside the surface', () => {
    safeMkdir(path.join(root, 'ov'), { recursive: true });
    write('config/app.json');
    write('skills/skill.md');
    const v = validateOverlay(path.join(root, 'ov'), spec);
    expect(v.ok).toBe(true);
    expect(v.accepted_files).toHaveLength(2);
  });
  it('rejects off-surface files with reasons', () => {
    safeMkdir(path.join(root, 'ov2'), { recursive: true });
    write('../x', 'y'); // would escape — write it outside 'ov2' guard below instead
    const target = path.join(root, 'ov2', 'evil/hack.sh');
    safeMkdir(path.dirname(target), { recursive: true });
    safeWriteFile(target, 'rm');
    const v = validateOverlay(path.join(root, 'ov2'), spec);
    expect(v.ok).toBe(false);
    expect(v.rejected_files[0].reason).toBe('off-surface path');
  });
  it('rejects oversized files', () => {
    safeMkdir(path.join(root, 'ov3'), { recursive: true });
    const target = path.join(root, 'ov3', 'config/big.json');
    safeMkdir(path.dirname(target), { recursive: true });
    safeWriteFile(target, 'x'.repeat(2048));
    const v = validateOverlay(path.join(root, 'ov3'), spec);
    expect(v.ok).toBe(false);
    expect(v.rejected_files[0].reason).toMatch(/max_file_bytes/);
  });
});

describe('isValidRelPath', () => {
  it('rejects traversal and absolute paths', () => {
    expect(isValidRelPath('a/b.txt')).toBe(true);
    expect(isValidRelPath('../evil')).toBe(false);
    expect(isValidRelPath('/abs')).toBe(false);
    expect(isValidRelPath('')).toBe(false);
  });
});

describe('validateOverlay — review coverage', () => {
  it('missing overlay dir returns structured rejection, not a throw', () => {
    const v = validateOverlay(path.join(root, 'nonexistent-dir'), spec);
    expect(v.ok).toBe(false);
    expect(v.rejected_files[0].reason).toBe('overlay dir missing');
  });
  it('backslash path is rejected as unsafe', () => {
    expect(isValidRelPath('a\\..\\evil')).toBe(false);
  });
});
