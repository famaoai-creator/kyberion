import {
  buildOrganizationManagementView,
  buildOrganizationLearningCandidate,
  enqueueOrganizationLearningCandidate,
  loadOrganizationOperatingModelCatalog,
  loadOrganizationProfile,
  reconcileOrganizationState,
  resolveOrganizationWork,
} from '@agent/core';

type ParsedArgs = {
  command: string;
  organizationId?: string;
  tier?: 'personal' | 'confidential' | 'public';
  tenantSlug?: string;
  status?: string;
  intent?: string;
  learningId?: string;
  sourceType?: 'incident_review' | 'routine_exception' | 'project_closure' | 'governance_decision';
  sourceRef?: string;
  title?: string;
  summary?: string;
  targetKind?: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  evidenceRefs: string[];
  dryRun: boolean;
  apply: boolean;
  json: boolean;
  health: boolean;
};

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const parsed: ParsedArgs = {
    command: 'model',
    json: false,
    health: false,
    dryRun: false,
    apply: false,
    evidenceRefs: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--health') {
      parsed.health = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--apply') {
      parsed.apply = true;
      continue;
    }
    if (arg === '--organization-id' || arg === '--org') {
      parsed.organizationId = args[++index];
      continue;
    }
    if (arg === '--tier') {
      parsed.tier = args[++index] as ParsedArgs['tier'];
      continue;
    }
    if (arg === '--status') {
      parsed.status = args[++index];
      continue;
    }
    if (arg === '--intent') {
      parsed.intent = args[++index];
      continue;
    }
    if (arg === '--learning-id') {
      parsed.learningId = args[++index];
      continue;
    }
    if (arg === '--source-type') {
      parsed.sourceType = args[++index] as ParsedArgs['sourceType'];
      continue;
    }
    if (arg === '--source-ref') {
      parsed.sourceRef = args[++index];
      continue;
    }
    if (arg === '--title') {
      parsed.title = args[++index];
      continue;
    }
    if (arg === '--summary') {
      parsed.summary = args[++index];
      continue;
    }
    if (arg === '--target-kind') {
      parsed.targetKind = args[++index] as ParsedArgs['targetKind'];
      continue;
    }
    if (arg === '--evidence-ref') {
      parsed.evidenceRefs.push(args[++index]);
      continue;
    }
    if (arg === '--tenant-slug' || arg === '--tenant') {
      parsed.tenantSlug = args[++index];
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.command = 'help';
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 0) parsed.command = positional.join(' ');
  return parsed;
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm organization model [--json]',
    '  pnpm organization show --organization-id <id> [--tier <tier>] [--tenant-slug <slug>] [--json]',
    '  pnpm organization purpose show --organization-id <id> [--tier <tier>] [--tenant-slug <slug>] [--json]',
    '  pnpm organization status --organization-id <id> [--tier <tier>] [--tenant-slug <slug>] [--json]',
    '  pnpm organization domain list --organization-id <id> [--json]',
    '  pnpm organization service list --organization-id <id> [--health] [--json]',
    '  pnpm organization operation list --organization-id <id> [--status <status>] [--json]',
    '  pnpm organization project list --organization-id <id> [--json]',
    '  pnpm organization lineage --organization-id <id> [--json]',
    '  pnpm organization learning list --organization-id <id> [--status <status>] [--json]',
    '  pnpm organization learning enqueue --organization-id <id> --tier <tier> --learning-id <id> --source-type <type> --source-ref <ref> --title <title> --summary <summary> --target-kind <kind> [--evidence-ref <ref>] [--dry-run|--apply] [--json]',
    '  pnpm organization reconcile --organization-id <id> [--dry-run|--apply] [--json]',
    '  pnpm organization work resolve --organization-id <id> --intent "<request>" --dry-run [--json]',
  ].join('\n');
}

