import {
  archiveManagedProject,
  bootstrapManagedProject,
  buildManagedProjectRecord,
  createManagedProject,
  createManagedProjectTrack,
  ensureProjectOsScaffold,
  getProjectManagementView,
  listManagedProjects,
  reconcileProjectOperationalState,
  updateManagedProjectTrack,
  updateManagedProject,
} from '@agent/core';
import type { ProjectTrackRecord } from '@agent/core';
import { defineScript } from './lib/harness.js';

type ProjectTier = 'personal' | 'confidential' | 'public';
type ProjectStatus = 'draft' | 'active' | 'paused' | 'archived';

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function requiredOption(argv: string[], name: string): string {
  const value = optionValue(argv, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function csvOption(argv: string[], name: string): string[] | undefined {
  const value = optionValue(argv, name);
  if (!value) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function jsonOutput(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printProjectList(): void {
  for (const view of listManagedProjects()) {
    const { project } = view;
    console.log(
      `${project.project_id}\t${project.status}\t${project.tier}\t${project.name}\ttasks=${view.tasks.length}\tmissions=${view.missions.length}\ttask_sessions=${view.task_sessions.length}`
    );
  }
}

function printHelp(): void {
  console.log(
    `Project controller\n\nCommands:\n  list [--json]\n  show <PROJECT_ID> [--json]\n  create --project-id <ID> --name <NAME> --summary <TEXT> --tier <personal|confidential|public> [--organization-id <ID>] [--tenant-slug <SLUG>] [--project-path <PATH>] [--pipeline-refs <CSV>] [--status <STATUS>] [--primary-locale <LOCALE>] [--dry-run] [--json]\n  scaffold <PROJECT_ID> [--json]\n  track create --track-id <ID> --project-id <ID> --name <NAME> --summary <TEXT> [--track-type <TYPE>] [--lifecycle-model <MODEL>] [--status <STATUS>] [--release-id <ID>] [--required-artifacts <CSV>] [--json]\n  track update --track-id <ID> --tenant-slug <SLUG> [--json]\n  update|update-status <PROJECT_ID> [--name <NAME>] [--summary <TEXT>] [--status <STATUS>] [--primary-locale <LOCALE>] [--pipeline-refs <CSV>] [--metadata <JSON>] [--json]\n  archive <PROJECT_ID> [--reason <TEXT>] [--json]\n  reconcile [PROJECT_ID] [--dry-run|--apply] [--json]\n  bootstrap --project-id <ID> --name <NAME> --summary <TEXT> --tier <personal|confidential|public> [--organization-id <ID>] [--tenant-slug <SLUG>] [--utterance <TEXT>] [--track-id <ID>] [--track-name <NAME>] [--pipeline-refs <CSV>] [--service-bindings <CSV>] [--json]\n\nReconcile defaults to dry-run; pass --apply to repair registry and operational state.`
  );
}

function parseTier(value: string | undefined): ProjectTier {
  if (value === 'personal' || value === 'confidential' || value === 'public') return value;
  throw new Error(`Invalid --tier: ${value || '(missing)'}`);
}

function parseStatus(value: string | undefined): ProjectStatus {
  if (value === 'draft' || value === 'active' || value === 'paused' || value === 'archived')
    return value;
  throw new Error(`Invalid project status: ${value || '(missing)'}`);
}

function parseTrackType(value: string | undefined): ProjectTrackRecord['track_type'] {
  const values: ProjectTrackRecord['track_type'][] = [
    'delivery',
    'change',
    'release',
    'incident',
    'compliance',
    'operations',
    'research',
  ];
  if (value && values.includes(value as ProjectTrackRecord['track_type'])) {
    return value as ProjectTrackRecord['track_type'];
  }
  throw new Error(`Invalid --track-type: ${value || '(missing)'}`);
}

function parseLifecycleModel(value: string | undefined): ProjectTrackRecord['lifecycle_model'] {
  const values: ProjectTrackRecord['lifecycle_model'][] = [
    'sdlc',
    'continuous_delivery',
    'incident_response',
    'continuous_operations',
    'research_cycle',
  ];
  if (value && values.includes(value as ProjectTrackRecord['lifecycle_model'])) {
    return value as ProjectTrackRecord['lifecycle_model'];
  }
  throw new Error(`Invalid --lifecycle-model: ${value || '(missing)'}`);
}

function parseTrackStatus(value: string | undefined): ProjectTrackRecord['status'] {
  const values: ProjectTrackRecord['status'][] = [
    'planned',
    'active',
    'paused',
    'completed',
    'archived',
  ];
  if (value && values.includes(value as ProjectTrackRecord['status'])) {
    return value as ProjectTrackRecord['status'];
  }
  throw new Error(`Invalid track status: ${value || '(missing)'}`);
}

async function main(args: string[] = []): Promise<void> {
  const [command, ...argv] = args;
  const positional = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const json = hasFlag(argv, '--json');

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  switch (command) {
    case 'list': {
      const projects = listManagedProjects();
      if (json) jsonOutput(projects);
      else printProjectList();
      return;
    }
    case 'show': {
      const projectId = positional || requiredOption(argv, '--project-id');
      const view = getProjectManagementView(projectId);
      if (json) jsonOutput(view);
      else {
        console.log(`${view.project.project_id}: ${view.project.name}`);
        console.log(`status=${view.project.status} tier=${view.project.tier}`);
        console.log(
          `tracks=${view.tracks.length} tasks=${view.tasks.length} missions=${view.missions.length} task_sessions=${view.task_sessions.length} pipelines=${view.lineage.pipelines.length}`
        );
        console.log(`operational_states=${view.operational_states.length}`);
        console.log('hierarchy=Project -> Track -> Mission -> Task / Task Session');
        console.log(
          'Task is a work item; Task Session is the resumable execution context and does not own the Task.'
        );
      }
      return;
    }
    case 'scaffold': {
      const projectId = positional || requiredOption(argv, '--project-id');
      const view = getProjectManagementView(projectId);
      const projectPath = ensureProjectOsScaffold(
        view.project.project_id,
        view.project.name,
        view.project.tier,
        view.project.tenant_slug || 'shared'
      );
      const result = { project_id: projectId, project_path: projectPath };
      if (json) jsonOutput(result);
      else console.log(`Scaffolded project ${projectId}: ${projectPath}`);
      return;
    }
    case 'track': {
      const [trackCommand, ...trackArgv] = argv;
      if (trackCommand === 'update') {
        const record = updateManagedProjectTrack(requiredOption(trackArgv, '--track-id'), {
          tenant_slug: requiredOption(trackArgv, '--tenant-slug'),
        });
        if (hasFlag(trackArgv, '--json')) jsonOutput(record);
        else console.log(`Updated project track ${record.track_id}`);
        return;
      }
      if (trackCommand !== 'create')
        throw new Error(`Unknown track command: ${trackCommand || '(missing)'}`);
      const record = createManagedProjectTrack({
        track_id: requiredOption(trackArgv, '--track-id'),
        project_id: requiredOption(trackArgv, '--project-id'),
        name: requiredOption(trackArgv, '--name'),
        summary: requiredOption(trackArgv, '--summary'),
        ...(optionValue(trackArgv, '--track-type')
          ? { track_type: parseTrackType(optionValue(trackArgv, '--track-type')) }
          : {}),
        ...(optionValue(trackArgv, '--lifecycle-model')
          ? { lifecycle_model: parseLifecycleModel(optionValue(trackArgv, '--lifecycle-model')) }
          : {}),
        ...(optionValue(trackArgv, '--status')
          ? { status: parseTrackStatus(optionValue(trackArgv, '--status')) }
          : {}),
        ...(optionValue(trackArgv, '--release-id')
          ? { release_id: optionValue(trackArgv, '--release-id') }
          : {}),
        ...(csvOption(trackArgv, '--required-artifacts')
          ? { required_artifacts: csvOption(trackArgv, '--required-artifacts') }
          : {}),
      });
      if (hasFlag(trackArgv, '--json')) jsonOutput(record);
      else console.log(`Created project track ${record.track_id}`);
      return;
    }
    case 'create': {
      const input = {
        project_id: requiredOption(argv, '--project-id'),
        name: requiredOption(argv, '--name'),
        summary: requiredOption(argv, '--summary'),
        tier: parseTier(optionValue(argv, '--tier')),
        ...(optionValue(argv, '--organization-id')
          ? { organization_id: optionValue(argv, '--organization-id') }
          : {}),
        ...(optionValue(argv, '--tenant-slug')
          ? { tenant_slug: optionValue(argv, '--tenant-slug') }
          : {}),
        ...(optionValue(argv, '--status')
          ? { status: parseStatus(optionValue(argv, '--status')) }
          : {}),
        ...(optionValue(argv, '--primary-locale')
          ? { primary_locale: optionValue(argv, '--primary-locale') }
          : {}),
        ...(optionValue(argv, '--project-path')
          ? { project_path: optionValue(argv, '--project-path') }
          : {}),
        ...(csvOption(argv, '--pipeline-refs')
          ? { pipeline_refs: csvOption(argv, '--pipeline-refs') }
          : {}),
      };
      const record = hasFlag(argv, '--dry-run')
        ? buildManagedProjectRecord(input)
        : createManagedProject(input);
      if (json) jsonOutput(record);
      else console.log(`Created project ${record.project_id}`);
      return;
    }
    case 'update':
    case 'update-status': {
      const projectId = positional || requiredOption(argv, '--project-id');
      const metadataRaw = optionValue(argv, '--metadata');
      const patch = {
        ...(optionValue(argv, '--name') ? { name: optionValue(argv, '--name') } : {}),
        ...(optionValue(argv, '--summary') ? { summary: optionValue(argv, '--summary') } : {}),
        ...(optionValue(argv, '--status')
          ? { status: parseStatus(optionValue(argv, '--status')) }
          : {}),
        ...(optionValue(argv, '--primary-locale')
          ? { primary_locale: optionValue(argv, '--primary-locale') }
          : {}),
        ...(csvOption(argv, '--pipeline-refs')
          ? { pipeline_refs: csvOption(argv, '--pipeline-refs') }
          : {}),
        ...(metadataRaw ? { metadata: JSON.parse(metadataRaw) as Record<string, unknown> } : {}),
      };
      const record = updateManagedProject(projectId, patch);
      if (json) jsonOutput(record);
      else console.log(`Updated project ${record.project_id}`);
      return;
    }
    case 'archive': {
      const projectId = positional || requiredOption(argv, '--project-id');
      const record = archiveManagedProject(projectId, optionValue(argv, '--reason'));
      if (json) jsonOutput(record);
      else console.log(`Archived project ${record.project_id}`);
      return;
    }
    case 'reconcile': {
      const projectIds = positional
        ? [positional]
        : listManagedProjects().map((view) => view.project.project_id);
      const apply = hasFlag(argv, '--apply');
      const reports = projectIds.map((projectId) =>
        reconcileProjectOperationalState(projectId, { apply })
      );
      if (json) jsonOutput(positional ? reports[0] : reports);
      else
        for (const report of reports)
          console.log(`${report.project_id}\t${report.status}\tissues=${report.issues.length}`);
      return;
    }
    case 'bootstrap': {
      const result = bootstrapManagedProject({
        project_id: requiredOption(argv, '--project-id'),
        name: requiredOption(argv, '--name'),
        summary: requiredOption(argv, '--summary'),
        tier: parseTier(optionValue(argv, '--tier')),
        ...(optionValue(argv, '--organization-id')
          ? { organization_id: optionValue(argv, '--organization-id') }
          : {}),
        ...(optionValue(argv, '--tenant-slug')
          ? { tenant_slug: optionValue(argv, '--tenant-slug') }
          : {}),
        ...(optionValue(argv, '--status')
          ? { status: parseStatus(optionValue(argv, '--status')) }
          : {}),
        ...(optionValue(argv, '--primary-locale')
          ? { primary_locale: optionValue(argv, '--primary-locale') }
          : {}),
        ...(optionValue(argv, '--project-path')
          ? { project_path: optionValue(argv, '--project-path') }
          : {}),
        ...(optionValue(argv, '--utterance')
          ? { utterance: optionValue(argv, '--utterance') }
          : {}),
        ...(optionValue(argv, '--track-id') ? { track_id: optionValue(argv, '--track-id') } : {}),
        ...(optionValue(argv, '--track-name')
          ? { track_name: optionValue(argv, '--track-name') }
          : {}),
        ...(csvOption(argv, '--pipeline-refs')
          ? { pipeline_refs: csvOption(argv, '--pipeline-refs') }
          : {}),
        ...(csvOption(argv, '--service-bindings')
          ? { service_bindings: csvOption(argv, '--service-bindings') }
          : {}),
      });
      if (json) jsonOutput(result);
      else
        console.log(
          `Bootstrapped project ${result.project.project_id} with ${result.mission_seed_ids.length} mission seeds and kickoff ${result.kickoff_task_session.session_id}`
        );
      return;
    }
    default:
      throw new Error(`Unknown project command: ${command}`);
  }
}

void defineScript({
  name: 'project',
  flags: [],
  run: ({ argv }) => main(argv),
})();
