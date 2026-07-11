import { logger } from './core.js';

/**
 * IP-08 Task 6: long-lived servers (bridges, hubs, daemons) had no
 * process-level rejection/exception handlers — a floating promise or a
 * throw on an event-loop tick would either kill the process (exception)
 * or vanish silently (rejection). Install once per process: both events
 * are logged with the server's name; the process is NOT exited (these are
 * recording guards, not crash handlers — supervisors own restart policy).
 */

let installedAs: string | null = null;

export function installProcessGuards(name: string): void {
  if (installedAs) {
    if (installedAs !== name) {
      logger.info(`[process-guards] already installed as ${installedAs}; ${name} reuses them`);
    }
    return;
  }
  installedAs = name;

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logger.error(`[${name}] unhandledRejection: ${detail}`);
  });

  process.on('uncaughtException', (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    logger.error(`[${name}] uncaughtException (process kept alive): ${detail}`);
  });

  logger.info(`[process-guards] installed for ${name}`);
}

/** Test hook. */
export function resetProcessGuardsForTests(): void {
  installedAs = null;
}
