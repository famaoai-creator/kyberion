const { execSync } = require('child_process');
const { safeWriteFile, safeReadFile, safeMkdir, safeUnlinkSync } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');
const os = require('os');

const rootDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  pass  ${name}`);
    passed++;
  } catch (_err) {
    console.error(`  FAIL  ${name}: ${_err.message}`);
    failures.push(name);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

/**
 * Create a fresh temp directory for each test scenario within the repository.
 * Returns the absolute path.
 */
function makeTempDir(label) {
  const scratchDir = path.join(rootDir, 'scratch');
  if (!fs.existsSync(scratchDir)) safeMkdir(scratchDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratchDir, `plugin-test-${label}-`));
  return dir;
}

// ========================================
// Plugin integration: hooks are called
// ========================================
console.log('\n--- plugin system: hook invocation ---');

test('beforeSkill and afterSkill hooks are called during skill execution', () => {
  const tmpDir = makeTempDir('hooks');

  // Create a test input file for format-detector
  const inputFile = path.join(tmpDir, 'test-input.json');
  safeWriteFile(inputFile, JSON.stringify({ hello: 'world' }));

  // Create a plugin that writes a marker file when hooks are called
  const markerFile = path.join(tmpDir, 'hook-markers.json');
  const pluginFile = path.join(tmpDir, 'test-plugin.cjs');
  safeWriteFile(
    pluginFile,
    `
const { safeWriteFile } = require('@agent/core/secure-io');
const markers = { before: [], after: [] };
module.exports = {
  beforeSkill(skillName, args) {
    markers.before.push({ skill: skillName, ts: Date.now() });
    safeWriteFile(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
  afterSkill(skillName, output) {
    markers.after.push({ skill: skillName, status: output.status, ts: Date.now() });
    safeWriteFile(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
};
`
  );

  // Create .gemini-plugins.json pointing to the test plugin
  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  safeWriteFile(configFile, JSON.stringify({ plugins: [pluginFile] }));

  // Run format-detector
  const skillScript = path.join(rootDir, 'skills/utilities/format-detector/dist/index.js');
  const cmd = `node "${skillScript}" -i "${inputFile}"`;
  const raw = execSync(cmd, { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', `Skill should succeed, got ${envelope.status}`);

  assert(fs.existsSync(markerFile), 'Plugin marker file should exist');
  const markers = JSON.parse(safeReadFile(markerFile, 'utf8'));
  assert(markers.before.length === 1, 'beforeSkill called');
  assert(markers.after.length === 1, 'afterSkill called');

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('afterSkill receives error status when skill fails', () => {
  const tmpDir = makeTempDir('hooks-err');

  const markerFile = path.join(tmpDir, 'hook-markers-err.json');
  const pluginFile = path.join(tmpDir, 'err-plugin.cjs');
  safeWriteFile(
    pluginFile,
    `
const { safeWriteFile } = require('@agent/core/secure-io');
const markers = { before: [], after: [] };
module.exports = {
  beforeSkill(skillName, args) {
    markers.before.push({ skill: skillName });
    safeWriteFile(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
  afterSkill(skillName, output) {
    markers.after.push({ skill: skillName, status: output.status });
    safeWriteFile(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  safeWriteFile(configFile, JSON.stringify({ plugins: [pluginFile] }));

  const skillScript = path.join(rootDir, 'skills/utilities/format-detector/dist/index.js');
  const cmd = `node "${skillScript}" -i "/tmp/nonexistent_plugin_test_file_xyz.json"`;
  try { execSync(cmd, { encoding: 'utf8', cwd: tmpDir, timeout: 10000 }); } catch (_) {}

  assert(fs.existsSync(markerFile), 'Plugin marker file should exist on error path');
  const markers = JSON.parse(safeReadFile(markerFile, 'utf8'));
  assert(markers.after[0].status === 'error', 'afterSkill should receive error status');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('multiple plugins are loaded and all hooks are called', () => {
  const tmpDir = makeTempDir('multi');

  const inputFile = path.join(tmpDir, 'multi-input.json');
  safeWriteFile(inputFile, JSON.stringify({ multi: true }));

  const marker1 = path.join(tmpDir, 'marker1.json');
  const marker2 = path.join(tmpDir, 'marker2.json');

  const plugin1 = path.join(tmpDir, 'plugin1.cjs');
  safeWriteFile(plugin1, `
const { safeWriteFile } = require('@agent/core/secure-io');
module.exports = {
  afterSkill(skillName, output) {
    safeWriteFile(${JSON.stringify(marker1)}, JSON.stringify({ plugin: 1, skill: skillName }));
  },
};
`);

  const plugin2 = path.join(tmpDir, 'plugin2.cjs');
  safeWriteFile(plugin2, `
const { safeWriteFile } = require('@agent/core/secure-io');
module.exports = {
  afterSkill(skillName, output) {
    safeWriteFile(${JSON.stringify(marker2)}, JSON.stringify({ plugin: 2, skill: skillName }));
  },
};
`);

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  safeWriteFile(configFile, JSON.stringify({ plugins: [plugin1, plugin2] }));

  const skillScript = path.join(rootDir, 'skills/utilities/format-detector/dist/index.js');
  execSync(`node "${skillScript}" -i "${inputFile}"`, { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

  assert(fs.existsSync(marker1), 'Plugin 1 marker should exist');
  assert(fs.existsSync(marker2), 'Plugin 2 marker should exist');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('skill runs without errors when .gemini-plugins.json does not exist', () => {
  const tmpDir = makeTempDir('noconfig');
  const inputFile = path.join(tmpDir, 'input.json');
  safeWriteFile(inputFile, JSON.stringify({ key: 'value' }));

  const skillScript = path.join(rootDir, 'skills/utilities/format-detector/dist/index.js');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', 'Skill should succeed without plugins config');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('skill runs when .gemini-plugins.json contains invalid JSON', () => {
  const tmpDir = makeTempDir('badjson');
  const inputFile = path.join(tmpDir, 'input.json');
  safeWriteFile(inputFile, JSON.stringify({ badjson: true }));
  safeWriteFile(path.join(tmpDir, '.gemini-plugins.json'), '{ not valid json !!!');

  const skillScript = path.join(rootDir, 'skills/utilities/format-detector/dist/index.js');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', 'Skill should succeed with invalid config JSON');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`Plugin tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) process.exit(1);
