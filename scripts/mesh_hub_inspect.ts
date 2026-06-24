import { createStandardYargs, logger, formatMeshHubInspectionReport, inspectMeshHub } from '@agent/core';

type MeshHubInspectionSection = 'all' | 'peers' | 'routes' | 'deliveries' | 'dead-letters' | 'topics';

function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function renderSection(section: MeshHubInspectionSection, report: Awaited<ReturnType<typeof inspectMeshHub>>): string[] {
  switch (section) {
    case 'peers':
      return [
        `Peers (${report.peer_count})`,
        ...report.peers.map((peer) =>
          `- ${peer.peer_id} | ${peer.tenant_id || 'unknown'} | ${peer.heartbeat_state} | ${peer.status} | age=${peer.heartbeat_age_ms ?? 'n/a'}ms | caps=${peer.capabilities.join(', ') || 'none'}`,
        ),
      ];
    case 'routes':
    case 'deliveries':
      return [
        `Routes (${report.route_count})`,
        ...report.routes.map((route) =>
          `- ${route.delivery_id} | ${route.state} | retry=${route.retry_count} | expires=${route.expires_at} | ${route.route_explanation}`,
        ),
      ];
    case 'dead-letters':
      return [
        `Dead letters (${report.dead_letter_count})`,
        ...report.dead_letters.map((deadLetter) =>
          `- ${deadLetter.dead_letter_id} | ${deadLetter.delivery_id} | ${deadLetter.failure_class} | ${deadLetter.redacted_reason}`,
        ),
      ];
    case 'topics':
      return [
        `Topics (${report.topic_count})`,
        ...report.topics.map((topic) =>
          `- ${topic.tenant_id}:${topic.topic} | subscribers=${topic.subscribers} | fan_out=${topic.fan_out_count} | request_kinds=${topic.request_kinds.join(', ')}`,
        ),
      ];
    case 'all':
    default:
      return formatMeshHubInspectionReport(report);
  }
}

async function main(): Promise<void> {
  const argv = createStandardYargs()
    .scriptName('mesh_hub_inspect')
    .usage('$0 [section]')
    .positional('section', {
      type: 'string',
      choices: ['all', 'peers', 'routes', 'deliveries', 'dead-letters', 'topics'],
      default: 'all',
      describe: 'Which read-only mesh hub view to render',
    })
    .option('json', { type: 'boolean', default: false })
    .option('namespace', { type: 'string', describe: 'Optional mesh hub runtime namespace' })
    .parseSync();

  const section = (argv.section || 'all') as MeshHubInspectionSection;
  const report = await inspectMeshHub({
    namespace: typeof argv.namespace === 'string' && argv.namespace.trim() ? argv.namespace.trim() : undefined,
  });

  if (argv.json) {
    printJson({
      section,
      ...report,
    });
    return;
  }

  for (const line of renderSection(section, report)) {
    console.log(line);
  }
}

const isDirect = process.argv[1] && /mesh_hub_inspect\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((error) => {
    logger.error(error?.message ?? String(error));
    process.exit(1);
  });
}

export { main as runMeshHubInspect };
