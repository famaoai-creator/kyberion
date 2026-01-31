const readline = require('readline');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const rootDir = process.cwd();

function clearScreen() {
    process.stdout.write('\x1Bc');
}

function getSkills() {
    return fs.readdirSync(rootDir).filter(item => {
        const fullPath = path.join(rootDir, item);
        return fs.statSync(fullPath).isDirectory() && 
               !item.startsWith('.') && 
               fs.existsSync(path.join(fullPath, 'SKILL.md'));
    });
}

function getSkillDescription(skillDir) {
    try {
        const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
        const match = content.match(/description:\s*(.*)/);
        return match ? match[1].trim() : '(No description)';
    } catch (e) {
        return '(Error reading SKILL.md)';
    }
}

function isInstalled(skillName) {
    // Check workspace scope installation
    const installedPath = path.join(rootDir, '.gemini/skills', skillName);
    return fs.existsSync(installedPath);
}

function getGitStatus(dir) {
    try {
        if (!fs.existsSync(path.join(dir, '.git')) && dir !== rootDir) {
             return null;
        }
        const status = execSync('git status --short', { cwd: dir }).toString().trim();
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim();
        return { branch, hasChanges: status.length > 0 };
    } catch (e) {
        return null;
    }
}

function showHeader() {
    clearScreen();
    console.log("==========================================");
    console.log("       G E M I N I   S K I L L S          ");
    console.log("         M A N A G E M E N T              ");
    console.log("==========================================\n");
}

function mainMenu() {
    showHeader();
    const skills = getSkills();
    console.log(`Found ${skills.length} skills in ${rootDir}\n`);

    console.log("--- Actions ---");
    console.log("c. Create New Skill");
    console.log("s. Sync All (Git Pull)");
    console.log("p. Push All Changes");
    console.log("q. Quit");
    
    console.log("\n--- Select a Skill to Manage ---");
    skills.forEach((skill, index) => {
        const installedMark = isInstalled(skill) ? ' [INSTALLED]' : '';
        const desc = getSkillDescription(path.join(rootDir, skill));
        const shortDesc = desc.length > 40 ? desc.substring(0, 37) + '...' : desc;
        console.log(`${index + 1}. ${skill.padEnd(20)} ${installedMark}`);
        console.log(`   └─ ${shortDesc}`);
    });

    rl.question("\nSelect option or skill number: ", (answer) => {
        const choice = answer.trim();
        if (choice === 'q') {
            rl.close();
        } else if (choice === 'c') {
            createSkill();
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
    if (hasPackageJson) console.log("Detected: package.json (Node.js dependencies)");

    console.log("\n1. Install Skill (Workspace Scope)");
    console.log("2. Git Pull (Update)");
    console.log("3. Git Push");
    if (hasPackageJson) console.log("4. npm install");
    console.log("b. Back to Main Menu");

    rl.question("\nSelect action: ", (answer) => {
        switch(answer.trim()) {
            case '1':
                try {
                    console.log(`\nInstalling ${skillName}...`);
                    // Note: This requires user confirmation in the CLI usually. 
                    // We output the command for visibility.
                    const cmd = `gemini skills install ${skillName}/SKILL.md --scope workspace`;
                    console.log(`Running: ${cmd}`);
                    execSync(cmd, { stdio: 'inherit' });
                    console.log("\n(Press Enter)");
                    rl.question("", () => skillMenu(skillName));
                } catch(e) {
                    console.log("\nInstallation might have been cancelled or failed.");
                    setTimeout(() => skillMenu(skillName), 2000);
                }
                break;
            case '2':
                try {
                    execSync('git pull', { cwd: skillDir, stdio: 'inherit' });
                } catch(e) {}
                setTimeout(() => skillMenu(skillName), 1000);
                break;
            case '3':
                rl.question("Commit message: ", (msg) => {
                    if(msg) {
                        try {
                            execSync('git add .', { cwd: skillDir, stdio: 'inherit' });
                            execSync(`git commit -m "${msg}"`, { cwd: skillDir, stdio: 'inherit' });
                            execSync('git push', { cwd: skillDir, stdio: 'inherit' });
                        } catch(e) {}
                    }
                    skillMenu(skillName);
                });
                break;
            case '4':
                if (hasPackageJson) {
                    try {
                        console.log("Running npm install...");
                        execSync('npm install', { cwd: skillDir, stdio: 'inherit' });
                    } catch(e) {}
                }
                setTimeout(() => skillMenu(skillName), 1000);
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
    rl.question("Enter name for new skill: ", (name) => {
        if (!name) return mainMenu();
        try {
            const scriptPath = path.join(__dirname, 'create_skill.cjs');
            execSync(`node "${scriptPath}" "${name}"`, { stdio: 'inherit' });
            console.log("\n(Press Enter to return)");
            rl.question("", () => mainMenu());
        } catch (e) {
            setTimeout(mainMenu, 2000);
        }
    });
}

function syncAll() {
    console.log("\nPulling latest changes...");
    try { execSync('git pull', { stdio: 'inherit' }); } catch (e) {}
    setTimeout(mainMenu, 2000);
}

function pushAll() {
    console.log("\nPushing changes...");
    rl.question("Enter commit message: ", (msg) => {
        if (msg) {
            try {
                execSync('git add .', { stdio: 'inherit' });
                execSync(`git commit -m "${msg}"`, { stdio: 'inherit' });
                execSync('git push', { stdio: 'inherit' });
            } catch (e) {}
        }
        setTimeout(mainMenu, 2000);
    });
}

// Start
mainMenu();
