const { test, assert, harness } = require('../../harness.cjs');
const secretGuard = require('@agent/core/secret-guard');
const tierGuard = require('@agent/core/tier-guard');

console.log('--- secret-guard ---');

test('secretGuard retrieves from env', () => {
  process.env.TEST_SECRET_KEY = 'super-secret-value-123';
  const val = secretGuard.getSecret('TEST_SECRET_KEY');
  assert(val === 'super-secret-value-123', 'Should retrieve from env');
});

test('secretGuard registers secret for masking', () => {
  // getSecret already called above
  const secrets = secretGuard.getActiveSecrets();
  assert(
    secrets.includes('super-secret-value-123'),
    'Active secrets should include retrieved value'
  );
});

test('tierGuard masks secret retrieved via secretGuard', () => {
  const content = 'The secret is super-secret-value-123 inside log.';
  const result = tierGuard.validateSovereignBoundary(content);
  assert(result.safe === false, 'Should be unsafe');
  assert(result.detected.length > 0, 'Should detect token');
});

test('secretGuard identifies secret paths', () => {
  const isSecret = secretGuard.isSecretPath('vault/secrets/keys.json');
  assert(isSecret === true, 'Should identify vault/secrets as secret path');

  const notSecret = secretGuard.isSecretPath('skills/core/foo.js');
  assert(notSecret === false, 'Should not identify other paths');
});

if (require.main === module) {
  harness.report();
}
