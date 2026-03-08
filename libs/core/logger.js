"use strict";
/**
 * Structured Logger - provides leveled, structured logging for skills.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LOG_LEVELS = void 0;
exports.createLogger = createLogger;
exports.LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
function createLogger(name, options = {}) {
    const level = exports.LOG_LEVELS[options.level || process.env.LOG_LEVEL || 'info'] ?? exports.LOG_LEVELS.info;
    const json = options.json || process.env.LOG_FORMAT === 'json';
    function _format(lvl, msg, data) {
        const ts = new Date().toISOString();
        if (json) {
            return JSON.stringify({ ts, level: lvl, skill: name, msg, ...data });
        }
        const prefix = `[${ts}] [${lvl.toUpperCase()}] [${name}]`;
        if (data && Object.keys(data).length > 0) {
            return `${prefix} ${msg} ${JSON.stringify(data)}`;
        }
        return `${prefix} ${msg}`;
    }
    function _log(lvl, msg, data) {
        if (exports.LOG_LEVELS[lvl] < level)
            return;
        const line = _format(lvl, msg, data);
        process.stderr.write(line + '\n');
    }
    return {
        debug: (msg, data) => _log('debug', msg, data),
        info: (msg, data) => _log('info', msg, data),
        warn: (msg, data) => _log('warn', msg, data),
        error: (msg, data) => _log('error', msg, data),
        child: (childName) => createLogger(`${name}:${childName}`, options),
    };
}
//# sourceMappingURL=logger.js.map