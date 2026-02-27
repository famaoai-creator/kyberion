const { test, assert, harness } = require('../../harness.cjs');
const fs = require('fs');
const path = require('path');
const ledger = require('@agent/core/ledger');

const TEST_LEDGER_PATH = path.resolve(__dirname, '../../../active/audit/governance-ledger.jsonl');

// Backup original ledger if exists
let backupPath = null;
if (fs.existsSync(TEST_LEDGER_PATH)) {
  backupPath = TEST_LEDGER_PATH + '.bak';
  fs.copyFileSync(TEST_LEDGER_PATH, backupPath);
}

// Clear ledger for testing
fs.writeFileSync(TEST_LEDGER_PATH, '');

console.log('--- ledger ---');

test('ledger records event and returns hash', () => {
  const hash = ledger.record('TEST_EVENT', { role: 'tester', data: 'foo' });
  assert(typeof hash === 'string', 'Hash should be string');
  assert(hash.length === 64, 'Hash should be 64 chars (sha256)');

  const content = fs.readFileSync(TEST_LEDGER_PATH, 'utf8');
  assert(content.includes('TEST_EVENT'), 'File should contain event type');
  assert(content.includes('foo'), 'File should contain payload');
});

test('ledger maintains integrity chain', () => {
  // Add a second event
  ledger.record('TEST_EVENT_2', { role: 'tester', data: 'bar' });

  const isValid = ledger.verifyIntegrity();
  assert(isValid === true, 'Integrity check should pass for valid chain');
});

test('ledger detects tampering', () => {
  // Tamper with the file
  const content = fs.readFileSync(TEST_LEDGER_PATH, 'utf8');
  const tampered = content.replace('foo', 'evil');
  fs.writeFileSync(TEST_LEDGER_PATH, tampered);

  const isValid = ledger.verifyIntegrity();
  assert(isValid === false, 'Integrity check should fail for tampered data');
});

// Restore backup
if (backupPath) {
  fs.copyFileSync(backupPath, TEST_LEDGER_PATH);
  fs.unlinkSync(backupPath);
} else {
  // If no original ledger existed, remove the test one
  if (fs.existsSync(TEST_LEDGER_PATH)) fs.unlinkSync(TEST_LEDGER_PATH);
}

if (require.main === module) {
  harness.report();
}
