const { execSync } = require('child_process');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

runSkill('local-reviewer', () => {
  // Get staged changes with context
  const diff = execSync('git diff --staged --unified=3').toString();

  if (!diff.trim()) {
    return { status: 'no_changes', message: "No staged changes found. Did you run 'git add'?" };
  }

  return {
    diff,
    instructions: [
      'Review the above diff for:',
      '1. Bugs or logic errors.',
      '2. Security vulnerabilities.',
      '3. Code style consistency.',
      '4. Missing tests.',
    ],
  };
});
