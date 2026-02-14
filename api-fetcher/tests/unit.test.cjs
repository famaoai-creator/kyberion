const { describe, it, assert } = require('@agent/core/test-utils');
const { execSync } = require('child_process');
const path = require('path');

describe('api-fetcher Skill', () => {
  it('should fail when missing URL', async () => {
    const scriptPath = path.join(__dirname, '../scripts/fetch.cjs');
    try {
      execSync(`node "${scriptPath}"`, { stdio: 'pipe' });
      assert.fail('Should have thrown an error');
    } catch (e) {
      assert(e.stdout.toString().includes('error'), 'Output should contain error status');
    }
  });

  it('should validate URL format', async () => {
    const scriptPath = path.join(__dirname, '../scripts/fetch.cjs');
    try {
      execSync(`node "${scriptPath}" --url "invalid-url"`, { stdio: 'pipe' });
      assert.fail('Should have thrown an error for invalid URL');
    } catch (e) {
      // Error caught by secureFetch or URL validator
      assert(e.stdout.toString().includes('error'), 'Output should indicate error');
    }
  });
});
