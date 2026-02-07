const fs = require('fs');
const path = require('path');
const { logger, fileUtils, errorHandler } = require('./lib/core.cjs');

/**
 * Global Skill Index Generator
 * Scans all directories for SKILL.md and creates a compact JSON index.
 */

const rootDir = path.resolve(__dirname, '..');
const indexFile = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');

try {
    const skills = [];
    const dirs = fs.readdirSync(rootDir).filter(f => 
        fs.statSync(path.join(rootDir, f)).isDirectory() && 
        !f.startsWith('.') && f !== 'node_modules' && f !== 'knowledge' && f !== 'scripts'
    );

    for (const dir of dirs) {
        const skillPath = path.join(rootDir, dir, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
            const content = fs.readFileSync(skillPath, 'utf8');
            const description = content.match(/description: (.*)/)?.[1] || '';
            skills.push({
                name: dir,
                description: description.trim(),
                path: `./${dir}/`
            });
        }
    }

    fileUtils.writeJson(indexFile, {
        total_skills: skills.length,
        last_updated: new Date().toISOString(),
        skills: skills
    });

    logger.success(`Global Skill Index generated with ${skills.length} skills at ${indexFile}`);
} catch (err) {
    errorHandler(err, 'Skill Index Generation Failed');
}
