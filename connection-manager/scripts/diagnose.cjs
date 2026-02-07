const fs = require('fs');
const path = require('path');
const { logger } = require('../../scripts/lib/core.cjs');

/**
 * Connection Diagnostics Tool
 * Scans Personal Tier for configs and reports status.
 */

const PERSONAL_CONN_DIR = path.resolve(__dirname, '../../knowledge/personal/connections');

const SERVICES = ['aws', 'slack', 'jira', 'box', 'github'];

console.log('🔌 Universal Connection Manager: Diagnostic Scan\n');

if (!fs.existsSync(PERSONAL_CONN_DIR)) {
    logger.warn(`Personal connections directory not found: ${PERSONAL_CONN_DIR}`);
    logger.info('Please create it and add your JSON configs.');
    process.exit(0);
}

SERVICES.forEach(service => {
    const configPath = path.join(PERSONAL_CONN_DIR, `${service}.json`);
    if (fs.existsSync(configPath)) {
        try {
            JSON.parse(fs.readFileSync(configPath, 'utf8'));
            logger.success(`${service.toUpperCase()}: Config found and valid.`);
        } catch (e) {
            logger.error(`${service.toUpperCase()}: Config found but INVALID JSON.`);
        }
    } else {
        logger.warn(`${service.toUpperCase()}: No config found.`);
    }
});

console.log('\n✨ Tip: See knowledge/connections/setup_guide.md for templates.');
