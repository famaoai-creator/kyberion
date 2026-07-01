import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  rootDir,
  capabilityEntry,
  capabilityDir,
  skillDir,
  resolve,
  toRepoRelative,
  normalizeStoredPath,
} from './path-resolver.js';

describe('path-resolver core', () => {
  it('should find the project root', () => {
    const root = rootDir();
    expect(root).toBeDefined();
    expect(resolve('package.json')).toBe(path.join(root, 'package.json'));
    expect(path.isAbsolute(root)).toBe(true);
  });

  it('should resolve capability directory via actuator index', () => {
    const dir = capabilityDir('security-scanner');
    expect(dir).toContain('security-scanner');
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it('should resolve built capability entry path', () => {
    const entry = capabilityEntry('system-actuator');
    expect(entry).toContain(path.join('dist', 'libs', 'actuators', 'system-actuator', 'src', 'index.js'));
    expect(path.isAbsolute(entry)).toBe(true);
  });

  it('should resolve skill directory via index or default path', () => {
    const dir = skillDir('security-scanner');
    expect(dir).toContain('security-scanner');
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it('should resolve logical capability:// protocol', () => {
    const logical = 'capability://security-scanner/src/index.ts';
    const physical = resolve(logical);
    expect(physical).toContain('security-scanner');
    expect(physical.endsWith('src/index.ts')).toBe(true);
    expect(path.isAbsolute(physical)).toBe(true);
  });

  it('should resolve logical skill:// protocol', () => {
    const logical = 'skill://security-scanner/src/index.ts';
    const physical = resolve(logical);
    expect(physical).toContain('security-scanner');
    expect(physical.endsWith('src/index.ts')).toBe(true);
    expect(path.isAbsolute(physical)).toBe(true);
  });

  it('should handle absolute paths correctly', () => {
    const abs = '/tmp/test-path-resolver';
    expect(resolve(abs)).toBe(abs);
  });

  it('should resolve relative paths against project root', () => {
    const rel = 'knowledge/README.md';
    const physical = resolve(rel);
    expect(physical).toBe(path.join(rootDir(), rel));
  });
});

describe('path-resolver portability helpers', () => {
  it('toRepoRelative collapses an absolute path under the root to a repo-relative one', () => {
    const abs = path.join(rootDir(), 'knowledge', 'README.md');
    expect(toRepoRelative(abs)).toBe(path.join('knowledge', 'README.md'));
  });

  it('toRepoRelative leaves a foreign absolute path unchanged', () => {
    const foreign = path.join('/', 'opt', 'somewhere-else', 'file.txt');
    expect(toRepoRelative(foreign)).toBe(foreign);
  });

  it('toRepoRelative leaves an already-relative path unchanged', () => {
    expect(toRepoRelative('knowledge/x.md')).toBe('knowledge/x.md');
  });

  it('toRepoRelative is the inverse of resolve for in-repo paths', () => {
    const rel = path.join('libs', 'core', 'path-resolver.ts');
    expect(toRepoRelative(resolve(rel))).toBe(rel);
  });

  it('normalizeStoredPath relativizes an in-repo absolute path and flags nothing', () => {
    const abs = path.join(rootDir(), 'scripts', 'run.ts');
    expect(normalizeStoredPath(abs)).toEqual({ path: path.join('scripts', 'run.ts'), foreign: false });
  });

  it('normalizeStoredPath flags a foreign absolute path without rewriting it', () => {
    const foreign = path.join('/', 'opt', 'elsewhere', 'data.json');
    expect(normalizeStoredPath(foreign)).toEqual({ path: foreign, foreign: true });
  });

  it('normalizeStoredPath passes relative paths through unflagged', () => {
    expect(normalizeStoredPath('active/shared/x.json')).toEqual({ path: 'active/shared/x.json', foreign: false });
  });
});
