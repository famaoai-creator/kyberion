const readline = require('readline');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const rootDir = process.cwd();

function clearScreen() {
  process.stdout.write('\x1Bc');
}

function getSkills() {
  return fs.readdirSync(rootDir).filter((item) => {
    const fullPath = path.join(rootDir, item);
    return (
      fs.statSync(fullPath).isDirectory() &&
      !item.startsWith('.') &&
      fs.existsSync(path.join(fullPath, 'SKILL.md'))
    );
  });
}

function getSkillDescription(skillDir) {
  try {
    const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const match = content.match(/description:\s*(.*)/);
    return match ? match[1].trim() : '(No description)';
  } catch (_e) {
    return '(Error reading SKILL.md)';
  }
}

function isInstalled(skillName) {
  // Check workspace scope installation
  const installedPath = path.join(rootDir, '.gemini/skills', skillName);
  return fs.existsSync(installedPath);
}

function _getGitStatus(dir) {
  try {
    if (!fs.existsSync(path.join(dir, '.git')) && dir !== rootDir) {
      return null;
    }
    const status = execSync('git status --short', { cwd: dir }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim();
    return { branch, hasChanges: status.length > 0 };
  } catch (_e) {
    return null;
  }
}

function showHeader() {
  clearScreen();
  console.log('==========================================');
  console.log('       G E M I N I   S K I L L S          ');
  console.log('         M A N A G E M E N T              ');
  console.log('==========================================\n');
}

function mainMenu() {
  showHeader();
  const skills = getSkills();
  console.log(`Found ${skills.length} skills in ${rootDir}\n`);

  console.log('--- Actions ---');
  console.log('c. Create New Skill');
  console.log('i. Install ALL Skills (Workspace)');
  console.log('s. Sync All (Git Pull)');
  console.log('p. Push All Changes');
  console.log('q. Quit');

  console.log('\n--- Select a Skill to Manage ---');
  skills.forEach((skill, index) => {
    const installedMark = isInstalled(skill) ? ' [INSTALLED]' : '';
    const desc = getSkillDescription(path.join(rootDir, skill));
    const shortDesc = desc.length > 40 ? desc.substring(0, 37) + '...' : desc;
    console.log(`${index + 1}. ${skill.padEnd(20)} ${installedMark}`);
    console.log(`   └─ ${shortDesc}`);
  });

  rl.question('\nSelect option or skill number: ', (answer) => {
    const choice = answer.trim();
    if (choice === 'q') {
      rl.close();
    } else if (choice === 'c') {
      createSkill();
    } else if (choice === 'i') {
      installAllSkills();
    } else if (choice === 's') {
      syncAll();
    } else if (choice === 'p') {
      pushAll();
    } else {
      const index = parseInt(choice) - 1;
      if (index >= 0 && index < skills.length) {
        skillMenu(skills[index]);
      } else {
        mainMenu();
      }
    }
  });
}

function skillMenu(skillName) {
  showHeader();
  console.log(`Managing Skill: ${skillName}`);
  const skillDir = path.join(rootDir, skillName);
  const installed = isInstalled(skillName);
  const hasPackageJson = fs.existsSync(path.join(skillDir, 'package.json'));

  console.log(`\nStatus: ${installed ? 'INSTALLED (Workspace)' : 'NOT INSTALLED'}`);
  if (hasPackageJson) console.log('Detected: package.json (Node.js dependencies)');

  console.log('\n1. Install Skill (Workspace Scope)');
  console.log('2. Git Pull (Update)');
  console.log('3. Git Push');
  if (hasPackageJson) console.log('4. npm install');
  console.log('d. DELETE Skill (Caution!)');
  console.log('b. Back to Main Menu');

  rl.question('\nSelect action: ', (answer) => {
    switch (answer.trim()) {
      case '1':
        try {
          console.log(`\nInstalling ${skillName}...`);
          const cmd = `gemini skills install ${skillName}/SKILL.md --scope workspace`;
          console.log(`Running: ${cmd}`);
          execSync(cmd, { stdio: 'inherit' });
          console.log("\n✅ Installed! IMPORTANT: Run '/skills reload' to activate.");
          console.log('(Press Enter)');
          rl.question('', () => skillMenu(skillName));
        } catch (_e) {
          console.log('\nInstallation might have been cancelled or failed.');
          setTimeout(() => skillMenu(skillName), 2000);
        }
        break;
      case '2':
        try {
          execSync('git pull', { cwd: skillDir, stdio: 'inherit' });
        } catch (_e) {}
        setTimeout(() => skillMenu(skillName), 1000);
        break;
      case '3':
        rl.question('Commit message: ', (msg) => {
          if (msg) {
            try {
              execSync('git add .', { cwd: skillDir, stdio: 'inherit' });
              execSync(`git commit -m "${msg}"`, { cwd: skillDir, stdio: 'inherit' });
              execSync('git push', { cwd: skillDir, stdio: 'inherit' });
            } catch (_e) {}
          }
          skillMenu(skillName);
        });
        break;
      case '4':
        if (hasPackageJson) {
          try {
            console.log('Running npm install...');
            execSync('npm install', { cwd: skillDir, stdio: 'inherit' });
          } catch (_e) {}
        }
        setTimeout(() => skillMenu(skillName), 1000);
        break;
      case 'd':
        deleteSkill(skillName);
        break;
      case 'b':
        mainMenu();
        break;
      default:
        skillMenu(skillName);
    }
  });
}

function createSkill() {
  showHeader();
  rl.question('Enter name for new skill: ', (name) => {
    if (!name) return mainMenu();
    try {
      const scriptPath = path.join(__dirname, 'create_skill.cjs');
      execSync(`node "${scriptPath}" "${name}"`, { stdio: 'inherit' });
      console.log('\n(Press Enter to return)');
      rl.question('', () => mainMenu());
    } catch (_e) {
      setTimeout(mainMenu, 2000);
    }
  });
}

function deleteSkill(skillName) {
  rl.question(
    `\n⚠️  Are you sure you want to DELETE '${skillName}'? This cannot be undone. (yes/no): `,
    (ans) => {
      if (ans.trim().toLowerCase() === 'yes') {
        try {
          console.log(`Deleting ${skillName}...`);
          const skillDir = path.join(rootDir, skillName);
          // Try git rm first if it's a git repo or tracked file
          try {
            execSync(`git rm -r "${skillName}"`, { stdio: 'inherit' });
            execSync(`git commit -m "Delete skill: ${skillName}"`, { stdio: 'inherit' });
          } catch (_e) {
            // Fallback to fs.rm if git fails
            fs.rmSync(skillDir, { recursive: true, force: true });
          }
          console.log('Skill deleted.');
        } catch (_e) {
          console.error('Failed to delete skill.');
        }
        setTimeout(mainMenu, 2000);
      } else {
        console.log('Cancelled.');
        skillMenu(skillName);
      }
    }
  );
}

function installAllSkills() {
  console.log('\nInstalling ALL skills (Workspace Scope)...');
  const skills = getSkills();
  skills.forEach((skill) => {
    if (!isInstalled(skill)) {
      try {
        console.log(`\n--- Installing ${skill} ---`);
        execSync(`gemini skills install ${skill}/SKILL.md --scope workspace`, { stdio: 'inherit' });
      } catch (_e) {
        console.log(`Failed to install ${skill}`);
      }
    } else {
      console.log(`\n${skill} is already installed. Skipping.`);
    }
  });
  console.log('\n✅ All operations completed.');
  console.log("IMPORTANT: Run '/skills reload' to activate changes.");
  console.log('(Press Enter to return)');
  rl.question('', () => mainMenu());
}

function syncAll() {
  console.log('\nPulling latest changes...');
  try {
    execSync('git pull', { stdio: 'inherit' });
  } catch (_e) {}
  setTimeout(mainMenu, 2000);
}

function pushAll() {
  console.log('\nPushing changes...');
  rl.question('Enter commit message: ', (msg) => {
    if (msg) {
      try {
        execSync('git add .', { stdio: 'inherit' });
        execSync(`git commit -m "${msg}"`, { stdio: 'inherit' });
        execSync('git push', { stdio: 'inherit' });
      } catch (_e) {}
    }
    setTimeout(mainMenu, 2000);
  });
}

// Start
mainMenu();
