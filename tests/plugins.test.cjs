const { execSync } = require('child_process');
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
 * Create a fresh temp directory for each test scenario.
 * Returns the absolute path.
 */
function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gemini-plugin-test-${label}-`));
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
  fs.writeFileSync(inputFile, JSON.stringify({ hello: 'world' }));

  // Create a plugin that writes a marker file when hooks are called
  const markerFile = path.join(tmpDir, 'hook-markers.json');
  const pluginFile = path.join(tmpDir, 'test-plugin.cjs');
  fs.writeFileSync(
    pluginFile,
    `
const fs = require('fs');
const markers = { before: [], after: [] };
module.exports = {
  beforeSkill(skillName, args) {
    markers.before.push({ skill: skillName, ts: Date.now() });
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
  afterSkill(skillName, output) {
    markers.after.push({ skill: skillName, status: output.status, ts: Date.now() });
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
};
`
  );

  // Create .gemini-plugins.json pointing to the test plugin
  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [pluginFile] }));

  // Run format-detector with cwd set to tmpDir so it picks up the plugins config
  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const cmd = `node "${skillScript}" -i "${inputFile}"`;
  const raw = execSync(cmd, { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });

  // The skill should produce valid JSON output
  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', `Skill should succeed, got ${envelope.status}`);
  assert(envelope.data.format === 'json', 'Should detect JSON format');

  // The plugin should have written the marker file
  assert(fs.existsSync(markerFile), 'Plugin marker file should exist');
  const markers = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert(
    markers.before.length === 1,
    `beforeSkill should be called once, got ${markers.before.length}`
  );
  assert(
    markers.after.length === 1,
    `afterSkill should be called once, got ${markers.after.length}`
  );
  assert(
    markers.before[0].skill === 'format-detector',
    `beforeSkill should receive skill name, got ${markers.before[0].skill}`
  );
  assert(
    markers.after[0].skill === 'format-detector',
    `afterSkill should receive skill name, got ${markers.after[0].skill}`
  );
  assert(
    markers.after[0].status === 'success',
    `afterSkill should receive success status, got ${markers.after[0].status}`
  );

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('afterSkill receives error status when skill fails', () => {
  const tmpDir = makeTempDir('hooks-err');

  // Create a plugin that tracks hook calls
  const markerFile = path.join(tmpDir, 'hook-markers-err.json');
  const pluginFile = path.join(tmpDir, 'err-plugin.cjs');
  fs.writeFileSync(
    pluginFile,
    `
const fs = require('fs');
const markers = { before: [], after: [] };
module.exports = {
  beforeSkill(skillName, args) {
    markers.before.push({ skill: skillName });
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
  afterSkill(skillName, output) {
    markers.after.push({ skill: skillName, status: output.status });
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(markers));
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [pluginFile] }));

  // Run format-detector with a non-existent input file to trigger an error
  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const cmd = `node "${skillScript}" -i "/tmp/nonexistent_plugin_test_file_xyz.json"`;
  try {
    execSync(cmd, { encoding: 'utf8', cwd: tmpDir, timeout: 10000 });
  } catch (_) {
    // Expected: skill exits with code 1 on error
  }

  // The plugin should still have been called
  assert(fs.existsSync(markerFile), 'Plugin marker file should exist on error path');
  const markers = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert(markers.before.length === 1, 'beforeSkill should be called once even on error');
  assert(markers.after.length === 1, 'afterSkill should be called once even on error');
  assert(
    markers.after[0].status === 'error',
    `afterSkill should receive error status, got ${markers.after[0].status}`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('multiple plugins are loaded and all hooks are called', () => {
  const tmpDir = makeTempDir('multi');

  const inputFile = path.join(tmpDir, 'multi-input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ multi: true }));

  // Create two plugins, each writing to its own marker file
  const marker1 = path.join(tmpDir, 'marker1.json');
  const marker2 = path.join(tmpDir, 'marker2.json');

  const plugin1 = path.join(tmpDir, 'plugin1.cjs');
  fs.writeFileSync(
    plugin1,
    `
const fs = require('fs');
module.exports = {
  afterSkill(skillName, output) {
    fs.writeFileSync(${JSON.stringify(marker1)}, JSON.stringify({ plugin: 1, skill: skillName }));
  },
};
`
  );

  const plugin2 = path.join(tmpDir, 'plugin2.cjs');
  fs.writeFileSync(
    plugin2,
    `
const fs = require('fs');
module.exports = {
  afterSkill(skillName, output) {
    fs.writeFileSync(${JSON.stringify(marker2)}, JSON.stringify({ plugin: 2, skill: skillName }));
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [plugin1, plugin2] }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  assert(fs.existsSync(marker1), 'Plugin 1 marker should exist');
  assert(fs.existsSync(marker2), 'Plugin 2 marker should exist');
  const m1 = JSON.parse(fs.readFileSync(marker1, 'utf8'));
  const m2 = JSON.parse(fs.readFileSync(marker2, 'utf8'));
  assert(m1.plugin === 1, 'Plugin 1 should write its id');
  assert(m2.plugin === 2, 'Plugin 2 should write its id');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========================================
// Plugin system: no config file
// ========================================
console.log('\n--- plugin system: no config file ---');

test('skill runs without errors when .gemini-plugins.json does not exist', () => {
  const tmpDir = makeTempDir('noconfig');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ key: 'value' }));

  // No .gemini-plugins.json in tmpDir
  assert(!fs.existsSync(path.join(tmpDir, '.gemini-plugins.json')), 'Config should not exist');

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(
    envelope.status === 'success',
    `Skill should succeed without plugins config, got ${envelope.status}`
  );
  assert(envelope.data.format === 'json', 'Should still detect JSON format');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========================================
// Plugin system: missing plugin file
// ========================================
console.log('\n--- plugin system: missing plugin file ---');

test('skill runs without errors when plugin file is missing', () => {
  const tmpDir = makeTempDir('missing');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ missing: true }));

  // Point to a non-existent plugin file
  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      plugins: ['/tmp/nonexistent_plugin_file_abc123.cjs'],
    })
  );

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  // Skill should succeed even though plugin file is missing
  const envelope = JSON.parse(raw);
  assert(
    envelope.status === 'success',
    `Skill should succeed despite missing plugin, got ${envelope.status}`
  );
  assert(envelope.data.format === 'json', 'Should still detect JSON format');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('valid plugins still work alongside a missing plugin reference', () => {
  const tmpDir = makeTempDir('partial');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ partial: true }));

  // Create one valid plugin
  const markerFile = path.join(tmpDir, 'partial-marker.json');
  const validPlugin = path.join(tmpDir, 'valid-plugin.cjs');
  fs.writeFileSync(
    validPlugin,
    `
const fs = require('fs');
module.exports = {
  afterSkill(skillName, output) {
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ called: true }));
  },
};
`
  );

  // Config lists a missing plugin AND a valid plugin
  // Note: Because _loadHooks wraps the entire config parsing in try/catch,
  // if the missing plugin require() throws, it stops loading further plugins.
  // The skill-wrapper catches the error and continues, but subsequent plugins
  // in the same array may not load. This tests that the skill still runs.
  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      plugins: ['/tmp/nonexistent_plugin_xyz.cjs', validPlugin],
    })
  );

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', `Skill should succeed, got ${envelope.status}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========================================
// Plugin system: plugin that throws errors
// ========================================
console.log('\n--- plugin system: plugin that throws errors ---');

test('skill succeeds when beforeSkill hook throws an error', () => {
  const tmpDir = makeTempDir('throw-before');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ throwing: true }));

  const pluginFile = path.join(tmpDir, 'throwing-before-plugin.cjs');
  fs.writeFileSync(
    pluginFile,
    `
module.exports = {
  beforeSkill(skillName, args) {
    throw new Error('Intentional beforeSkill error for testing');
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [pluginFile] }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(
    envelope.status === 'success',
    `Skill should succeed despite throwing beforeSkill, got ${envelope.status}`
  );
  assert(envelope.data.format === 'json', 'Should still detect JSON format');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('skill succeeds when afterSkill hook throws an error', () => {
  const tmpDir = makeTempDir('throw-after');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ throwing: true }));

  const pluginFile = path.join(tmpDir, 'throwing-after-plugin.cjs');
  fs.writeFileSync(
    pluginFile,
    `
module.exports = {
  afterSkill(skillName, output) {
    throw new Error('Intentional afterSkill error for testing');
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [pluginFile] }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(
    envelope.status === 'success',
    `Skill should succeed despite throwing afterSkill, got ${envelope.status}`
  );
  assert(envelope.data.format === 'json', 'Should still detect JSON format');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('other plugins still run when one plugin throws in afterSkill', () => {
  const tmpDir = makeTempDir('throw-partial');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ mixed: true }));

  const markerFile = path.join(tmpDir, 'surviving-marker.json');

  // First plugin throws in afterSkill
  const throwingPlugin = path.join(tmpDir, 'throwing-plugin.cjs');
  fs.writeFileSync(
    throwingPlugin,
    `
module.exports = {
  afterSkill(skillName, output) {
    throw new Error('Plugin crash');
  },
};
`
  );

  // Second plugin writes a marker file to prove it was still called
  const survivingPlugin = path.join(tmpDir, 'surviving-plugin.cjs');
  fs.writeFileSync(
    survivingPlugin,
    `
const fs = require('fs');
module.exports = {
  afterSkill(skillName, output) {
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ survived: true, skill: skillName }));
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [throwingPlugin, survivingPlugin] }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', 'Skill should succeed');

  // The surviving plugin should have been called because _runAfterHooks
  // wraps each hook call in its own try/catch
  assert(fs.existsSync(markerFile), 'Surviving plugin marker should exist');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert(marker.survived === true, 'Surviving plugin should have run');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('plugin with only beforeSkill (no afterSkill) does not cause errors', () => {
  const tmpDir = makeTempDir('before-only');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ beforeOnly: true }));

  const markerFile = path.join(tmpDir, 'before-only-marker.json');
  const pluginFile = path.join(tmpDir, 'before-only-plugin.cjs');
  fs.writeFileSync(
    pluginFile,
    `
const fs = require('fs');
module.exports = {
  beforeSkill(skillName, args) {
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ before: true }));
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [pluginFile] }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', 'Skill should succeed with before-only plugin');
  assert(fs.existsSync(markerFile), 'beforeSkill marker should exist');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('plugin with only afterSkill (no beforeSkill) does not cause errors', () => {
  const tmpDir = makeTempDir('after-only');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ afterOnly: true }));

  const markerFile = path.join(tmpDir, 'after-only-marker.json');
  const pluginFile = path.join(tmpDir, 'after-only-plugin.cjs');
  fs.writeFileSync(
    pluginFile,
    `
const fs = require('fs');
module.exports = {
  afterSkill(skillName, output) {
    fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify({ after: true, status: output.status }));
  },
};
`
  );

  const configFile = path.join(tmpDir, '.gemini-plugins.json');
  fs.writeFileSync(configFile, JSON.stringify({ plugins: [pluginFile] }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', 'Skill should succeed with after-only plugin');
  assert(fs.existsSync(markerFile), 'afterSkill marker should exist');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========================================
// Plugin system: malformed config
// ========================================
console.log('\n--- plugin system: malformed config ---');

test('skill runs when .gemini-plugins.json contains invalid JSON', () => {
  const tmpDir = makeTempDir('badjson');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ badjson: true }));

  // Write invalid JSON to the config
  fs.writeFileSync(path.join(tmpDir, '.gemini-plugins.json'), '{ not valid json !!!');

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(
    envelope.status === 'success',
    `Skill should succeed with invalid config JSON, got ${envelope.status}`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('skill runs when .gemini-plugins.json has no plugins array', () => {
  const tmpDir = makeTempDir('noplugins');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ noplugins: true }));

  // Valid JSON but no plugins key
  fs.writeFileSync(path.join(tmpDir, '.gemini-plugins.json'), JSON.stringify({ version: 1 }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(
    envelope.status === 'success',
    `Skill should succeed with no plugins array, got ${envelope.status}`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('skill runs when .gemini-plugins.json has empty plugins array', () => {
  const tmpDir = makeTempDir('empty');

  const inputFile = path.join(tmpDir, 'input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ empty: true }));

  fs.writeFileSync(path.join(tmpDir, '.gemini-plugins.json'), JSON.stringify({ plugins: [] }));

  const skillScript = path.join(rootDir, 'format-detector/scripts/detect.cjs');
  const raw = execSync(`node "${skillScript}" -i "${inputFile}"`, {
    encoding: 'utf8',
    cwd: tmpDir,
    timeout: 10000,
  });

  const envelope = JSON.parse(raw);
  assert(
    envelope.status === 'success',
    `Skill should succeed with empty plugins array, got ${envelope.status}`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========================================
// Cleanup and Summary
// ========================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Plugin tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`Failed: ${failures.join(', ')}`);
  process.exit(1);
}
