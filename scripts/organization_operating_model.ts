import {
  buildOrganizationDomainRecord,
  buildOrganizationLearningCandidate,
  buildOrganizationManagementView,
  buildOrganizationObjectiveAddition,
  buildOrganizationOperationRecord,
  buildOrganizationProjectLink,
  buildOrganizationPurposeRecord,
  buildOrganizationScaffold,
  buildOrganizationCadence,
  buildOrganizationDecision,
  buildOrganizationServiceAddition,
  buildOrganizationServiceState,
  enqueueOrganizationLearningCandidate,
  loadOrganizationOperatingModelCatalog,
  loadOrganizationProfile,
  removeOrganizationEntity,
  reconcileOrganizationState,
  retireOrganizationEntity,
  transitionOrganizationLifecycle,
  resolveOrganizationWork,
  saveOrganizationDomain,
  saveOrganizationOperation,
  saveOrganizationOperationalState,
  saveOrganizationPurpose,
  saveOrganizationCadence,
  saveOrganizationDecision,
  saveOrganizationService,
  saveOrganizationServiceState,
  type OrganizationCadenceRecord,
  type OrganizationDecisionRecord,
  type OrganizationOperationRecord,
  type OrganizationOperationType,
  type OrganizationPurposeRecord,
  type OrganizationServiceRecord,
  type OrganizationServiceState,
} from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

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
  name?: string;
  purposeText?: string;
  ownerRole?: string;
  principles: string[];
  approvalState?: OrganizationPurposeRecord['approval_state'];
  objectiveId?: string;
  description?: string;
  horizon?: string;
  domainId?: string;
  serviceId?: string;
  outcome?: string;
  consumers: string[];
  sloTarget?: string;
  sloWindow?: string;
  /** `service state set` value. Distinct from the boolean `--health` of `service list`. */
  healthStatus?: OrganizationServiceState['health'];
  reconcileStatus?: OrganizationServiceState['reconcile_status'];
  freshnessSeconds?: number;
  confidence?: number;
  sourceTimestamp?: string;
  operationId?: string;
  operationType?: OrganizationOperationType;
  triggerKind?: OrganizationOperationRecord['trigger']['kind'];
  triggerExpression?: string;
  executionKind?: OrganizationOperationRecord['execution_target']['kind'];
  executionRef?: string;
  projectId?: string;
  cadenceId?: string;
  cadenceType?: OrganizationCadenceRecord['cadence_type'];
  schedule?: string;
  decisionId?: string;
  decisionType?: OrganizationDecisionRecord['decision_type'];
  decisionOwner?: string;
  dueAt?: string;
  options: string[];
  chosenOption?: string;
  rationale?: string;
  requestedBy?: string;
  followUpRefs: string[];
  recordStatus?: string;
  recordKind?: 'domain' | 'capability' | 'service' | 'operation' | 'cadence';
  recordId?: string;
  reason?: string;
  runbookRefs: string[];
  evidenceOutputs: string[];
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
    principles: [],
    consumers: [],
    runbookRefs: [],
    evidenceOutputs: [],
    options: [],
    followUpRefs: [],
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
    if (arg === '--name') {
      parsed.name = args[++index];
      continue;
    }
    if (arg === '--purpose') {
      parsed.purposeText = args[++index];
      continue;
    }
    if (arg === '--owner-role') {
      parsed.ownerRole = args[++index];
      continue;
    }
    if (arg === '--principle') {
      parsed.principles.push(args[++index]);
      continue;
    }
    if (arg === '--approval-state') {
      parsed.approvalState = args[++index] as ParsedArgs['approvalState'];
      continue;
    }
    if (arg === '--objective-id') {
      parsed.objectiveId = args[++index];
      continue;
    }
    if (arg === '--description') {
      parsed.description = args[++index];
      continue;
    }
    if (arg === '--horizon') {
      parsed.horizon = args[++index];
      continue;
    }
    if (arg === '--domain-id') {
      parsed.domainId = args[++index];
      continue;
    }
    if (arg === '--service-id') {
      parsed.serviceId = args[++index];
      continue;
    }
    if (arg === '--outcome') {
      parsed.outcome = args[++index];
      continue;
    }
    if (arg === '--cadence-id') {
      parsed.cadenceId = args[++index];
      continue;
    }
    if (arg === '--cadence-type') {
      parsed.cadenceType = args[++index] as OrganizationCadenceRecord['cadence_type'];
      continue;
    }
    if (arg === '--schedule') {
      parsed.schedule = args[++index];
      continue;
    }
    if (arg === '--decision-id') {
      parsed.decisionId = args[++index];
      continue;
    }
    if (arg === '--decision-type') {
      parsed.decisionType = args[++index] as OrganizationDecisionRecord['decision_type'];
      continue;
    }
    if (arg === '--decision-owner') {
      parsed.decisionOwner = args[++index];
      continue;
    }
    if (arg === '--due-at') {
      parsed.dueAt = args[++index];
      continue;
    }
    if (arg === '--option') {
      parsed.options.push(args[++index]);
      continue;
    }
    if (arg === '--chosen-option') {
      parsed.chosenOption = args[++index];
      continue;
    }
    if (arg === '--rationale') {
      parsed.rationale = args[++index];
      continue;
    }
    if (arg === '--requested-by') {
      parsed.requestedBy = args[++index];
      continue;
    }
    if (arg === '--follow-up-ref') {
      parsed.followUpRefs.push(args[++index]);
      continue;
    }
    if (arg === '--health-status') {
      parsed.healthStatus = args[++index] as OrganizationServiceState['health'];
      continue;
    }
    if (arg === '--reconcile-status') {
      parsed.reconcileStatus = args[++index] as OrganizationServiceState['reconcile_status'];
      continue;
    }
    if (arg === '--freshness-seconds') {
      parsed.freshnessSeconds = Number(args[++index]);
      continue;
    }
    if (arg === '--confidence') {
      parsed.confidence = Number(args[++index]);
      continue;
    }
    if (arg === '--source-timestamp') {
      parsed.sourceTimestamp = args[++index];
      continue;
    }
    if (arg === '--consumer') {
      parsed.consumers.push(args[++index]);
      continue;
    }
    if (arg === '--slo-target') {
      parsed.sloTarget = args[++index];
      continue;
    }
    if (arg === '--slo-window') {
      parsed.sloWindow = args[++index];
      continue;
    }
    if (arg === '--operation-id') {
      parsed.operationId = args[++index];
      continue;
    }
    if (arg === '--operation-type') {
      parsed.operationType = args[++index] as ParsedArgs['operationType'];
      continue;
    }
    if (arg === '--trigger-kind') {
      parsed.triggerKind = args[++index] as ParsedArgs['triggerKind'];
      continue;
    }
    if (arg === '--trigger-expression') {
      parsed.triggerExpression = args[++index];
      continue;
    }
    if (arg === '--execution-kind') {
      parsed.executionKind = args[++index] as ParsedArgs['executionKind'];
      continue;
    }
    if (arg === '--execution-ref') {
      parsed.executionRef = args[++index];
      continue;
    }
    if (arg === '--project-id') {
      parsed.projectId = args[++index];
      continue;
    }
    if (arg === '--record-status') {
      parsed.recordStatus = args[++index];
      continue;
    }
    if (arg === '--kind') {
      parsed.recordKind = args[++index] as ParsedArgs['recordKind'];
      continue;
    }
    if (arg === '--record-id') {
      parsed.recordId = args[++index];
      continue;
    }
    if (arg === '--reason') {
      parsed.reason = args[++index];
      continue;
    }
    if (arg === '--runbook-ref') {
      parsed.runbookRefs.push(args[++index]);
      continue;
    }
    if (arg === '--evidence-output') {
      parsed.evidenceOutputs.push(args[++index]);
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
    '  pnpm organization cadence list --organization-id <id> [--status <status>] [--json]',
    '  pnpm organization decision list --organization-id <id> [--cadence-id <id>] [--status <status>] [--json]',
    '  pnpm organization lineage --organization-id <id> [--json]',
    '  pnpm organization learning list --organization-id <id> [--status <status>] [--json]',
    '  pnpm organization learning enqueue --organization-id <id> --tier <tier> --learning-id <id> --source-type <type> --source-ref <ref> --title <title> --summary <summary> --target-kind <kind> [--evidence-ref <ref>] [--dry-run|--apply] [--json]',
    '  pnpm organization reconcile --organization-id <id> [--dry-run|--apply] [--json]',
    '  pnpm organization work resolve --organization-id <id> --intent "<request>" --dry-run [--json]',
    '',
    'Authoring (each requires exactly one of --dry-run | --apply):',
    '  pnpm organization init --organization-id <id> --name <name> --tier <tier> [--tenant-slug <slug>] [--purpose <text>] [--principle <p>]... [--owner-role <role>]',
    '  pnpm organization purpose set --organization-id <id> --name <name> --tier <tier> [--tenant-slug <slug>] --purpose <text> --owner-role <role> [--principle <p>]... [--approval-state <state>]',
    '  pnpm organization objective add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --objective-id <id> --title <title> [--description <text>] [--horizon <h>] [--owner-role <role>]',
    '  pnpm organization domain add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --domain-id <id> --name <name> --owner-role <role> [--purpose <text>]',
    '  pnpm organization service add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --service-id <id> --domain-id <id> --name <name> --outcome <text> --owner-role <role> --consumer <c>... [--slo-target <t>] [--slo-window <w>] [--runbook-ref <ref>]... [--record-status <s>]',
    '  pnpm organization operation add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --operation-id <id> --name <name> --operation-type <continuous|scheduled|event_driven|governance> --owner-role <role> [--service-id <id>] [--purpose <text>] [--trigger-kind <k>] [--trigger-expression <cron>] [--execution-kind <k>] [--execution-ref <ref>] [--evidence-output <ref>]...',
    '  pnpm organization service state set --organization-id <id> --tier <tier> [--tenant-slug <slug>] --service-id <id> --health-status <healthy|degraded|critical|unknown> [--reconcile-status <current|stale|missing_source|conflict|unknown>] [--freshness-seconds <n>] [--confidence <0..1>] [--source-timestamp <iso>]',
    '  pnpm organization cadence add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --cadence-id <id> --name <name> --cadence-type <daily|weekly|monthly|quarterly|ad_hoc> --schedule <text> --owner-role <role> [--record-status <s>]',
    '  pnpm organization decision add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --decision-id <id> --cadence-id <id> --title <title> --decision-owner <role> --due-at <iso> --option <o>... [--decision-type <t>] [--requested-by <role>] [--chosen-option <o>] [--rationale <text>] [--follow-up-ref <ref>]... [--record-status <s>]',
    '  pnpm organization project attach --organization-id <id> --project-id <id> [--tier <tier>] [--tenant-slug <slug>]',
    '  pnpm organization project detach --organization-id <id> --project-id <id> [--tier <tier>] [--tenant-slug <slug>]',
    '  pnpm organization pause|resume|archive --organization-id <id> --tier <tier> [--tenant-slug <slug>] [--reason <text>] [--dry-run|--apply]',
    '  pnpm organization retire --organization-id <id> --tier <tier> --kind <domain|capability|service|operation|cadence> --record-id <id> [--tenant-slug <slug>] [--reason <text>] [--dry-run|--apply]',
    '  pnpm organization remove --organization-id <id> --tier <tier> --kind <domain|capability|service|operation|cadence> --record-id <id> [--tenant-slug <slug>] [--reason <text>] [--dry-run|--apply]',
    '',
    'Notes:',
    '  - Writes under active/organizations/ are authority-gated: run with KYBERION_PERSONA=sovereign.',
    '  - confidential tier requires --tenant-slug (tenant-scoped storage).',
    '  - service add also updates the parent domain service_ids; project attach validates the project registry.',
    '  - service state set declares runtime health when no telemetry feed owns the service; reconcile',
    '    reports a service with no state as services_without_state and will not infer health from absence.',
    '  - decision add requires an existing cadence and appends the decision to its decision_ids, so the',
    '    cadence record stays the index of everything that body decided. decision list is newest-first.',
  ].join('\n');
}

