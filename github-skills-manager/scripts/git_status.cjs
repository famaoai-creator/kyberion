const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const targetDir = process.argv[2] || process.cwd();

function getGitStatus(dir) {
  try {
    const stats = fs.statSync(path.join(dir, '.git'));
    if (!stats.isDirectory()) return null;

    const status = execSync('git status --short', { cwd: dir }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim();
    const remote = execSync('git remote -v', { cwd: dir }).toString().trim();

    return { branch, hasChanges: status.length > 0, remote: remote.length > 0 };
  } catch (_e) {
    return null;
  }
}

const items = fs.readdirSync(targetDir);
console.log(`Checking repositories in: ${targetDir}\n`);

// Check the target directory itself
const rootStatus = getGitStatus(targetDir);
if (rootStatus) {
  const changeIndicator = rootStatus.hasChanges ? ' [MODIFIED]' : '';
  console.log(`- . (ROOT) (${rootStatus.branch})${changeIndicator}`);
}

items.forEach((item) => {
  const fullPath = path.join(targetDir, item);
  if (fs.statSync(fullPath).isDirectory()) {
    const status = getGitStatus(fullPath);
    if (status) {
      const changeIndicator = status.hasChanges ? ' [MODIFIED]' : '';
      console.log(`- ${item} (${status.branch})${changeIndicator}`);
    }
  }
});
