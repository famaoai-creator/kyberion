const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const skills = [
    'api-fetcher', 'db-extractor', 'audio-transcriber',
    'data-transformer', 'template-renderer', 'diff-visualizer',
    'word-artisan', 'pdf-composer', 'html-reporter',
    'sequence-mapper', 'dependency-grapher', 'api-doc-generator',
    'format-detector', 'schema-validator', 'encoding-detector',
    'lang-detector', 'sensitivity-detector', 'completeness-scorer'
];

const rootDir = process.cwd();
let issues = 0;

console.log("=== Checking Skills Health ===\n");

skills.forEach(skill => {
    const skillPath = path.join(rootDir, skill);
    let status = "✅ OK";
    let details = [];

    // 1. Check Directory
    if (!fs.existsSync(skillPath)) {
        status = "❌ MISSING";
        issues++;
        console.log(`[${skill.padEnd(20)}] ${status}`);
        return;
    }

    // 2. Check package.json & node_modules
    const pkgPath = path.join(skillPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const nodeModules = path.join(skillPath, 'node_modules');
            const mainScript = path.join(skillPath, pkg.main);

            if (!fs.existsSync(nodeModules)) {
                details.push("node_modules missing (npm install needed)");
                status = "⚠️  DEPS";
                issues++;
            }

            if (!fs.existsSync(mainScript)) {
                details.push(`Main script missing: ${pkg.main}`);
                status = "❌ BROKEN";
                issues++;
            } else {
                // 3. Dry Run Test (--help)
                try {
                    execSync(`node "${mainScript}" --help`, { stdio: 'ignore' });
                } catch (e) {
                    details.push("Execution failed (syntax error or missing deps?)");
                    status = "❌ ERROR";
                    issues++;
                }
            }
        } catch (e) {
            details.push("Invalid package.json");
            status = "❌ INVALID";
            issues++;
        }
    } else {
        details.push("No package.json");
        status = "⚠️  CONFIG";
    }

    console.log(`[${skill.padEnd(20)}] ${status} ${details.join(', ')}`);
});

console.log(`
Total Issues: ${issues}`);
