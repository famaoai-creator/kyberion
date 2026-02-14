/**
 * Shared test harness for Gemini Skills unit tests.
 *
 * Provides a minimal test runner compatible with the existing custom framework.
 * Usage:
 *   const { test, assert, run, runAndParse, writeTemp, harness } = require('./harness.cjs');
 *   test('my test', () => { assert(true, 'should pass'); });
 *   harness.report();  // call once at end
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

const rootDir = path.resolve(__dirname, '..');
const tmpDir = path.join(__dirname, '_tmp');

if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    const result = fn();
    // Support async tests
    if (result && typeof result.then === 'function') {
      result
        .then(() => {
          console.log(`  pass  ${name}`);
          passed++;
        })
        .catch((err) => {
          console.error(`  FAIL  ${name}: ${err.message}`);
          failures.push(name);
          failed++;
        });
    } else {
      console.log(`  pass  ${name}`);
      passed++;
    }
  } catch (err) {
    console.error(`  FAIL  ${name}: ${err.message}`);
    failures.push(name);
    failed++;
  }
}

test.skip = function (name, _fn) {
  console.log(`  skip  ${name}`);
};

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function run(skillScript, args) {
  const cmd = `node "${path.join(rootDir, skillScript)}" ${args}`;
  return execSync(cmd, { encoding: 'utf8', cwd: rootDir, timeout: 10000 });
}

function runAndParse(skillScript, args) {
  const raw = run(skillScript, args);
  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', `Skill failed: ${JSON.stringify(envelope.error)}`);
  return envelope;
}

function writeTemp(name, content) {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const harness = {
  get passed() {
    return passed;
  },
  get failed() {
    return failed;
  },
  get failures() {
    return failures;
  },
  /** Print summary and exit with appropriate code */
  report() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log(`Failed: ${failures.join(', ')}`);
      process.exit(1);
    }
  },
  /** Clean up tmp directory */
  cleanup() {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  },
  /** Merge counts from another harness-compatible module */
  merge(other) {
    passed += other.passed || 0;
    failed += other.failed || 0;
    failures.push(...(other.failures || []));
  },
  rootDir,
  tmpDir,
};

module.exports = { test, assert, run, runAndParse, writeTemp, harness };
