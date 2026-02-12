const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = process.cwd();
let issues = 0;

// Dynamically discover skills (excluding system dirs)
const skills = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'package.json')) && !e.name.startsWith('.') && e.name !== 'scripts')
    .map(e => e.name);

console.log(`=== Checking Health for ${skills.length} Skills ===\n`);

skills.forEach(skill => {
    const skillPath = path.join(rootDir, skill);
    let status = "✅ OK";
    const details = [];

    const pkgPath = path.join(skillPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const mainScript = pkg.main ? path.join(skillPath, pkg.main) : null;

            // 1. Standard Fields Check
            if (pkg.author !== 'Gemini Agent') details.push('Invalid author');
            if (pkg.license !== 'MIT') details.push('Invalid license');
            if (pkg.private !== true) details.push('Not private');

            // 2. Dependency Check (@agent/core)
            if (!pkg.devDependencies || !pkg.devDependencies['@agent/core']) {
                details.push('Missing @agent/core devDep');
            }

            // 3. Main Script Check
            if (mainScript && !fs.existsSync(mainScript)) {
                details.push(`Main script missing: ${pkg.main}`);
                status = "❌ BROKEN";
                issues++;
            } else if (mainScript) {
                // 4. Syntax Check
                try {
                    execSync(`node -c "${mainScript}"`, { stdio: 'ignore' });
                } catch (_e) {
                    details.push("Syntax Error");
                    status = "❌ ERROR";
                    issues++;
                }
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
        if (status === "✅ OK") status = "⚠️  WARN"; // Downgrade if warnings exist
        console.log(`[${skill.padEnd(25)}] ${status} ${details.join(', ')}`);
    }
});

console.log(`\nTotal Issues: ${issues}`);
if (issues > 0) process.exit(1);