function resolveWriteMode(parsed: ParsedArgs, command: string): 'dry_run' | 'apply' {
  if (parsed.dryRun === parsed.apply) {
    throw new Error(`Specify exactly one of --dry-run or --apply for ${command}.`);
  }
  return parsed.apply ? 'apply' : 'dry_run';
}

function requireFlags(command: string, flags: Record<string, string | undefined>): void {
  const missing = Object.entries(flags)
    .filter(([, value]) => !value)
    .map(([flag]) => flag);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required for ${command}.`
    );
  }
}

function emit(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

export function runOrganizationOperatingModelCli(args: string[] = []): void {
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
  if (parsed.command === 'init') {
    if (!organizationId) throw new Error('--organization-id is required for init.');
    requireFlags('init', { '--name': parsed.name, '--tier': parsed.tier });
    const mode = resolveWriteMode(parsed, 'init');
    const scaffold = buildOrganizationScaffold({
      organizationId,
      name: parsed.name!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      purpose: parsed.purposeText,
      principles: parsed.principles,
      ownerRole: parsed.ownerRole,
    });
    const savedPaths: string[] = [];
    if (mode === 'apply') {
      savedPaths.push(saveOrganizationOperationalState(scaffold.state));
      if (scaffold.purpose) savedPaths.push(saveOrganizationPurpose(scaffold.purpose));
    }
    emit({ mode, ...scaffold, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (['pause', 'resume', 'archive'].includes(parsed.command)) {
    if (!organizationId) throw new Error(`--organization-id is required for ${parsed.command}.`);
    requireFlags(parsed.command, { '--tier': parsed.tier });
    const mode = resolveWriteMode(parsed, parsed.command);
    const next =
      mode === 'apply'
        ? transitionOrganizationLifecycle({
            organizationId,
            tier: parsed.tier!,
            tenantSlug: parsed.tenantSlug,
            verb: parsed.command as 'pause' | 'resume' | 'archive',
            reason: parsed.reason,
          })
        : {
            status: 'dry-run',
            verb: parsed.command,
            organization_id: organizationId,
            tier: parsed.tier,
            tenant_slug: parsed.tenantSlug,
            reason: parsed.reason,
          };
    emit({ mode, state: next }, parsed.json);
    return;
  }
  if (parsed.command === 'retire' || parsed.command === 'remove') {
    if (!organizationId) throw new Error(`--organization-id is required for ${parsed.command}.`);
    requireFlags(parsed.command, {
      '--tier': parsed.tier,
      '--kind': parsed.recordKind,
      '--record-id': parsed.recordId,
    });
    const mode = resolveWriteMode(parsed, parsed.command);
    const next =
      mode === 'apply'
        ? parsed.command === 'retire'
          ? retireOrganizationEntity({
              organizationId,
              tier: parsed.tier!,
              tenantSlug: parsed.tenantSlug,
              kind: parsed.recordKind!,
              recordId: parsed.recordId!,
              reason: parsed.reason,
            })
          : removeOrganizationEntity({
              organizationId,
              tier: parsed.tier!,
              tenantSlug: parsed.tenantSlug,
              kind: parsed.recordKind!,
              recordId: parsed.recordId!,
              reason: parsed.reason,
            })
        : {
            status: 'dry-run',
            kind: parsed.recordKind,
            record_id: parsed.recordId,
            organization_id: organizationId,
            tier: parsed.tier,
            tenant_slug: parsed.tenantSlug,
            reason: parsed.reason,
          };
    emit({ mode, record: next }, parsed.json);
    return;
  }
  if (parsed.command === 'purpose set') {
    if (!organizationId) throw new Error('--organization-id is required for purpose set.');
    requireFlags('purpose set', {
      '--name': parsed.name,
      '--tier': parsed.tier,
      '--purpose': parsed.purposeText,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'purpose set');
    const record = buildOrganizationPurposeRecord({
      organizationId,
      name: parsed.name!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      purpose: parsed.purposeText!,
      principles: parsed.principles,
      ownerRole: parsed.ownerRole!,
      approvalState: parsed.approvalState,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationPurpose(record)] : [];
    emit({ mode, purpose: record, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'objective add') {
    if (!organizationId) throw new Error('--organization-id is required for objective add.');
    requireFlags('objective add', {
      '--tier': parsed.tier,
      '--objective-id': parsed.objectiveId,
      '--title': parsed.title,
    });
    const mode = resolveWriteMode(parsed, 'objective add');
    const record = buildOrganizationObjectiveAddition({
      organizationId,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      objective: {
        objective_id: parsed.objectiveId!,
        title: parsed.title!,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.horizon ? { horizon: parsed.horizon } : {}),
        status: 'active',
        ...(parsed.ownerRole ? { owner_role: parsed.ownerRole } : {}),
      },
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationPurpose(record)] : [];
    emit({ mode, purpose: record, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'domain add') {
    if (!organizationId) throw new Error('--organization-id is required for domain add.');
    requireFlags('domain add', {
      '--tier': parsed.tier,
      '--domain-id': parsed.domainId,
      '--name': parsed.name,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'domain add');
    const record = buildOrganizationDomainRecord({
      organizationId,
      domainId: parsed.domainId!,
      name: parsed.name!,
      ownerRole: parsed.ownerRole!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      purpose: parsed.purposeText,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationDomain(record)] : [];
    emit({ mode, domain: record, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'service add') {
    if (!organizationId) throw new Error('--organization-id is required for service add.');
    requireFlags('service add', {
      '--tier': parsed.tier,
      '--service-id': parsed.serviceId,
      '--domain-id': parsed.domainId,
      '--name': parsed.name,
      '--outcome': parsed.outcome,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'service add');
    const addition = buildOrganizationServiceAddition({
      organizationId,
      serviceId: parsed.serviceId!,
      domainId: parsed.domainId!,
      name: parsed.name!,
      outcome: parsed.outcome!,
      ownerRole: parsed.ownerRole!,
      consumers: parsed.consumers,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      sloTarget: parsed.sloTarget,
      sloWindow: parsed.sloWindow,
      runbookRefs: parsed.runbookRefs,
      status: parsed.recordStatus as OrganizationServiceRecord['status'] | undefined,
    });
    const savedPaths =
      mode === 'apply'
        ? [saveOrganizationService(addition.service), saveOrganizationDomain(addition.domain)]
        : [];
    emit({ mode, ...addition, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'cadence add') {
    if (!organizationId) throw new Error('--organization-id is required for cadence add.');
    requireFlags('cadence add', {
      '--tier': parsed.tier,
      '--cadence-id': parsed.cadenceId,
      '--name': parsed.name,
      '--cadence-type': parsed.cadenceType,
      '--schedule': parsed.schedule,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'cadence add');
    const record = buildOrganizationCadence({
      organizationId,
      cadenceId: parsed.cadenceId!,
      name: parsed.name!,
      cadenceType: parsed.cadenceType!,
      schedule: parsed.schedule!,
      ownerRole: parsed.ownerRole!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      status: parsed.recordStatus as OrganizationCadenceRecord['status'] | undefined,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationCadence(record)] : [];
    emit({ mode, cadence: record, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'decision add') {
    if (!organizationId) throw new Error('--organization-id is required for decision add.');
    requireFlags('decision add', {
      '--tier': parsed.tier,
      '--decision-id': parsed.decisionId,
      '--cadence-id': parsed.cadenceId,
      '--title': parsed.title,
      '--decision-owner': parsed.decisionOwner,
      '--due-at': parsed.dueAt,
    });
    const mode = resolveWriteMode(parsed, 'decision add');
    const addition = buildOrganizationDecision({
      organizationId,
      decisionId: parsed.decisionId!,
      cadenceId: parsed.cadenceId!,
      title: parsed.title!,
      decisionOwner: parsed.decisionOwner!,
      dueAt: parsed.dueAt!,
      options: parsed.options,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      decisionType: parsed.decisionType,
      status: parsed.recordStatus as OrganizationDecisionRecord['status'] | undefined,
      requestedBy: parsed.requestedBy,
      chosenOption: parsed.chosenOption,
      rationale: parsed.rationale,
      followUpRefs: parsed.followUpRefs,
    });
    const savedPaths =
      mode === 'apply'
        ? [saveOrganizationDecision(addition.decision), saveOrganizationCadence(addition.cadence)]
        : [];
    emit({ mode, ...addition, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'service state set') {
    if (!organizationId) throw new Error('--organization-id is required for service state set.');
    requireFlags('service state set', {
      '--tier': parsed.tier,
      '--service-id': parsed.serviceId,
      '--health-status': parsed.healthStatus,
    });
    const mode = resolveWriteMode(parsed, 'service state set');
    const state = buildOrganizationServiceState({
      organizationId,
      serviceId: parsed.serviceId!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      health: parsed.healthStatus!,
      reconcileStatus: parsed.reconcileStatus,
      freshnessSeconds: parsed.freshnessSeconds,
      confidence: parsed.confidence,
      sourceTimestamp: parsed.sourceTimestamp,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationServiceState(state)] : [];
    emit({ mode, service_state: state, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'operation add') {
    if (!organizationId) throw new Error('--organization-id is required for operation add.');
    requireFlags('operation add', {
      '--tier': parsed.tier,
      '--operation-id': parsed.operationId,
      '--name': parsed.name,
      '--operation-type': parsed.operationType,
      '--owner-role': parsed.ownerRole,
    });
    const mode = resolveWriteMode(parsed, 'operation add');
    const record = buildOrganizationOperationRecord({
      organizationId,
      operationId: parsed.operationId!,
      name: parsed.name!,
      operationType: parsed.operationType!,
      ownerRole: parsed.ownerRole!,
      tier: parsed.tier!,
      tenantSlug: parsed.tenantSlug,
      serviceId: parsed.serviceId,
      purpose: parsed.purposeText,
      triggerKind: parsed.triggerKind,
      triggerExpression: parsed.triggerExpression,
      executionKind: parsed.executionKind,
      executionRef: parsed.executionRef,
      evidenceOutputs: parsed.evidenceOutputs,
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationOperation(record)] : [];
    emit({ mode, operation: record, saved_paths: savedPaths }, parsed.json);
    return;
  }
  if (parsed.command === 'project attach' || parsed.command === 'project detach') {
    if (!organizationId) throw new Error(`--organization-id is required for ${parsed.command}.`);
    requireFlags(parsed.command, { '--project-id': parsed.projectId });
    const mode = resolveWriteMode(parsed, parsed.command);
    const record = buildOrganizationProjectLink({
      organizationId,
      projectId: parsed.projectId!,
      tier: parsed.tier,
      tenantSlug: parsed.tenantSlug,
      detach: parsed.command === 'project detach',
    });
    const savedPaths = mode === 'apply' ? [saveOrganizationOperationalState(record)] : [];
    emit({ mode, state: record, saved_paths: savedPaths }, parsed.json);
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
    parsed.command === 'cadence list' ||
    parsed.command === 'decision list' ||
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
    if (parsed.command === 'cadence list') {
      emit(
        parsed.status
          ? view.cadences.filter((cadence) => cadence.status === parsed.status)
          : view.cadences,
        parsed.json
      );
      return;
    }
    if (parsed.command === 'decision list') {
      // Ordered newest-first so "last meeting's decisions" is the head of the
      // list rather than something the reader has to scan for.
      const decisions = [...view.decisions].sort((left, right) =>
        left.updated_at < right.updated_at ? 1 : left.updated_at > right.updated_at ? -1 : 0
      );
      emit(
        [
          ...(parsed.cadenceId
            ? decisions.filter((decision) => decision.cadence_id === parsed.cadenceId)
            : decisions),
        ].filter((decision) => !parsed.status || decision.status === parsed.status),
        parsed.json
      );
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

export const runOrganizationOperatingModel = defineScript({
  name: 'organization:operating-model',
  flags: [],
  run: ({ argv }) => runOrganizationOperatingModelCli(argv),
});

if (
  isDirectScript(import.meta.url, 'organization_operating_model.ts') ||
  isDirectScript(import.meta.url, 'organization_operating_model.js')
)
  void runOrganizationOperatingModel();
