import type {
  OrganizationCadenceRecord,
  OrganizationDecisionRecord,
  OrganizationIncidentRecord,
  OrganizationOperationRecord,
  OrganizationOperationRun,
  OrganizationOperationType,
  OrganizationPurposeRecord,
  OrganizationServiceState,
} from '@agent/core/organization-operating-model';

/** Argument parsing and help text for `pnpm organization` (scripts/organization_operating_model.ts). */
export type ParsedArgs = {
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
  runId?: string;
  runStatus?: OrganizationOperationRun['status'];
  resultSummary?: string;
  startedAt?: string;
  completedAt?: string;
  exceptionRefs: string[];
  operationType?: OrganizationOperationType;
  triggerKind?: OrganizationOperationRecord['trigger']['kind'];
  triggerExpression?: string;
  triggerTimezone?: string;
  deadlineBusinessDay?: number;
  deadlineTime?: string;
  executionKind?: OrganizationOperationRecord['execution_target']['kind'];
  executionRef?: string;
  allowedActions: string[];
  approvalRequiredActions: string[];
  forbiddenActions: string[];
  operationSourceRefs: string[];
  projectId?: string;
  cadenceId?: string;
  cadenceType?: OrganizationCadenceRecord['cadence_type'];
  schedule?: string;
  decisionId?: string;
  incidentId?: string;
  severity?: OrganizationIncidentRecord['severity'];
  impactSummary?: string;
  mitigationMissionId?: string;
  postIncidentReviewRef?: string;
  approvalRef?: string;
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
  parentOrganizationId?: string;
  clearParent?: boolean;
  runbookRefs: string[];
  evidenceOutputs: string[];
};

