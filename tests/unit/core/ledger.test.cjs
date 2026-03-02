const { test, assert, harness } = require('../../harness.cjs');
const { safeWriteFile, safeReadFile, safeUnlinkSync } = require('@agent/core/secure-io');
const fs = require('fs');
const path = require('path');
const ledger = require('@agent/core/ledger');

const TEST_LEDGER_PATH = path.resolve(__dirname, '../../../active/audit/governance-ledger.jsonl');

// Backup original ledger if exists using safe IO
let backupContent = null;
if (fs.existsSync(TEST_LEDGER_PATH)) {
  backupContent = safeReadFile(TEST_LEDGER_PATH);
}

// Clear ledger for testing
safeWriteFile(TEST_LEDGER_PATH, '');

console.log('--- ledger ---');

test('ledger records event and returns hash', () => {
  const hash = ledger.record('TEST_EVENT', { role: 'tester', data: 'foo' });
  assert(typeof hash === 'string', 'Hash should be string');
  assert(hash.length === 64, 'Hash should be 64 chars (sha256)');

  const content = safeReadFile(TEST_LEDGER_PATH, 'utf8');
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
  const content = safeReadFile(TEST_LEDGER_PATH, 'utf8');
  const tampered = content.replace('foo', 'evil');
  safeWriteFile(TEST_LEDGER_PATH, tampered);

  const isValid = ledger.verifyIntegrity();
  assert(isValid === false, 'Integrity check should fail for tampered data');
});

// Restore backup
if (backupContent) {
  safeWriteFile(TEST_LEDGER_PATH, backupContent);
} else {
  // If no original ledger existed, remove the test one
  if (fs.existsSync(TEST_LEDGER_PATH)) safeUnlinkSync(TEST_LEDGER_PATH);
}

if (require.main === module) {
  harness.report();
}
