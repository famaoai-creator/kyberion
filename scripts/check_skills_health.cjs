const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = process.cwd();
const argv = require('yargs/yargs')(process.argv.slice(2))
    .option('fix', { type: 'boolean', default: false, describe: 'Automatically fix repairable issues' })
    .argv;

let issues = 0;
let fixed = 0;

// Dynamically discover skills (excluding system dirs)
const skills = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'package.json')) && !e.name.startsWith('.') && e.name !== 'scripts')
    .map(e => e.name);

console.log(`=== Checking Health for ${skills.length} Skills${argv.fix ? ' (Auto-Fix Enabled)' : ''} ===\n`);

skills.forEach(skill => {
    const skillPath = path.join(rootDir, skill);
    let status = "✅ OK";
    const details = [];
    let needsFix = false;

    const pkgPath = path.join(skillPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            let mainScript = pkg.main ? path.join(skillPath, pkg.main) : null;

            // 1. Standard Fields Check
            if (pkg.author !== 'Gemini Agent' || pkg.license !== 'MIT' || pkg.private !== true) {
                details.push('Invalid metadata');
                if (argv.fix) {
                    pkg.author = 'Gemini Agent';
                    pkg.license = 'MIT';
                    pkg.private = true;
                    needsFix = true;
                }
            }

            // 2. Dependency Check (@agent/core)
            if (!pkg.devDependencies || !pkg.devDependencies['@agent/core']) {
                details.push('Missing @agent/core devDep');
                if (argv.fix) {
                    if (!pkg.devDependencies) pkg.devDependencies = {};
                    pkg.devDependencies['@agent/core'] = 'workspace:*';
                    needsFix = true;
                }
            }

            // 3. Main Script Check & Auto-Detection
            if (!mainScript || !fs.existsSync(mainScript)) {
                details.push(`Broken main: ${pkg.main || 'none'}`);
                if (argv.fix) {
                    const scriptsDir = path.join(skillPath, 'scripts');
                    const distDir = path.join(skillPath, 'dist');
                    let candidates = [];
                    
                    if (fs.existsSync(scriptsDir)) {
                        candidates.push(...fs.readdirSync(scriptsDir).filter(f => f.endsWith('.cjs') || f.endsWith('.js')).map(f => `scripts/${f}`));
                    }
                    if (fs.existsSync(distDir)) {
                        candidates.push(...fs.readdirSync(distDir).filter(f => f.endsWith('.js')).map(f => `dist/${f}`));
                    }

                    const bestMatch = candidates.find(f => f.includes('main.') || f.includes('score.') || f.includes('audit.')) || candidates[0];
                    if (bestMatch) {
                        pkg.main = bestMatch;
                        mainScript = path.join(skillPath, pkg.main);
                        needsFix = true;
                        details.push(`(Fixed to ${pkg.main})`);
                    }
                }
                if (!needsFix) {
                    status = "❌ BROKEN";
                    issues++;
                }
            }

            // 4. Syntax Check
            if (mainScript && fs.existsSync(mainScript)) {
                try {
                    execSync(`node -c "${mainScript}"`, { stdio: 'ignore' });
                } catch (_e) {
                    details.push("Syntax Error");
                    status = "❌ ERROR";
                    issues++;
                }
            }

            if (needsFix && argv.fix) {
                fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
                fixed++;
            }
        } catch (_e) {
            details.push("Invalid package.json");
            status = "❌ INVALID";
            issues++;
        }
    } else {
        details.push("No package.json");
        status = "⚠️  CONFIG";
        issues++;
    }

    if (details.length > 0) {
        if (status === "✅ OK") status = argv.fix ? "🔧 FIXED" : "⚠️  WARN"; 
        console.log(`[${skill.padEnd(25)}] ${status} ${details.join(', ')}`);
    }
});

console.log(`\nTotal Issues: ${issues}`);
if (argv.fix) console.log(`Total Fixed:  ${fixed}`);
if (issues > 0) process.exit(1);
