import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

// Differential test for the loader's direct TypeScript resolution
// (resolveTsSourceDirectly in scripts/ts-loader.mjs): with the switch on and
// off, every specifier must resolve to the same URL and load the same module.
let fixture: string;

const SPECIFIERS = [
  './a.js', // .js -> .ts rewrite
  './a', // extensionless
  './a.ts', // explicit .ts
  './b', // directory index.ts
  './b/index.js',
  './c.mjs', // -> .mts
  './d.cjs', // -> .cts
  './plain.js', // real .js stays on the default resolver
  './linked.js', // symlinked .ts: realpath, as the default resolver does
  '@agent/core/path-resolver', // workspace package (dist or source)
];

function runProbe(fastResolve: '1' | '0'): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-loader.mjs', path.join(fixture, 'probe.mts')],
    {
      cwd: pathResolver.rootDir(),
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        KYBERION_TS_LOADER_FAST_RESOLVE: fastResolve,
        KYBERION_TS_LOADER_CACHE: '0',
      },
    }
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  fixture = pathResolver.sharedTmp(
    `ts-loader-resolve-test/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  safeMkdir(path.join(fixture, 'b'), { recursive: true });
  safeMkdir(path.join(fixture, 'real'), { recursive: true });
  safeWriteFile(path.join(fixture, 'a.ts'), "export const id: string = 'a';\n");
  safeWriteFile(path.join(fixture, 'b', 'index.ts'), "export const id: string = 'b';\n");
  safeWriteFile(path.join(fixture, 'c.mts'), "export const id: string = 'c';\n");
  safeWriteFile(path.join(fixture, 'd.cts'), "exports.id = 'd' as string;\n");
  safeWriteFile(path.join(fixture, 'plain.js'), "export const id = 'plain';\n");
  safeWriteFile(path.join(fixture, 'real', 'linked.ts'), "export const id: string = 'linked';\n");
  safeSymlinkSync(path.join(fixture, 'real', 'linked.ts'), path.join(fixture, 'linked.ts'));
  safeWriteFile(path.join(fixture, 'package.json'), JSON.stringify({ type: 'module' }));
  safeWriteFile(
    path.join(fixture, 'probe.mts'),
    `const specifiers = ${JSON.stringify(SPECIFIERS)};
const out: Record<string, unknown> = {};
for (const specifier of specifiers) {
  const url = import.meta.resolve(specifier);
  const mod = await import(specifier);
  out[specifier] = { url, id: mod.id ?? mod.default?.id ?? Object.keys(mod).length };
}
process.stdout.write(JSON.stringify(out));
`
  );
});

afterAll(() => {
  safeRmSync(fixture, { recursive: true, force: true });
});

describe('ts-loader direct TypeScript resolution', () => {
  it('resolves and loads every specifier exactly as the default-resolver path does', () => {
    const fast = runProbe('1');
    const slow = runProbe('0');
    expect(fast.stderr).toBe('');
    expect(slow.stderr).toBe('');
    expect(fast.status).toBe(0);
    expect(slow.status).toBe(0);
    const fastOut = JSON.parse(fast.stdout);
    expect(fastOut).toEqual(JSON.parse(slow.stdout));
    expect(fastOut['./a.js'].id).toBe('a');
    expect(fastOut['./b'].id).toBe('b');
    expect(fastOut['./d.cjs'].id).toBe('d');
    expect(fastOut['./linked.js'].url).toContain('/real/linked.ts');
  }, 150_000);
});
