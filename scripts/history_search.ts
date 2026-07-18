/**
 * HA-02 public history search CLI.
 *
 * The default entrypoint is deliberately bound to the shared public index.
 * Higher-tier history is available only through the mission-scoped governed
 * entrypoint and its isolated database.
 *
 * Usage:
 *   pnpm history:search -- --query "請求書"
 *   pnpm history:search -- --refresh --query "請求書" --json
 *   MISSION_ID=MSN-... pnpm history:search -- --mission-id MSN-... --query "復旧"
 */

import {
  createStandardYargs,
  logger,
  rebuildPublicHistorySearchIndexFromLocalSources,
  searchMissionHistory,
  searchHistory,
} from '@agent/core';

export function runHistorySearch(): number {
  const argv = createStandardYargs()
    .scriptName('history_search')
    .option('query', { type: 'string', describe: 'Japanese or free-text query' })
    .option('mode', {
      type: 'string',
      choices: ['discovery', 'scroll', 'browse'],
      describe: 'Search mode (defaults from query/session arguments)',
    })
    .option('session-id', { type: 'string', describe: 'Session id for scroll mode' })
    .option('mission-id', {
      type: 'string',
      describe:
        'Search only the current confidential/personal mission (requires matching MISSION_ID)',
    })
    .option('max-results', { type: 'number', default: 20 })
    .option('include-scheduled', { type: 'boolean', default: true })
    .option('refresh', {
      type: 'boolean',
      default: false,
      describe: 'Rebuild the public index from public runtime sources first',
    })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const missionId = argv['mission-id'] ? String(argv['mission-id']) : undefined;
  if (argv.refresh && !missionId) {
    const count = rebuildPublicHistorySearchIndexFromLocalSources();
    logger.info(`[history-search] refreshed public index (${count} entries)`);
  }

  const searchOptions = {
    query: argv.query ? String(argv.query) : undefined,
    mode: argv.mode as 'discovery' | 'scroll' | 'browse' | undefined,
    sessionId: argv['session-id'] ? String(argv['session-id']) : undefined,
    maxResults: Number(argv['max-results']),
    includeScheduled: Boolean(argv['include-scheduled']),
    includeSubagent: false,
  } as const;
  const report = missionId
    ? searchMissionHistory({ ...searchOptions, missionId })
    : searchHistory({ ...searchOptions, tiers: ['public'] });

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  for (const result of report.results) {
    process.stdout.write(
      `${result.timestamp} [${result.sourceType}] ${result.entryId}: ${result.snippet}\n`
    );
  }
  if (report.results.length === 0) {
    process.stdout.write('No public history results.\n');
  }
  return 0;
}

const isDirect = process.argv[1] && /history_search\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  try {
    process.exit(runHistorySearch());
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
