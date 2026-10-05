import type {
  OrganizationCadenceRecord,
  OrganizationDecisionRecord,
  OrganizationIncidentRecord,
  OrganizationOperationRecord,
  OrganizationOperationRun,
  OrganizationOperationType,
  OrganizationPurposeRecord,
  OrganizationServiceState,
} from '@agent/core/organization/organization-operating-model';

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
  krId?: string;
  metricJson?: string;
  target?: number;
  direction?: 'increase' | 'decrease' | 'maintain';
  baseline?: number;
  unit?: string;
  weight?: number;
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
  type FlagSpec =
    | { kind: 'flag'; field: keyof ParsedArgs }
    | { kind: 'value'; field: keyof ParsedArgs; asNumber?: boolean }
    | { kind: 'push'; field: keyof ParsedArgs }
    | { kind: 'set-command'; command: string };

  const FLAG_SPECS: Record<string, FlagSpec> = {
    '--json': { kind: 'flag', field: 'json' },
    '--health': { kind: 'flag', field: 'health' },
    '--dry-run': { kind: 'flag', field: 'dryRun' },
    '--apply': { kind: 'flag', field: 'apply' },
    '--organization-id': { kind: 'value', field: 'organizationId' },
    '--org': { kind: 'value', field: 'organizationId' },
    '--tier': { kind: 'value', field: 'tier' },
    '--status': { kind: 'value', field: 'status' },
    '--intent': { kind: 'value', field: 'intent' },
    '--learning-id': { kind: 'value', field: 'learningId' },
    '--source-type': { kind: 'value', field: 'sourceType' },
    '--source-ref': { kind: 'value', field: 'sourceRef' },
    '--title': { kind: 'value', field: 'title' },
    '--summary': { kind: 'value', field: 'summary' },
    '--target-kind': { kind: 'value', field: 'targetKind' },
    '--evidence-ref': { kind: 'push', field: 'evidenceRefs' },
    '--tenant-slug': { kind: 'value', field: 'tenantSlug' },
    '--tenant': { kind: 'value', field: 'tenantSlug' },
    '--name': { kind: 'value', field: 'name' },
    '--purpose': { kind: 'value', field: 'purposeText' },
    '--owner-role': { kind: 'value', field: 'ownerRole' },
    '--principle': { kind: 'push', field: 'principles' },
    '--approval-state': { kind: 'value', field: 'approvalState' },
    '--objective-id': { kind: 'value', field: 'objectiveId' },
    '--kr-id': { kind: 'value', field: 'krId' },
    '--metric-json': { kind: 'value', field: 'metricJson' },
    '--target': { kind: 'value', field: 'target', asNumber: true },
    '--direction': { kind: 'value', field: 'direction' },
    '--baseline': { kind: 'value', field: 'baseline', asNumber: true },
    '--unit': { kind: 'value', field: 'unit' },
    '--weight': { kind: 'value', field: 'weight', asNumber: true },
    '--description': { kind: 'value', field: 'description' },
    '--horizon': { kind: 'value', field: 'horizon' },
    '--domain-id': { kind: 'value', field: 'domainId' },
    '--service-id': { kind: 'value', field: 'serviceId' },
    '--outcome': { kind: 'value', field: 'outcome' },
    '--cadence-id': { kind: 'value', field: 'cadenceId' },
    '--cadence-type': { kind: 'value', field: 'cadenceType' },
    '--schedule': { kind: 'value', field: 'schedule' },
    '--decision-id': { kind: 'value', field: 'decisionId' },
    '--incident-id': { kind: 'value', field: 'incidentId' },
    '--severity': { kind: 'value', field: 'severity' },
    '--impact-summary': { kind: 'value', field: 'impactSummary' },
    '--mitigation-mission-id': { kind: 'value', field: 'mitigationMissionId' },
    '--post-incident-review-ref': { kind: 'value', field: 'postIncidentReviewRef' },
    '--approval-ref': { kind: 'value', field: 'approvalRef' },
    '--decision-type': { kind: 'value', field: 'decisionType' },
    '--decision-owner': { kind: 'value', field: 'decisionOwner' },
    '--due-at': { kind: 'value', field: 'dueAt' },
    '--option': { kind: 'push', field: 'options' },
    '--chosen-option': { kind: 'value', field: 'chosenOption' },
    '--rationale': { kind: 'value', field: 'rationale' },
    '--requested-by': { kind: 'value', field: 'requestedBy' },
    '--follow-up-ref': { kind: 'push', field: 'followUpRefs' },
    '--health-status': { kind: 'value', field: 'healthStatus' },
    '--reconcile-status': { kind: 'value', field: 'reconcileStatus' },
    '--freshness-seconds': { kind: 'value', field: 'freshnessSeconds', asNumber: true },
    '--confidence': { kind: 'value', field: 'confidence', asNumber: true },
    '--source-timestamp': { kind: 'value', field: 'sourceTimestamp' },
    '--consumer': { kind: 'push', field: 'consumers' },
    '--slo-target': { kind: 'value', field: 'sloTarget' },
    '--slo-window': { kind: 'value', field: 'sloWindow' },
    '--operation-id': { kind: 'value', field: 'operationId' },
    '--run-id': { kind: 'value', field: 'runId' },
    '--run-status': { kind: 'value', field: 'runStatus' },
    '--result-summary': { kind: 'value', field: 'resultSummary' },
    '--started-at': { kind: 'value', field: 'startedAt' },
    '--completed-at': { kind: 'value', field: 'completedAt' },
    '--exception-ref': { kind: 'push', field: 'exceptionRefs' },
    '--operation-type': { kind: 'value', field: 'operationType' },
    '--trigger-kind': { kind: 'value', field: 'triggerKind' },
    '--trigger-expression': { kind: 'value', field: 'triggerExpression' },
    '--deadline-business-day': { kind: 'value', field: 'deadlineBusinessDay', asNumber: true },
    '--deadline-time': { kind: 'value', field: 'deadlineTime' },
    '--timezone': { kind: 'value', field: 'triggerTimezone' },
    '--execution-kind': { kind: 'value', field: 'executionKind' },
    '--execution-ref': { kind: 'value', field: 'executionRef' },
    '--allowed-action': { kind: 'push', field: 'allowedActions' },
    '--approval-required-action': { kind: 'push', field: 'approvalRequiredActions' },
    '--forbidden-action': { kind: 'push', field: 'forbiddenActions' },
    '--operation-source-ref': { kind: 'push', field: 'operationSourceRefs' },
    '--project-id': { kind: 'value', field: 'projectId' },
    '--record-status': { kind: 'value', field: 'recordStatus' },
    '--kind': { kind: 'value', field: 'recordKind' },
    '--record-id': { kind: 'value', field: 'recordId' },
    '--reason': { kind: 'value', field: 'reason' },
    '--parent-organization-id': { kind: 'value', field: 'parentOrganizationId' },
    '--clear': { kind: 'flag', field: 'clearParent' },
    '--runbook-ref': { kind: 'push', field: 'runbookRefs' },
    '--evidence-output': { kind: 'push', field: 'evidenceOutputs' },
    '--help': { kind: 'set-command', command: 'help' },
    '-h': { kind: 'set-command', command: 'help' },
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const spec = FLAG_SPECS[arg];
    if (spec) {
      if (spec.kind === 'set-command') {
        parsed.command = spec.command;
      } else if (spec.kind === 'flag') {
        (parsed as Record<string, unknown>)[spec.field] = true;
      } else if (spec.kind === 'push') {
        (parsed[spec.field] as string[]).push(args[++index]);
      } else {
        (parsed as Record<string, unknown>)[spec.field] = spec.asNumber
          ? Number(args[++index])
          : args[++index];
      }
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
    '  pnpm organization learning enqueue --organization-id <id> --tier <tier> --learning-id <id> --source-type <incident_review|routine_exception|project_closure|governance_decision> --source-ref <ref> --title <title> --summary <summary> --target-kind <pattern|sop_candidate|knowledge_hint|report_template> [--evidence-ref <ref>] [--dry-run|--apply] [--json]',
    '  pnpm organization reconcile --organization-id <id> [--dry-run|--apply] [--json]',
    '  pnpm organization work resolve --organization-id <id> --intent "<request>" --dry-run [--json]',
    '',
    'Authoring (each requires exactly one of --dry-run | --apply):',
    '  pnpm organization init --organization-id <id> --name <name> --tier <tier> [--tenant-slug <slug>] [--purpose <text>] [--principle <p>]... [--owner-role <role>] [--parent-organization-id <id>]',
    '  pnpm organization parent set --organization-id <id> --tier <tier> [--tenant-slug <slug>] --parent-organization-id <id>|--clear (parent must be in the same tier and tenant)',
    '  pnpm organization purpose set --organization-id <id> --name <name> --tier <tier> [--tenant-slug <slug>] --purpose <text> --owner-role <role> [--principle <p>]... [--approval-state <state>]',
    '  pnpm organization objective add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --objective-id <id> --title <title> [--description <text>] [--horizon <h>] [--owner-role <role>]',
    '  pnpm organization objective kr add --organization-id <id> --tier <tier> [--tenant-slug <slug>] --objective-id <id> --kr-id <id> --title <title> --metric-json <json> --target <n> --direction <increase|decrease|maintain> [--baseline <n>] [--unit <u>] [--weight <n>]',
    '      --metric-json shapes: {"source":"org_metric","metric":"open_incidents|overdue_operations|pending_decisions|unhealthy_services"} | {"source":"file","path":"<repo-relative json>","json_path":"<key>"} | {"source":"probe","probe":{...}} | {"source":"signal_ratio","signal":"<name>"}',
    '  pnpm organization objective kr measure --organization-id <id> --tier <tier> [--tenant-slug <slug>] --dry-run|--apply [--json] (measures due KRs without a dot; status then shows progress)',
    '  pnpm organization objective kr list --organization-id <id> --tier <tier> [--tenant-slug <slug>] [--objective-id <id>]',
    '  pnpm organization objective kr remove --organization-id <id> --tier <tier> [--tenant-slug <slug>] --objective-id <id> --kr-id <id>',
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
    '  - decision lifecycle: proposed -> pending_approval -> approved -> implemented (side branches:',
    '    proposed/pending_approval -> deferred -> pending_approval; pending_approval -> rejected [terminal]).',
    '    New decisions always start as proposed; approving requires --rationale and --approval-ref <channel:id>.',
    '  - project create with --organization-id attaches the project automatically; a separate project attach',
    '    is only needed for projects created without an organization.',
    '  - operation tick/execute on confidential/personal tiers require a matching `pnpm scope use --tier <tier>`',
    '    `--tenant <slug> --organization <id>` selection first, even for --dry-run.',
    '  - operation run record requires --evidence-ref for succeeded runs; evidence/execution refs must be',
    '    existing paths inside the operation scope (the operation definition holds the pipelines/ execution ref).',
  ].join('\n');
}
