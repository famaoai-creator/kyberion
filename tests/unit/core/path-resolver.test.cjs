const { test, assert, harness } = require('../../harness.cjs');
const path = require('path');
const pathResolver = require('@agent/core/path-resolver');

console.log('--- path-resolver ---');

test('pathResolver finds project root', () => {
  const root = pathResolver.rootDir();
  assert(root.endsWith('gemini-skills'), `Root should be gemini-skills, got ${root}`);
  assert(path.isAbsolute(root), 'Root should be absolute');
});

test('pathResolver resolves skill directory via index', () => {
  // Assuming security-scanner exists and is indexed
  const dir = pathResolver.skillDir('security-scanner');
  assert(
    dir.includes('skills/audit/security-scanner'),
    `Should resolve to audit namespace, got ${dir}`
  );
});

test('pathResolver resolves logical skill:// protocol', () => {
  const logical = 'skill://security-scanner/scripts/scan.cjs';
  const physical = pathResolver.resolve(logical);
  assert(
    physical.includes('skills/audit/security-scanner/scripts/scan.cjs'),
    `Should resolve logical path, got ${physical}`
  );
});

test('pathResolver handles absolute paths correctly', () => {
  const abs = '/tmp/test';
  const resolved = pathResolver.resolve(abs);
  assert(resolved === abs, 'Should return absolute path as is');
});

if (require.main === module) {
  harness.report();
}
