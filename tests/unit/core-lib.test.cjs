/**
 * Core library unit tests — tests for @agent/core modules directly.
 *
 * These tests validate the shared infrastructure that all 131 skills depend on.
 * Run standalone: node tests/unit/core-lib.test.cjs
 */
const { test, assert, harness } = require('../harness.cjs');

// ========================================
// tier-guard tests
// ========================================
console.log('\n--- tier-guard ---');

test('tier-guard detects public tier', () => {
  const path = require('path');
  const { detectTier } = require('@agent/core/tier-guard');
  const tier = detectTier(
    path.join(harness.rootDir, 'knowledge/orchestration/global_skill_index.json')
  );
  assert(tier === 'public', `Should be public, got ${tier}`);
});

test('tier-guard allows public to public', () => {
  const { canFlowTo } = require('@agent/core/tier-guard');
  assert(canFlowTo('public', 'public') === true, 'public -> public should be allowed');
});

test('tier-guard blocks personal to public', () => {
  const { canFlowTo } = require('@agent/core/tier-guard');
  assert(canFlowTo('personal', 'public') === false, 'personal -> public should be blocked');
});

test('tier-guard allows personal to personal', () => {
  const { canFlowTo } = require('@agent/core/tier-guard');
  assert(canFlowTo('personal', 'personal') === true, 'personal -> personal should be allowed');
});

test('tier-guard blocks confidential to public', () => {
  const { canFlowTo } = require('@agent/core/tier-guard');
  assert(canFlowTo('confidential', 'public') === false, 'confidential -> public should be blocked');
});

test('tier-guard scans confidential markers', () => {
  const { scanForConfidentialMarkers } = require('@agent/core/tier-guard');
  const result = scanForConfidentialMarkers('The API_KEY is abc123 and PASSWORD is secret');
  assert(result.hasMarkers === true, 'Should detect markers');
  assert(result.markers.length >= 2, 'Should find at least 2 markers');
});

test('tier-guard clean text has no markers', () => {
  const { scanForConfidentialMarkers } = require('@agent/core/tier-guard');
  const result = scanForConfidentialMarkers('This is perfectly safe public content.');
  assert(result.hasMarkers === false, 'Should not detect markers');
});

// ========================================
// skill-wrapper tests
// ========================================
console.log('\n--- skill-wrapper ---');

test('wrapSkill returns success format', () => {
  const { wrapSkill } = require('@agent/core');
  const result = wrapSkill('test-skill', () => ({ hello: 'world' }));
  assert(result.skill === 'test-skill', 'Should have skill name');
  assert(result.status === 'success', 'Should be success');
  assert(result.data.hello === 'world', 'Should have data');
  assert(result.metadata.duration_ms >= 0, 'Should have duration');
});

test('wrapSkill returns error format on throw', () => {
  const { wrapSkill } = require('@agent/core');
  const result = wrapSkill('test-skill', () => {
    throw new Error('boom');
  });
  assert(result.status === 'error', 'Should be error');
  assert(result.error.message === 'boom', 'Should have error message');
});

test('wrapSkillAsync returns success for async fn', async () => {
  const { wrapSkillAsync } = require('@agent/core');
  const result = await wrapSkillAsync('async-test', async () => ({ value: 42 }));
  assert(result.skill === 'async-test', 'Should have skill name');
  assert(result.status === 'success', 'Should be success');
  assert(result.data.value === 42, 'Should have data');
});

test('wrapSkillAsync returns error for async throw', async () => {
  const { wrapSkillAsync } = require('@agent/core');
  const result = await wrapSkillAsync('async-test', async () => {
    throw new Error('async-boom');
  });
  assert(result.status === 'error', 'Should be error');
  assert(result.error.message === 'async-boom', 'Should have error message');
});

// ========================================
// classifier library tests
// ========================================
console.log('\n--- classifier library ---');

test('classify returns correct category', () => {
  const { classify } = require('@agent/core/classifier');
  const result = classify(
    'Deploy the API Server',
    {
      tech: ['API', 'Server', 'Deploy'],
      finance: ['Budget', 'Cost'],
    },
    { resultKey: 'domain' }
  );
  assert(result.domain === 'tech', 'Should classify as tech');
  assert(result.matches === 3, 'Should have 3 matches');
});

test('classify returns unknown for no matches', () => {
  const { classify } = require('@agent/core/classifier');
  const result = classify('lorem ipsum dolor sit amet', {
    tech: ['API', 'Server'],
  });
  assert(result.category === 'unknown', 'Should be unknown');
  assert(result.confidence === 0, 'Should have 0 confidence');
});

// ========================================
// validators tests
// ========================================
console.log('\n--- validators ---');

test('validateFilePath throws on missing path', () => {
  const { validateFilePath } = require('@agent/core/validators');
  try {
    validateFilePath(null);
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('Missing'), 'Should mention missing');
  }
});

test('safeJsonParse parses valid JSON', () => {
  const { safeJsonParse } = require('@agent/core/validators');
  const result = safeJsonParse('{"key":"value"}', 'test');
  assert(result.key === 'value', 'Should parse correctly');
});

test('safeJsonParse throws on invalid JSON', () => {
  const { safeJsonParse } = require('@agent/core/validators');
  try {
    safeJsonParse('not json', 'test');
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('Invalid test'), 'Should have descriptive error');
  }
});

test('requireArgs detects missing args', () => {
  const { requireArgs } = require('@agent/core/validators');
  try {
    requireArgs({ input: 'x' }, ['input', 'output']);
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('output'), 'Should mention missing arg');
  }
});

// ========================================
// error-codes tests
// ========================================
console.log('\n--- error-codes ---');

test('SkillError has structured fields', () => {
  const { SkillError, ERROR_CODES } = require('@agent/core/error-codes');
  const err = new SkillError(ERROR_CODES.VALIDATION_ERROR, 'bad input');
  assert(err.code === 'E200', 'Should have code E200');
  assert(err.retryable === false, 'Should not be retryable');
  assert(err.message.includes('bad input'), 'Should include detail');
});

test('SkillError serializes to JSON', () => {
  const { SkillError, ERROR_CODES } = require('@agent/core/error-codes');
  const err = new SkillError(ERROR_CODES.EXECUTION_ERROR, 'timeout', {
    context: { skillName: 'test' },
  });
  const json = err.toJSON();
  assert(json.code === 'E300', 'JSON should have code');
  assert(json.retryable === true, 'JSON should indicate retryable');
  assert(json.context.skillName === 'test', 'JSON should have context');
});

test('ERROR_CODES covers all categories', () => {
  const { ERROR_CODES } = require('@agent/core/error-codes');
  const codes = Object.values(ERROR_CODES).map((e) => e.code);
  assert(
    codes.some((c) => c.startsWith('E1')),
    'Should have resolution errors'
  );
  assert(
    codes.some((c) => c.startsWith('E2')),
    'Should have validation errors'
  );
  assert(
    codes.some((c) => c.startsWith('E3')),
    'Should have execution errors'
  );
  assert(
    codes.some((c) => c.startsWith('E4')),
    'Should have pipeline errors'
  );
  assert(
    codes.some((c) => c.startsWith('E5')),
    'Should have security errors'
  );
});

// ========================================
// Report (only when run standalone)
// ========================================
if (require.main === module) {
  harness.report();
}

module.exports = harness;
