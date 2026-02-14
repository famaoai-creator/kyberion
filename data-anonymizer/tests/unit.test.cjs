const { describe, it, assert } = require('@agent/core/test-utils');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

describe('data-anonymizer Skill', () => {
  const testInput = path.join(__dirname, 'test-data.json');
  const testOutput = path.join(__dirname, 'anonymized.json');

  const data = {
    user: 'John Doe',
    credentials: {
      email: 'john@example.com',
      password: 'super-secret-password',
    },
    api: {
      token: '12345-abcde-67890',
    },
    meta: 'safe data',
  };

  fs.writeFileSync(testInput, JSON.stringify(data, null, 2));

  it('should mask sensitive fields in JSON', async () => {
    // Build the TS skill first (since it's a new skill)
    execSync('cd data-anonymizer && npm run build', { stdio: 'inherit' });

    const scriptPath = path.join(__dirname, '../dist/main.js');
    const cmd = `node "${scriptPath}" --input "${testInput}"`;

    const output = execSync(cmd, { encoding: 'utf8' });
    const result = JSON.parse(output);

    // Match standard envelope structure
    const skillData = result.data.data;

    assert.strictEqual(skillData.credentials.email, '***MASKED***');
    assert.strictEqual(skillData.credentials.password, '***MASKED***');
    assert.strictEqual(skillData.api.token, '***MASKED***');
    assert.strictEqual(skillData.user, 'John Doe');
  });

  // Cleanup
  setTimeout(() => {
    if (fs.existsSync(testInput)) fs.unlinkSync(testInput);
    if (fs.existsSync(testOutput)) fs.unlinkSync(testOutput);
  }, 2000);
});
