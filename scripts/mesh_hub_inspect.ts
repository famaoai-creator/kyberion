import { createStandardYargs } from '@agent/core/cli-utils';
import { formatMeshHubInspectionReport, inspectMeshHub } from '@agent/core/mesh-hub-inspection';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

type Print = (value: unknown) => void;

type MeshHubInspectionSection =
  'all' | 'peers' | 'routes' | 'deliveries' | 'dead-letters' | 'topics';

function printJson(data: unknown, print: Print): void {
  print(JSON.stringify(data, null, 2));
}

function renderSection(
  section: MeshHubInspectionSection,
  report: Awaited<ReturnType<typeof inspectMeshHub>>
): string[] {
  switch (section) {
    case 'peers':
      return [
        `Peers (${report.peer_count})`,
        ...report.peers.map(
          (peer) =>
            `- ${peer.peer_id} | ${peer.tenant_id || 'unknown'} | ${peer.heartbeat_state} | ${peer.status} | age=${peer.heartbeat_age_ms ?? 'n/a'}ms | caps=${peer.capabilities.join(', ') || 'none'}`
        ),
      ];
    case 'routes':
    case 'deliveries':
      return [
        `Routes (${report.route_count})`,
        ...report.routes.map(
          (route) =>
            `- ${route.delivery_id} | ${route.state} | retry=${route.retry_count} | expires=${route.expires_at} | ${route.route_explanation}`
        ),
      ];
    case 'dead-letters':
      return [
        `Dead letters (${report.dead_letter_count})`,
        ...report.dead_letters.map(
          (deadLetter) =>
            `- ${deadLetter.dead_letter_id} | ${deadLetter.delivery_id} | ${deadLetter.failure_class} | ${deadLetter.redacted_reason}`
        ),
      ];
    case 'topics':
      return [
        `Topics (${report.topic_count})`,
        ...report.topics.map(
          (topic) =>
            `- ${topic.tenant_id}:${topic.topic} | subscribers=${topic.subscribers} | fan_out=${topic.fan_out_count} | request_kinds=${topic.request_kinds.join(', ')}`
        ),
      ];
    case 'all':
    default:
      return formatMeshHubInspectionReport(report);
  }
}

async function main(args: string[] = [], print: Print = () => undefined): Promise<void> {
  const argv = createStandardYargs(['node', 'mesh_hub_inspect', ...args])
    .scriptName('mesh_hub_inspect')
    .usage('$0 [section]')
    .positional('section', {
      type: 'string',
      choices: ['all', 'peers', 'routes', 'deliveries', 'dead-letters', 'topics'],
      default: 'all',
      describe: 'Which read-only mesh hub view to render',
    })
    .option('json', { type: 'boolean', default: false })
    .option('tenant-id', {
      type: 'string',
      default: getRegisteredEnvText('KYBERION_TENANT_ID') || '',
      demandOption: true,
      describe: 'Tenant whose Mesh Hub view is being inspected',
    })
    .option('namespace', { type: 'string', describe: 'Optional mesh hub runtime namespace' })
    .parseSync();

  const requestedSection = argv._[0] || argv.section || 'all';
  const section = String(requestedSection) as MeshHubInspectionSection;
  const report = await inspectMeshHub({
    tenantId: String(argv['tenant-id']).trim(),
    namespace:
      typeof argv.namespace === 'string' && argv.namespace.trim()
        ? argv.namespace.trim()
        : undefined,
  });

  if (argv.json) {
    printJson({ section, ...report }, print);
    return;
  }

  for (const line of renderSection(section, report)) {
    print(line);
  }
}

export { main as runMeshHubInspect };

export const runMeshHubInspectScript = defineScript({
  name: 'mesh-hub:inspect',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'mesh_hub_inspect.ts') ||
  isDirectScript(import.meta.url, 'mesh_hub_inspect.js')
)
  void runMeshHubInspectScript();
