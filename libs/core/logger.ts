/**
 * Structured Logger - provides leveled, structured logging for skills.
 */

import { nowIso } from './foundation/time.js';
import { getRegisteredEnvText } from './foundation/env.js';

export const LOG_LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

export interface LoggerOptions {
  level?: string;
  json?: boolean;
}

function isQuietProcess(): boolean {
  return (
    getRegisteredEnvText('LOG_LEVEL') === 'silent' ||
    process.argv.includes('--quiet') ||
    process.argv.includes('--json')
  );
}

export function createLogger(name: string, options: LoggerOptions = {}) {
  const level =
    LOG_LEVELS[options.level || getRegisteredEnvText('LOG_LEVEL') || 'info'] ?? LOG_LEVELS.info;
  const json = options.json || getRegisteredEnvText('LOG_FORMAT') === 'json';

  function _format(lvl: string, msg: string, data: any) {
    const ts = nowIso();
    if (json) {
      return JSON.stringify({ ts, level: lvl, skill: name, msg, ...data });
    }
    const prefix = `[${ts}] [${lvl.toUpperCase()}] [${name}]`;
    if (data && Object.keys(data).length > 0) {
      return `${prefix} ${msg} ${JSON.stringify(data)}`;
    }
    return `${prefix} ${msg}`;
  }

  function _log(lvl: string, msg: string, data: any) {
    if (isQuietProcess() && lvl !== 'error') return;
    if (LOG_LEVELS[lvl] < level) return;
    const line = _format(lvl, msg, data);
    process.stderr.write(line + '\n');
  }

  return {
    debug: (msg: string, data?: any) => _log('debug', msg, data),
    info: (msg: string, data?: any) => _log('info', msg, data),
    warn: (msg: string, data?: any) => _log('warn', msg, data),
    error: (msg: string, data?: any) => _log('error', msg, data),
    child: (childName: string) => createLogger(`${name}:${childName}`, options),
  };
}
