import { resolve, join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
await import(pathToFileURL(resolve('libs/core/dist/authority.js')).href);
const io = await import(pathToFileURL(resolve('libs/core/dist/secure-io.js')).href);
const { findStaleDistTargets } = await import(
  pathToFileURL(resolve('scripts/check_stale_dist.ts')).href
);
const { findSourceShadows } = await import(
  pathToFileURL(resolve('scripts/check_source_shadows.ts')).href
);
const { OWNED_BUILD_DIRECTORIES, OWNED_BUILD_METADATA } = await import(
  pathToFileURL(resolve('scripts/build-output-layout.ts')).href
);
const root = resolve('active/shared/tmp/build-output-evaluation/incremental-fixture');
const rel = relative(process.cwd(), root);
const result = [];
const write = (p, data) => {
  io.safeMkdir(dirname(join(root, p)), { recursive: true });
  io.safeWriteFile(
    join(root, p),
    typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n'
  );
};
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const compile = (...projects) => {
  const run = io.safeExecResult(
    process.execPath,
    [resolve('node_modules/typescript/bin/tsc'), '-b', ...projects.map((p) => join(root, p))],
    { cwd: process.cwd(), timeoutMs: 60000, maxBuffer: 1024 * 1024 }
  );
  assert(run.status === 0, JSON.stringify(run));
};
const clean = () => {
  for (const p of [...OWNED_BUILD_DIRECTORIES, ...OWNED_BUILD_METADATA])
    io.safeRmSync(join(root, p), { recursive: true, force: true });
};
const manifest = () => {
  const files = {};
  const walk = (dir) => {
    if (!io.safeExistsSync(dir)) return;
    for (const name of io.safeReaddir(dir).sort()) {
      const p = join(dir, name);
      if (io.safeLstat(p).isDirectory()) walk(p);
      else if (!name.includes('tsbuildinfo'))
        files[relative(root, p)] = createHash('sha256').update(io.safeReadFile(p)).digest('hex');
    }
  };
  walk(join(root, 'dist'));
  walk(join(root, 'libs/core/dist'));
  return files;
};
const smoke = () => {
  const r = io.safeExecResult(process.execPath, [join(root, 'dist/main.js')], {
    cwd: root,
    timeoutMs: 10000,
  });
  assert(r.status === 0 && r.stdout.trim() === '31', JSON.stringify(r));
};
const freshness = () =>
  findStaleDistTargets({
    targets: [
      {
        id: 'fixture-library',
        sourceRoot: rel + '/libs/core/src',
        distRoot: rel + '/libs/core/dist',
        buildInfo: [rel + '/libs/core/dist/.tsbuildinfo'],
        required: true,
        checkOrphans: true,
      },
    ],
  }).stale;
io.safeRmSync(root, { recursive: true, force: true });
write('package.json', { type: 'module' });
const common = {
  target: 'ES2022',
  module: 'Node16',
  moduleResolution: 'Node16',
  types: [],
  skipLibCheck: true,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  incremental: true,
};
write('libs/core/tsconfig.json', {
  compilerOptions: {
    ...common,
    rootDir: 'src',
    outDir: 'dist',
    composite: true,
    tsBuildInfoFile: 'dist/.tsbuildinfo',
  },
  include: ['src/**/*.ts'],
});
write('tsconfig.json', {
  compilerOptions: {
    ...common,
    rootDir: 'src',
    outDir: 'dist',
    tsBuildInfoFile: 'dist/.tsbuildinfo',
  },
  include: ['src/**/*.ts'],
  references: [{ path: './libs/core' }],
});
write('libs/core/src/value.ts', 'export const value = 31;\n');
write('src/main.ts', "import { value } from '../libs/core/dist/value.js';\nconsole.log(value);\n");
compile('tsconfig.json');
smoke();
const initial = manifest();
result.push({ phase: 'clean-full', files: Object.keys(initial).length });
clean();
compile('libs/core/tsconfig.json');
compile('tsconfig.json');
smoke();
assert(
  JSON.stringify(manifest()) === JSON.stringify(initial),
  'Ordered build differs from clean full'
);
result.push({ phase: 'package-ordered', equal: true });
compile('tsconfig.json');
assert(JSON.stringify(manifest()) === JSON.stringify(initial), 'Incremental build changed outputs');
result.push({ phase: 'no-change-incremental', equal: true });
write('libs/core/src/added.ts', 'export const added = 7;\n');
compile('tsconfig.json');
assert(io.safeExistsSync(join(root, 'libs/core/dist/added.js')), 'Added source not emitted');
assert(freshness().length === 0, 'Added source freshness mismatch');
result.push({ phase: 'source-add', emitted: true });
write('libs/core/src/renamed.ts', 'export const added = 7;\n');
io.safeRmSync(join(root, 'libs/core/src/added.ts'));
compile('tsconfig.json');
assert(io.safeExistsSync(join(root, 'libs/core/dist/renamed.js')), 'Renamed source not emitted');
assert(freshness()[0]?.reason === 'orphaned_emit', 'Rename obsolete emit not detected');
result.push({ phase: 'source-rename', obsoleteEmitDetected: true });
io.safeRmSync(join(root, 'libs/core/src/renamed.ts'));
compile('tsconfig.json');
assert(freshness()[0]?.reason === 'orphaned_emit', 'Delete obsolete emit not detected');
result.push({ phase: 'source-delete', obsoleteEmitDetected: true });
clean();
compile('tsconfig.json');
smoke();
assert(freshness().length === 0, 'Fresh build not clean');
assert(
  JSON.stringify(manifest()) === JSON.stringify(initial),
  'Clean did not remove obsolete emits'
);
assert(findSourceShadows(root, ['libs', 'src']).length === 0, 'Source pollution');
result.push({ phase: 'clean-after-delete', equalToInitial: true, sourceShadows: 0 });
io.safeWriteFile(
  resolve('active/shared/tmp/build-output-evaluation/incremental-fixture-result.json'),
  JSON.stringify({ result, initialManifest: initial }, null, 2) + '\n'
);
console.log(JSON.stringify(result, null, 2));
