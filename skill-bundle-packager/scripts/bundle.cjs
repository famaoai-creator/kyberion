const fs = require('fs');
const path = require('path');
const { logger, fileUtils, errorHandler } = require('../../scripts/lib/core.cjs');

/**
 * Skill Bundle Packager
 * Creates a manifest of selected skills for a specific mission.
 */

const missionName = process.argv[2];
const selectedSkills = process.argv.slice(3);

if (!missionName || selectedSkills.length === 0) {
    logger.error('Usage: node bundle.cjs <mission-name> <skill-1> <skill-2> ...');
    process.exit(1);
}

const rootDir = path.resolve(__dirname, '../../');
const bundleDir = path.join(rootDir, 'work/bundles', missionName);
const manifestFile = path.join(bundleDir, 'bundle.json');

try {
    fileUtils.ensureDir(bundleDir);

    const bundle = {
        mission: missionName,
        created_at: new Date().toISOString(),
        skills: selectedSkills.map(name => {
            const skillPath = path.join(rootDir, name);
            if (!fs.existsSync(skillPath)) {
                logger.warn(`Skill not found: ${name}`);
                return null;
            }
            return { name, path: `./${name}/` };
        }).filter(s => s !== null)
    };

    fileUtils.writeJson(manifestFile, bundle);

    logger.success(`Mission Bundle '${missionName}' created with ${bundle.skills.length} skills.`);
    logger.info(`Manifest saved to: ${manifestFile}`);
    console.log(`\nTo use this bundle, instruct Gemini: "Load mission bundle ${missionName}"`);
} catch (err) {
    errorHandler(err, 'Bundling Failed');
}
