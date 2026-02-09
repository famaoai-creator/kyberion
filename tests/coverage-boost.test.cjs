
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createLogger } = require('../scripts/lib/logger.cjs');

// We need to clear require cache for skill-wrapper to ensure we can manipulate process.argv before it runs specific logic if needed,
// though skill-wrapper functions read process.argv when called.
const skillWrapperPath = path.resolve(__dirname, '../scripts/lib/skill-wrapper.cjs');

// Helper to capture stdout/stderr/exit
function capture(fn) {
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalExit = process.exit;
  const originalLog = console.log;

  let stdout = '';
  let stderr = '';
  let exitCode = null;
  const logs = [];

  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  process.exit = (code) => { exitCode = code; throw new Error(`ProcessExit:${code}`); };
  console.log = (...args) => { logs.push(args.map(a => String(a)).join(' ')); };

  try {
    fn();
  } catch (e) {
    if (!e.message.startsWith('ProcessExit')) throw e;
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exit = originalExit;
    console.log = originalLog;
  }
  return { stdout, stderr, exitCode, logs };
}

// --- Logger Tests ---
console.log('--- Coverage Boost: Logger ---');
{
  const originalEnv = process.env.LOG_FORMAT;
  
  // Test JSON format
  process.env.LOG_FORMAT = 'json';
  const resultJson = capture(() => {
    const log = createLogger('test-json');
    log.info('test message', { foo: 'bar' });
  });
  assert.ok(resultJson.stderr.includes('"level":"info"'));
  assert.ok(resultJson.stderr.includes('"foo":"bar"'));
  assert.ok(resultJson.stderr.includes('"skill":"test-json"'));

  // Test text format with data
  process.env.LOG_FORMAT = '';
  const resultText = capture(() => {
    const log = createLogger('test-text');
    log.warn('warning message', { details: 123 });
  });
  assert.ok(resultText.stderr.includes('[WARN] [test-text] warning message {"details":123}'));

  // Test log level filtering
  const resultSilent = capture(() => {
    const log = createLogger('test-silent', { level: 'error' });
    log.info('should not appear');
    log.error('should appear');
  });
  assert.ok(!resultSilent.stderr.includes('should not appear'));
  assert.ok(resultSilent.stderr.includes('should appear'));

  process.env.LOG_FORMAT = originalEnv || '';
  console.log('  pass Logger JSON and filtering');
}

// --- Skill Wrapper Help Tests ---
console.log('--- Coverage Boost: Skill Wrapper Help ---');
{
  // Mock FS for SKILL.md
  const originalExists = fs.existsSync;
  const originalRead = fs.readFileSync;
  const originalReaddir = fs.readdirSync;

  const MOCK_SKILL = 'mock-skill';
  
  // Monkey patch FS
  fs.existsSync = (p) => {
    if (p.includes(MOCK_SKILL)) return true;
    return originalExists(p);
  };
    fs.readFileSync = (p, encoding) => {
      if (p.includes(MOCK_SKILL) && p.endsWith('SKILL.md')) {
        // console.log('Mocking SKILL.md for:', p);
        return `---\ndescription: A mock skill for testing\narguments:\n  - name: verbose\n    short: v\n    description: Enable verbose output\n    default: false\n    required: false\n  - name: mode\n    choices: [fast, slow]\n    description: Operation mode\n---\n# Mock Skill\n`;
      }
      return originalRead(p, encoding);
    };  fs.readdirSync = (p) => {
    if (p.includes(MOCK_SKILL) && p.includes('scripts')) return ['run.cjs'];
    return originalReaddir(p);
  };

  const { runSkill } = require(skillWrapperPath);
  const originalArgv = process.argv;

  // Test --help output
  process.argv = ['node', 'script', '--help'];
  const resultHelp = capture(() => {
    runSkill(MOCK_SKILL, () => {});
  });
  
  assert.strictEqual(resultHelp.exitCode, 0, 'Should exit 0 on help');
  const output = resultHelp.logs.join('\n');
  if (!output.includes('A mock skill for testing')) {
    console.log('--- DEBUG OUTPUT START ---');
    console.log(output);
    console.log('--- DEBUG OUTPUT END ---');
  }
  assert.ok(output.includes(MOCK_SKILL), 'Help should contain skill name');
  assert.ok(output.includes('A mock skill for testing'), 'Help should contain description');
  assert.ok(output.includes('--verbose, -v'), 'Help should contain arguments');
  assert.ok(output.includes('{fast, slow}'), 'Help should contain choices');

  // Test Human Format Output
  process.argv = ['node', 'script', '--format=human'];
  const resultHuman = capture(() => {
    runSkill(MOCK_SKILL, () => { return { result: 'human-readable' }; });
  });
  const humanOutput = resultHuman.logs.join('\n');
  assert.ok(humanOutput.includes('✅ mock-skill success'), 'Human format success header');
  assert.ok(humanOutput.includes('human-readable'), 'Human format data');

  // Test Error Suggestion
  process.argv = ['node', 'script'];
  const resultError = capture(() => {
    runSkill(MOCK_SKILL, () => { 
      const e = new Error('Cannot find module foo'); 
      throw e;
    });
  });
  assert.strictEqual(resultError.exitCode, 1, 'Should exit 1 on error');
  // Error output is via console.log in _printOutput -> _formatHuman (if format=human) OR JSON
  // Default is JSON.
  const jsonOutput = resultError.logs.join('\n'); // capture() redirects console.log to logs
  // wait, _printOutput uses console.log.
  // runSkill exits 1.
  
  // Let's check if the JSON error contains the suggestion
  try {
    const parsed = JSON.parse(jsonOutput);
    assert.strictEqual(parsed.status, 'error');
    assert.ok(parsed.error.suggestion, 'Should have suggestion for missing module');
    assert.ok(parsed.error.suggestion.includes('npm install'), 'Suggestion should verify npm install');
  } catch (e) {
    console.error('Failed to parse JSON output:', jsonOutput);
    throw e;
  }

  // Restore FS and Argv
  fs.existsSync = originalExists;
  fs.readFileSync = originalRead;
  fs.readdirSync = originalReaddir;
  process.argv = originalArgv;
  
  console.log('  pass Skill Wrapper Help & Formats');
}

