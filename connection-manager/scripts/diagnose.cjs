const fs = require('fs');
const path = require('path');
const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');

/**
 * Connection Diagnostics Tool
 * Scans Personal Tier for configs and reports status.
 */

const PERSONAL_CONN_DIR = path.resolve(__dirname, '../../knowledge/personal/connections');

const SERVICES = ['aws', 'slack', 'jira', 'box', 'github'];

const MAX_CONFIG_SIZE = 1024 * 1024; // 1MB max config file

runSkill('connection-manager', () => {
    const results = [];

    if (!fs.existsSync(PERSONAL_CONN_DIR)) {
        return { warning: `Personal connections directory not found: ${PERSONAL_CONN_DIR}`, services: [], total: 0, valid: 0 };
    }

    SERVICES.forEach(service => {
        const configPath = path.join(PERSONAL_CONN_DIR, `${service}.json`);
        if (fs.existsSync(configPath)) {
            try {
                const stat = fs.statSync(configPath);
                if (!stat.isFile()) {
                    results.push({ service: service.toUpperCase(), status: 'not_a_file', configPath });
                    return;
                }
                if (stat.size > MAX_CONFIG_SIZE) {
                    results.push({ service: service.toUpperCase(), status: 'file_too_large', size: stat.size, configPath });
                    return;
                }
                if (stat.size === 0) {
                    results.push({ service: service.toUpperCase(), status: 'empty_config', configPath });
                    return;
                }
                const content = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(content);
                const hasKeys = Object.keys(config).length > 0;
                results.push({ service: service.toUpperCase(), status: hasKeys ? 'valid' : 'empty_object', configPath });
            } catch (_err) {
                if (err.code === 'EACCES') {
                    results.push({ service: service.toUpperCase(), status: 'permission_denied', configPath });
                } else if (err instanceof SyntaxError) {
                    results.push({ service: service.toUpperCase(), status: 'invalid_json', configPath });
                } else {
                    results.push({ service: service.toUpperCase(), status: 'read_error', error: err.message, configPath });
                }
            }
        } else {
            results.push({ service: service.toUpperCase(), status: 'missing' });
        }
    });

    const validCount = results.filter(r => r.status === 'valid').length;
    return { services: results, total: results.length, valid: validCount };
});