function emit(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

export function runOrganizationOperatingModelCli(args = process.argv.slice(2)): void {
  const parsed = parseArgs(args);
  if (parsed.command === 'help') {
    console.log(usage());
    return;
  }
  if (parsed.command === 'model') {
    emit(loadOrganizationOperatingModelCatalog(), parsed.json);
    return;
  }
  const organizationId = parsed.organizationId || loadOrganizationProfile()?.organization_id;
  if (parsed.command === 'work resolve') {
    if (!organizationId) {
      throw new Error('--organization-id is required when no organization profile is configured.');
    }
    if (!parsed.intent) throw new Error('--intent is required for work resolve.');
    if (!parsed.dryRun) throw new Error('work resolve is read-only and requires --dry-run.');
    emit(
      resolveOrganizationWork({
        utterance: parsed.intent,
        organizationId,
        tier: parsed.tier,
        tenantSlug: parsed.tenantSlug,
      }),
      parsed.json
    );
    return;
  }
  if (parsed.command === 'reconcile') {
    if (!organizationId) {
      throw new Error('--organization-id is required when no organization profile is configured.');
    }
    if (parsed.dryRun && parsed.apply) {
      throw new Error('--dry-run and --apply cannot be used together.');
    }
    emit(
      reconcileOrganizationState({
        organizationId,
        tier: parsed.tier,
        tenantSlug: parsed.tenantSlug,
        apply: parsed.apply,
      }),
      parsed.json
    );
    return;
  }
  if (parsed.command === 'learning enqueue') {
    if (!organizationId) {
      throw new Error('--organization-id is required when no organization profile is configured.');
    }
    if (!parsed.tier) throw new Error('--tier is required for learning enqueue.');
    if (parsed.dryRun === parsed.apply) {
      throw new Error('Specify exactly one of --dry-run or --apply for learning enqueue.');
    }
    if (
      !parsed.learningId ||
      !parsed.sourceType ||
      !parsed.sourceRef ||
      !parsed.title ||
      !parsed.summary ||
      !parsed.targetKind
    ) {
      throw new Error(
        '--learning-id, --source-type, --source-ref, --title, --summary, and --target-kind are required.'
      );
    }
    const input = {
      learningId: parsed.learningId,
      organizationId,
      sourceType: parsed.sourceType,
      sourceRef: parsed.sourceRef,
      title: parsed.title,
      summary: parsed.summary,
      targetKind: parsed.targetKind,
      evidenceRefs: parsed.evidenceRefs,
      tier: parsed.tier,
      tenantSlug: parsed.tenantSlug,
    };
    emit(
      parsed.apply
        ? enqueueOrganizationLearningCandidate(input)
        : buildOrganizationLearningCandidate(input),
      parsed.json
    );
    return;
  }
  if (
    parsed.command === 'show' ||
    parsed.command === 'status' ||
    parsed.command === 'purpose show' ||
    parsed.command === 'domain list' ||
    parsed.command === 'service list' ||
    parsed.command === 'operation list' ||
    parsed.command === 'project list' ||
    parsed.command === 'lineage' ||
    parsed.command === 'learning list'
  ) {
    if (!organizationId) {
      throw new Error('--organization-id is required when no organization profile is configured.');
    }
    const view = buildOrganizationManagementView({
      organizationId,
      tier: parsed.tier,
      tenantSlug: parsed.tenantSlug,
    });
    if (parsed.command === 'domain list') {
      emit(view.domains, parsed.json);
      return;
    }
    if (parsed.command === 'service list') {
      const services = parsed.health
        ? view.services.map((service) => ({
            service,
            state:
              view.service_states.find((state) => state.service_id === service.service_id) || null,
          }))
        : view.services;
      emit(services, parsed.json);
      return;
    }
    if (parsed.command === 'operation list') {
      emit(
        parsed.status
          ? view.operations.filter((operation) => operation.status === parsed.status)
          : view.operations,
        parsed.json
      );
      return;
    }
    if (parsed.command === 'project list') {
      emit(view.solution_projects, parsed.json);
      return;
    }
    if (parsed.command === 'lineage') {
      emit(view.lineage, parsed.json);
      return;
    }
    if (parsed.command === 'learning list') {
      emit(
        parsed.status
          ? view.learning_candidates.filter((candidate) => candidate.status === parsed.status)
          : view.learning_candidates,
        parsed.json
      );
      return;
    }
    emit(parsed.command === 'purpose show' ? view.purpose : view, parsed.json);
    return;
  }
  throw new Error(`Unknown command '${parsed.command}'.\n${usage()}`);
}

const isDirect =
  process.argv[1]?.endsWith('organization_operating_model.ts') ||
  process.argv[1]?.endsWith('organization_operating_model.js');
if (isDirect) {
  try {
    runOrganizationOperatingModelCli();
  } catch (error) {
    console.error(`[organization] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
