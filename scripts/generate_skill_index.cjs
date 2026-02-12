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
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    
    // Pre-compile regex for performance
    const descRegex = /^description:\s*(.*)$/m;
    const statusRegex = /^status:\s*(\w+)$/m;

    const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'knowledge', 'scripts', 'evidence', 'work', 'templates', 'schemas', 'nonfunctional', 'pipelines', 'plugins'].includes(e.name))
        .map(e => e.name);

    for (const dir of dirs) {
        const skillPath = path.join(rootDir, dir, 'SKILL.md');
        if (fs.existsSync(skillPath)) {
            const content = fs.readFileSync(skillPath, 'utf8');
            const descMatch = content.match(descRegex);
            const statusMatch = content.match(statusRegex);
            
            skills.push({
                name: dir,
                description: descMatch ? descMatch[1].trim() : '',
                status: statusMatch ? statusMatch[1] : 'unknown',
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
