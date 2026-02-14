/**
 * Standalone tests for @agent/core/secure-io module.
 *
 * Extracted from the monolithic unit.test.cjs for independent execution.
 * Run: node tests/unit/secure-io.test.cjs
 */

const { test, assert, writeTemp, harness } = require('../harness.cjs');
const fs = require('fs');
const path = require('path');

// ========================================
// validateFileSize
// ========================================
console.log('\n--- validateFileSize ---');

test('validateFileSize returns size for small file', () => {
  const { validateFileSize } = require('@agent/core/secure-io');
  const smallFile = writeTemp('small-file.txt', 'Hello, World!');
  const size = validateFileSize(smallFile);
  assert(typeof size === 'number', 'Should return file size as number');
  assert(size === 13, `Size should be 13 bytes, got ${size}`);
});

test('validateFileSize throws for oversized file', () => {
  const { validateFileSize } = require('@agent/core/secure-io');
  const smallFile = writeTemp('tiny-but-limited.txt', 'x'.repeat(100));
  try {
    validateFileSize(smallFile, 0.00001); // Tiny limit: ~10 bytes
    assert(false, 'Should have thrown for oversized file');
  } catch (err) {
    assert(err.message.includes('File too large'), 'Error should mention file too large');
  }
});

// ========================================
// safeReadFile
// ========================================
console.log('\n--- safeReadFile ---');

test('safeReadFile reads valid file', () => {
  const { safeReadFile } = require('@agent/core/secure-io');
  const testFile = writeTemp('safe-read.txt', 'Safe content here');
  const content = safeReadFile(testFile);
  assert(content === 'Safe content here', 'Should return file content');
});

test('safeReadFile throws for missing file', () => {
  const { safeReadFile } = require('@agent/core/secure-io');
  try {
    safeReadFile('/tmp/nonexistent_file_secure_io_test_xyz.txt');
    assert(false, 'Should have thrown for missing file');
  } catch (err) {
    assert(err.message.includes('File not found'), 'Error should mention file not found');
  }
});

test('safeReadFile throws for null path', () => {
  const { safeReadFile } = require('@agent/core/secure-io');
  try {
    safeReadFile(null);
    assert(false, 'Should have thrown for null path');
  } catch (err) {
    assert(err.message.includes('Missing required'), 'Error should mention missing path');
  }
});

// ========================================
// safeWriteFile
// ========================================
console.log('\n--- safeWriteFile ---');

test('safeWriteFile performs atomic write', () => {
  const { safeWriteFile } = require('@agent/core/secure-io');
  const atomicFile = writeTemp('atomic.txt', 'initial');

  safeWriteFile(atomicFile, 'updated content');
  assert(fs.readFileSync(atomicFile, 'utf8') === 'updated content', 'File should be updated');

  const dir = path.dirname(atomicFile);
  const files = fs.readdirSync(dir);
  const tempFiles = files.filter((f) => f.includes('atomic.txt.tmp'));
  assert(tempFiles.length === 0, 'Should clean up temp files');
});

// ========================================
// sanitizePath
// ========================================
console.log('\n--- sanitizePath ---');

test('sanitizePath removes path traversal', () => {
  const { sanitizePath } = require('@agent/core/secure-io');
  assert(sanitizePath('../etc/passwd') === 'etc/passwd', 'Should remove ../');
  assert(sanitizePath('..\\windows\\system32') === 'windows\\system32', 'Should remove ..\\');
  assert(sanitizePath('/absolute/path') === 'absolute/path', 'Should remove leading slash');
  assert(
    sanitizePath('safe/path/file.txt') === 'safe/path/file.txt',
    'Safe path should be unchanged'
  );
  assert(sanitizePath('') === '', 'Empty string should return empty');
  assert(sanitizePath(null) === '', 'Null should return empty');
});

test('sanitizePath removes null bytes', () => {
  const { sanitizePath } = require('@agent/core/secure-io');
  const result = sanitizePath('file\0name.txt');
  assert(!result.includes('\0'), 'Should remove null bytes');
  assert(result === 'filename.txt', 'Should remove null byte from filename');
});

// ========================================
// validateUrl
// ========================================
console.log('\n--- validateUrl ---');

test('validateUrl accepts valid HTTPS URL', () => {
  const { validateUrl } = require('@agent/core/secure-io');
  const url = validateUrl('https://example.com/api');
  assert(url === 'https://example.com/api', 'Should return the URL unchanged');
});

test('validateUrl blocks localhost', () => {
  const { validateUrl } = require('@agent/core/secure-io');
  try {
    validateUrl('http://localhost:3000/secret');
    assert(false, 'Should have thrown for localhost');
  } catch (err) {
    assert(err.message.includes('Blocked URL'), 'Should mention blocked URL');
  }
});

test('validateUrl blocks private IP addresses', () => {
  const { validateUrl } = require('@agent/core/secure-io');
  const privateIPs = [
    'http://127.0.0.1:8080',
    'http://10.0.0.1',
    'http://192.168.1.1',
    'http://172.16.0.1',
  ];
  for (const ip of privateIPs) {
    try {
      validateUrl(ip);
      assert(false, `Should have blocked ${ip}`);
    } catch (err) {
      assert(err.message.includes('Blocked URL'), `Should block ${ip}`);
    }
  }
});

test('validateUrl rejects non-HTTP protocols', () => {
  const { validateUrl } = require('@agent/core/secure-io');
  try {
    validateUrl('ftp://example.com/file');
    assert(false, 'Should have thrown for ftp protocol');
  } catch (err) {
    assert(err.message.includes('Unsupported protocol'), 'Should mention unsupported protocol');
  }
});

test('validateUrl rejects invalid URLs', () => {
  const { validateUrl } = require('@agent/core/secure-io');
  try {
    validateUrl('not-a-url');
    assert(false, 'Should have thrown for invalid URL');
  } catch (err) {
    assert(err.message.includes('Invalid URL'), 'Should mention invalid URL');
  }
});

test('validateUrl rejects empty input', () => {
  const { validateUrl } = require('@agent/core/secure-io');
  try {
    validateUrl('');
    assert(false, 'Should have thrown for empty URL');
  } catch (err) {
    assert(err.message.includes('Missing or invalid URL'), 'Should mention missing URL');
  }
});

harness.report();