export function parseArgs(args: string[]): ParsedArgs {
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
    allowedActions: [],
    approvalRequiredActions: [],
    forbiddenActions: [],
    operationSourceRefs: [],
    exceptionRefs: [],
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
    if (arg === '--incident-id') {
      parsed.incidentId = args[++index];
      continue;
    }
    if (arg === '--severity') {
      parsed.severity = args[++index] as OrganizationIncidentRecord['severity'];
      continue;
    }
    if (arg === '--impact-summary') {
      parsed.impactSummary = args[++index];
      continue;
    }
    if (arg === '--mitigation-mission-id') {
      parsed.mitigationMissionId = args[++index];
      continue;
    }
    if (arg === '--post-incident-review-ref') {
      parsed.postIncidentReviewRef = args[++index];
      continue;
    }
    if (arg === '--approval-ref') {
      parsed.approvalRef = args[++index];
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
    if (arg === '--run-id') {
      parsed.runId = args[++index];
      continue;
    }
    if (arg === '--run-status') {
      parsed.runStatus = args[++index] as OrganizationOperationRun['status'];
      continue;
    }
    if (arg === '--result-summary') {
      parsed.resultSummary = args[++index];
      continue;
    }
    if (arg === '--started-at') {
      parsed.startedAt = args[++index];
      continue;
    }
    if (arg === '--completed-at') {
      parsed.completedAt = args[++index];
      continue;
    }
    if (arg === '--exception-ref') {
      parsed.exceptionRefs.push(args[++index]);
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
    if (arg === '--deadline-business-day') {
      parsed.deadlineBusinessDay = Number(args[++index]);
      continue;
    }
    if (arg === '--deadline-time') {
      parsed.deadlineTime = args[++index];
      continue;
    }
    if (arg === '--timezone') {
      parsed.triggerTimezone = args[++index];
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
    if (arg === '--allowed-action') {
      parsed.allowedActions.push(args[++index]);
      continue;
    }
    if (arg === '--approval-required-action') {
      parsed.approvalRequiredActions.push(args[++index]);
      continue;
    }
    if (arg === '--forbidden-action') {
      parsed.forbiddenActions.push(args[++index]);
      continue;
    }
    if (arg === '--operation-source-ref') {
      parsed.operationSourceRefs.push(args[++index]);
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
    if (arg === '--parent-organization-id') {
      parsed.parentOrganizationId = args[++index];
      continue;
    }
    if (arg === '--clear') {
      parsed.clearParent = true;
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

export function usage(): string {
  return [
    'Usage:',
    '  pnpm organization model [--json]',
    '  pnpm organization list [--tier <tier>] [--tenant-slug <slug>] [--json]',
    '  pnpm organization show --organization-id <id> [--tier <tier>] [--tenant-slug <slug>] [--json]',
    '  pnpm organization purpose show --organization-id <id> [--tier <tier>] [--tenant-slug <slug>] [--json]',
    '  pnpm organization status --organization-id <id> [--tier <tier>] [--tenant-slug <slug>] [--json]',
    '  pnpm organization domain list --organization-id <id> [--json]',
    '  pnpm organization service list --organization-id <id> [--health] [--json]',
    '  pnpm organization operation list --organization-id <id> [--status <status>] [--json]',
    '  pnpm organization project list --organization-id <id> [--json]',
    '  pnpm organization cadence list --organization-id <id> [--status <status>] [--json]',
    '  pnpm organization decision list --organization-id <id> [--decision-id <id>] [--cadence-id <id>] [--status <status>] [--json]',
    '  pnpm organization incident list --organization-id <id> [--incident-id <id>] [--json]',
    '  pnpm organization lineage --organization-id <id> [--json]',
    '  pnpm organization learning list --organization-id <id> [--status <status>] [--json]',
    '  pnpm organization learning enqueue --organization-id <id> --tier <tier> --learning-id <id> --source-type <type> --source-ref <ref> --title <title> --summary <summary> --target-kind <kind> [--evidence-ref <ref>] [--dry-run|--apply] [--json]',
    '  pnpm organization reconcile --organization-id <id> [--dry-run|--apply] [--json]',
    '  pnpm organization work resolve --organization-id <id> --intent "<request>" --dry-run [--json]',
    '',
    'Authoring (each requires exactly one of --dry-run | --apply):',
    '  pnpm organization init --organization-id <id> --name <name> --tier <tier> [--tenant-slug <slug>] [--purpose <text>] [--principle <p>]... [--owner-role <role>] [--parent-organization-id <id>]',
    '  pnpm organization parent set --organization-id <id> --tier <tier> [--tenant-slug <slug>] --parent-organization-id <id>|--clear (parent must be in the same tier and tenant)',
    '  pnpm organization purpose set --organization-id <id> --name <name> --tier <tier> [--tenant-slug <slug>] --purpose <text> --owner-role <role> [--principle <p>]... [--approval-state <state>]',
    '  pnpm organization objective add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --objective-id <id> --title <title> [--description <text>] [--horizon <h>] [--owner-role <role>]',
    '  pnpm organization domain add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --domain-id <id> --name <name> --owner-role <role> [--purpose <text>]',
    '  pnpm organization service add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --service-id <id> --domain-id <id> --name <name> --outcome <text> --owner-role <role> --consumer <c>... [--slo-target <t>] [--slo-window <w>] [--runbook-ref <ref>]... [--record-status <s>]',
    '  pnpm organization operation add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --operation-id <id> --name <name> --operation-type <continuous|scheduled|event_driven|governance> --owner-role <role> [--service-id <id>] [--purpose <text>] [--trigger-kind <k>] [--trigger-expression <value>] --timezone <IANA> (required for schedule) [--deadline-business-day <n> --deadline-time <HH:MM>] [--execution-kind <mission|task_session|pipeline|actuator|runbook>] [--execution-ref <ref>] [--record-status <draft|active>] [--allowed-action <text>]... [--approval-required-action <text>]... [--forbidden-action <text>]... [--operation-source-ref <ref>]... [--evidence-output <ref>]...',
    '  pnpm organization operation run record --organization-id <id> --tier <tier> [--tenant-slug <slug>] --operation-id <id> --run-id <id> --run-status <succeeded|failed|blocked|cancelled> --result-summary <text> [--started-at <iso>] [--completed-at <iso>] [--evidence-ref <ref>]... [--exception-ref <ref>]... [--execution-ref <ref>] [--dry-run|--apply]',
    '  pnpm organization operation run execute --organization-id <id> --tier <tier> [--tenant-slug <slug>] --operation-id <id> --run-id <id> --dry-run|--apply [--json] (governed pipelines/ targets only)',
    '  pnpm organization operation tick --organization-id <id> --tier <tier> [--tenant-slug <slug>] --dry-run|--apply [--json] (one catch-up run per due operation)',
    '  pnpm organization operation done --operation-id <id> [--organization-id <id>] [--tier <tier>] [--tenant-slug <slug>] [--result-summary <text>] [--evidence-ref <ref>]... [--run-id <id>] --dry-run|--apply (operator-attested completion; a runbook operation cites its runbook, run id defaults to <operation>-<YYYYMMDD>)',
    '  pnpm organization operation run list --organization-id <id> --tier <tier> [--tenant-slug <slug>] [--operation-id <id>] [--json]',
    '  pnpm organization service state set --organization-id <id> --tier <tier> [--tenant-slug <slug>] --service-id <id> --health-status <healthy|degraded|critical|unknown> [--reconcile-status <current|stale|missing_source|conflict|unknown>] [--freshness-seconds <n>] [--confidence <0..1>] [--source-timestamp <iso>]',
    '  pnpm organization cadence add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --cadence-id <id> --name <name> --cadence-type <daily|weekly|biweekly|monthly|quarterly|annual|ad_hoc> --schedule <text> --owner-role <role> [--record-status <s>]',
    '  pnpm organization decision add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --decision-id <id> --cadence-id <id> --title <title> --decision-owner <role> --due-at <iso> --option <o>... [--decision-type <t>] [--requested-by <role>] [--chosen-option <o>] [--rationale <text>] [--follow-up-ref <ref>]... [--record-status <s>]',
    '  pnpm organization decision transition --organization-id <id> --tier <tier> [--tenant-slug <slug>] --decision-id <id> --record-status <status> [--chosen-option <o>] [--rationale <text>] [--approval-ref <channel:id>] [--follow-up-ref <ref>]... --dry-run|--apply',
    '  pnpm organization incident add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --incident-id <id> --title <title> --severity <level> --owner-role <role> --impact-summary <text> [--service-id <id>] [--operation-id <id>] --dry-run|--apply',
    '  pnpm organization incident transition --organization-id <id> --tier <tier> [--tenant-slug <slug>] --incident-id <id> --record-status <status> [--impact-summary <text>] [--mitigation-mission-id <id>] [--post-incident-review-ref <ref>] --dry-run|--apply',
    '  pnpm organization project attach --organization-id <id> --project-id <id> [--tier <tier>] [--tenant-slug <slug>]',
    '  pnpm organization project detach --organization-id <id> --project-id <id> [--tier <tier>] [--tenant-slug <slug>]',
    '  pnpm organization pause|resume|archive --organization-id <id> --tier <tier> [--tenant-slug <slug>] [--reason <text>] [--dry-run|--apply]',
    '  pnpm organization retire --organization-id <id> --tier <tier> --kind <domain|capability|service|operation|cadence> --record-id <id> [--tenant-slug <slug>] [--reason <text>] [--dry-run|--apply]',
    '  pnpm organization remove --organization-id <id> --tier <tier> --kind <domain|capability|service|operation|cadence> --record-id <id> [--tenant-slug <slug>] [--reason <text>] [--dry-run|--apply]',
    '',
    'Notes:',
    '  - Writes under active/organizations/ are authority-gated: run with KYBERION_PERSONA=sovereign, or MISSION_ROLE=organization_operator with KYBERION_TENANT=<slug> for that tenant only.',
    '  - Reads use the current `pnpm scope` tier and tenant unless explicitly narrowed by flags.',
    '  - Select an organization with --organization-id or `pnpm scope use --organization <id> ...`.',
    '  - confidential reads require --tenant-slug or an active tenant in `pnpm scope`.',
    '  - confidential writes require --tenant-slug explicitly.',
    '  - service add also updates the parent domain service_ids; project attach validates the project registry.',
    '  - service state set declares runtime health when no telemetry feed owns the service; reconcile',
    '    reports a service with no state as services_without_state and will not infer health from absence.',
    '  - decision add requires an existing cadence and appends the decision to its decision_ids, so the',
    '    cadence record stays the index of everything that body decided. decision list is newest-first.',
  ].join('\n');
}
