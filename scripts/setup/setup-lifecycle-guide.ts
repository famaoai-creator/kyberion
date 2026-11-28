export const SETUP_LIFECYCLE_COMMAND = 'pnpm kyberion setup report --lifecycle';
export const FIRST_REQUEST_READINESS_COMMAND =
  'pnpm kyberion setup report --persona first-time-user';
export const BASELINE_CHECK_COMMAND = 'pnpm pipeline --input pipelines/baseline-check.json';

export function onboardingSetupHandoff(hasTenantDrafts: boolean) {
  return {
    baseline_command: BASELINE_CHECK_COMMAND,
    ...(hasTenantDrafts
      ? { tenant_activation_guide: `${SETUP_LIFECYCLE_COMMAND} --domain tenant` }
      : {}),
    readiness_command: FIRST_REQUEST_READINESS_COMMAND,
    lifecycle_command: `${SETUP_LIFECYCLE_COMMAND} --summary`,
  };
}

export function onboardingSetupPreview(hasTenantDrafts: boolean) {
  const handoff = onboardingSetupHandoff(hasTenantDrafts);
  return {
    available_now: { lifecycle_reference_command: handoff.lifecycle_command },
    after_apply: handoff,
  };
}

export interface LifecycleRoute {
  id: string;
  title: string;
  use_when: string;
  inspection_commands: readonly string[];
  inspection_note?: string;
  related_domains?: readonly string[];
  actions: ReadonlyArray<{ effect: 'change' | 'resume' | 'register' | 'terminal'; path: string }>;
  check: string;
}

const routes: readonly LifecycleRoute[] = [
  {
    id: 'installation',
    title: 'Local installation and identity',
    use_when: 'Set up this checkout and your identity, or review what a local reset removes.',
    inspection_commands: ['pnpm kyberion setup report', 'pnpm onboarding reset --dry-run'],
    actions: [
      { effect: 'register', path: 'pnpm onboarding' },
      {
        effect: 'change',
        path: 'pnpm onboarding reset --dry-run to review generated identity and onboarding files before reset',
      },
    ],
    check: 'Run setup report again after onboarding. Reset removes local onboarding artifacts.',
  },
  {
    id: 'tenant',
    title: 'Tenant registry and activation',
    use_when: 'Find or bind a tenant, check activation, resume access, or plan offboarding.',
    inspection_commands: [
      'pnpm tenant list',
      'pnpm tenant show <tenant-slug>',
      'pnpm onboarding:context show --customer-slug <customer-slug> --json',
      'pnpm onboarding:context bind --customer-slug <customer-slug> --tenant-slug <tenant-slug> --organization-id <org-id> --dry-run --json',
      'pnpm tenant:activation plan --customer-slug <customer-slug> --tenant-slug <tenant-slug> --organization-id <org-id>',
    ],
    inspection_note:
      'For an existing tenant, match the registry record and confirm the organization before binding context. For first activation, plan and probe the same scope before asking a human to accept activation. For scope exit, open the offboard preview.',
    related_domains: ['organization', 'objectives', 'offboard'],
    actions: [
      {
        effect: 'register',
        path: 'After reviewing the context bind preview, repeat it with --apply in place of --dry-run.',
      },
      {
        effect: 'register',
        path: 'After the activation plan and probe pass, use pnpm tenant:activation activate --customer-slug <customer-slug> --tenant-slug <tenant-slug> --organization-id <org-id> --apply --accept with human acceptance.',
      },
      {
        effect: 'resume',
        path: 'pnpm tenant resume <slug> --apply for a suspended registry entry',
      },
      {
        effect: 'resume',
        path: 'Run tenant:activation probe with the same tenant and organization and the target NHI. Then run tenant:activation resume with the same scope and --apply --accept.',
      },
      { effect: 'terminal', path: 'tenant archive closes the registry entry' },
    ],
    check:
      'Use tenant:activation show for the saved receipt. Review grants separately after suspension.',
  },
  {
    id: 'organization',
    title: 'Organization, member and agent',
    use_when:
      'Check an organization’s operating status, members and agents, or resume its operations.',
    inspection_commands: [
      'pnpm organization status --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization reconcile --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug>',
      'pnpm organization member show <member-id> --tenant <tenant-slug>',
      'pnpm organization agent show --nhi-id <nhi-id> --tenant <tenant-slug>',
    ],
    related_domains: ['tenant', 'objectives', 'portfolio', 'operations'],
    actions: [
      {
        effect: 'resume',
        path: 'organization resume for a paused organization; member resume for a suspended member; agent activate with the reviewed version',
      },
      {
        effect: 'terminal',
        path: 'An archived organization cannot resume. Issue a fresh identity after agent retirement.',
      },
    ],
    check:
      'Read back the organization, member, or agent record. Runtime status requires a separate observation.',
  },
  {
    id: 'objectives',
    title: 'Organization objectives and key results',
    use_when: 'Set OKRs, measure progress, and see which projects contribute to an objective.',
    inspection_commands: [
      'pnpm organization status --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization objective kr list --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --objective-id <objective-id>',
    ],
    inspection_note:
      'Start with organization status in the intended tenant. Review the objective, its KR measurements, and the projects that reference it.',
    related_domains: ['organization', 'portfolio', 'project', 'operations', 'dot'],
    actions: [
      {
        effect: 'register',
        path: 'Use organization objective add and organization objective kr add to define the objective and how to measure it. Set --objective-ids on project create or project update to link delivery work.',
      },
      {
        effect: 'change',
        path: 'Use organization objective kr measure --apply for supported measurements or objective kr record --apply for values measured outside Kyberion. Supply the same organization, tier and tenant scope.',
      },
    ],
    check:
      'After project work, remeasure and review organization status for the KR values and linked projects.',
  },
  {
    id: 'portfolio',
    title: 'Solution Portfolio and project visibility',
    use_when:
      'Review multiple change projects in an organization and see which objectives they advance.',
    inspection_commands: [
      'pnpm organization status --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization lineage --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
    ],
    inspection_note:
      'Start with the organization view and its solution_projects. Use objective links to compare the purpose of projects, then open a project to inspect its tracks.',
    related_domains: ['organization', 'objectives', 'project', 'operations'],
    actions: [],
    check:
      'Confirm the organization scope, project status, and associated objectives before reviewing work across projects.',
  },
  {
    id: 'operations',
    title: 'Organization services and operations',
    use_when:
      'See what an organization delivers, check recurring runs, or review incidents and decisions.',
    inspection_commands: [
      'pnpm organization status --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization lineage --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization service list --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --health --json',
      'pnpm organization operation run list --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization cadence list --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization incident list --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
      'pnpm organization decision list --organization-id <org-id> --tier confidential --tenant-slug <tenant-slug> --json',
    ],
    inspection_note:
      'Use lineage to follow Domain, Capability, Service and Operation. Use run history for a recurring job and organization status for health, incidents and decisions.',
    related_domains: ['organization', 'objectives', 'portfolio', 'artifact', 'approval'],
    actions: [
      {
        effect: 'change',
        path: 'For a governed manual run, review organization operation run execute with --dry-run and the scoped operation and run IDs before applying.',
      },
    ],
    check:
      'Review the run outcome and its evidence, then check service health and any linked incident or decision.',
  },
  {
    id: 'project',
    title: 'Project creation and lifecycle',
    use_when:
      'Create a project for an objective, check its current state, or archive or restore it.',
    inspection_commands: ['pnpm project show <project-id> --json'],
    related_domains: ['portfolio', 'objectives', 'track', 'workitem', 'artifact', 'offboard'],
    actions: [
      {
        effect: 'register',
        path: 'Preview project create with --dry-run and the intended tenant, organization and --objective-ids. After creation, use project scaffold for the project workspace and project update-status to activate it.',
      },
      { effect: 'change', path: 'pnpm project archive <project-id> --dry-run' },
      {
        effect: 'resume',
        path: 'Preview with pnpm project restore <project-id> --dry-run. Apply by omitting --dry-run.',
      },
    ],
    check:
      'Check the resulting project status. An archived project needs an active parent organization to restore.',
  },
  {
    id: 'track',
    title: 'Project tracks, gates and required artifacts',
    use_when:
      'Organize a release or change lane, find its next gate, or see what artifact is required.',
    inspection_commands: [
      'pnpm project show <project-id> --json',
      'pnpm control doctor --surface chronos',
      'pnpm control chronos tracks <project-id>',
    ],
    inspection_note:
      'Start with project show for track status and configured artifact requirements. If Chronos tracks cannot connect, run control doctor for Chronos and follow the surface guide. Gate readiness is available through the live track view.',
    related_domains: ['project', 'mission', 'artifact', 'release', 'surface'],
    actions: [
      {
        effect: 'register',
        path: 'Use pnpm project track create with the project ID and reviewed lifecycle, gate profile and required artifacts. Use a governed mission seed when the next gate needs work.',
      },
      {
        effect: 'resume',
        path: 'Use pnpm project track resume <track-id> for a paused track.',
      },
      { effect: 'terminal', path: 'Archived tracks have no resume transition.' },
    ],
    check: 'Read back the track state, next gate and required artifacts before moving on.',
  },
  {
    id: 'access',
    title: 'Standing grants, personal consent and NHI sessions',
    use_when:
      'Review or withdraw permission to act, personal consent, or admission for an agent session.',
    inspection_commands: [
      'pnpm kyberion grants list --tenant <tenant-slug>',
      'pnpm onboarding nhi-session list --tenant <tenant-slug>',
    ],
    actions: [
      {
        effect: 'change',
        path: 'grants revoke <id> --dry-run; use account consent-revoke or nhi-session revoke for their own scopes',
      },
      {
        effect: 'register',
        path: 'Request and apply a new grant, personal consent, or session admission through its original approval flow.',
      },
    ],
    check: 'Inspect the issued record. Revoking an admission does not verify process exit.',
  },
  {
    id: 'credentials',
    title: 'Secret, account and reasoning credentials',
    use_when:
      'Check which credential is registered, connect an account, or replace an expired provider key.',
    inspection_commands: [
      'pnpm kyberion secret status <service>',
      'pnpm kyberion account status <binding-id> --approval-id <approval-id>',
      'pnpm kyberion reasoning credentials status --provider <provider>',
    ],
    inspection_note:
      'Use the operator scope for the provider credential inventory. For tenant work, use the approved task binding and inspect its allocation with reasoning credentials check. If status reports unavailable, confirm the scope and provider before considering registration.',
    related_domains: ['tenant', 'access', 'runtime', 'model'],
    actions: [
      {
        effect: 'register',
        path: 'Use secret introduce, account preview/request/apply, or reasoning credentials register for the matching credential.',
      },
      {
        effect: 'change',
        path: 'For an external provider key, use the provider’s rotation or revocation operation.',
      },
    ],
    check:
      'Use account status or reasoning credentials verify. Secret presence alone does not establish provider validity.',
  },
  {
    id: 'runtime',
    title: 'External service, reasoning and tool runtimes',
    use_when:
      'Connect a service, choose a reasoning backend, or install a managed tool needed for a task.',
    inspection_commands: [
      'pnpm kyberion service setup',
      'pnpm kyberion tool setup --list',
      'pnpm kyberion service preflight --help',
    ],
    actions: [
      {
        effect: 'register',
        path: 'Follow the service authentication instructions, use reasoning setup for backend selection, and use tool setup --tool <id> --apply for managed tools.',
      },
    ],
    check:
      'Repeat the relevant setup or status check. Installation, selection, and provider authentication have separate results.',
  },
  {
    id: 'model',
    title: 'Reasoning model and role selection',
    use_when:
      'Find which model a role uses, preview a model change, or restore the previous selection.',
    inspection_commands: [
      'pnpm kyberion reasoning config list --json',
      'pnpm kyberion reasoning config explain --role <role> --json',
      'pnpm kyberion reasoning config preview --role <role> --mode fixed --runtime <runtime> --model <model>',
    ],
    inspection_note:
      'Use reasoning config for role-based routing in operation. For the onboarding selection, use pnpm onboarding llm show and specify --tenant <tenant-slug> for tenant scope.',
    related_domains: ['runtime', 'credentials', 'media'],
    actions: [
      {
        effect: 'change',
        path: 'Use reasoning config select-role with the reviewed settings and --expected-revision; preview rollback with reasoning config rollback --dry-run before restoring a prior revision.',
      },
      {
        effect: 'change',
        path: 'For the onboarding selection, run pnpm onboarding llm select with the reviewed backend, model and scope. Review the preview before adding --apply.',
      },
    ],
    check:
      'Recheck the effective role route or onboarding selection. Use the runtime guide to verify backend readiness.',
  },
  {
    id: 'actuator',
    title: 'Actuator discovery and execution',
    use_when: 'Find a capability for a job, inspect its input contract, or reuse it in a pipeline.',
    inspection_commands: [
      'pnpm kyberion search <keyword>',
      'pnpm kyberion info <actuator>',
      'pnpm kyberion examples <actuator>',
    ],
    inspection_note:
      'Search by the job first. Review the operation and its input before choosing a single actuator run or a reusable pipeline.',
    actions: [
      {
        effect: 'change',
        path: 'For an apply operation, validate its reviewed input with pnpm kyberion run <actuator> --input <file> --dry-run before executing it through the authorized work route. Capture operations still run on dry-run.',
      },
    ],
    check: 'Review the operation result and its artifacts against the requested outcome.',
  },
  {
    id: 'media',
    title: 'Provider defaults for supported capabilities',
    use_when:
      'See available providers for image generation or another capability, or set its default.',
    inspection_commands: [
      'pnpm kyberion seam select list',
      'pnpm kyberion seam select defaults list',
    ],
    actions: [
      {
        effect: 'change',
        path: 'Use seam select defaults set after reviewing candidates. Use defaults unset to return to policy-based selection.',
      },
      {
        effect: 'register',
        path: 'Re-establish the selected backend’s service connection or install its runtime before selecting it again.',
      },
    ],
    check:
      'Check the selected backend and its dependencies separately. A saved default does not establish availability.',
  },
  {
    id: 'plugin',
    title: 'Managed plugins',
    use_when:
      'Install a plugin, check whether its approval is pending, or change activation in a host process.',
    inspection_commands: ['pnpm kyberion approvals'],
    actions: [
      {
        effect: 'register',
        path: 'pnpm plugin:install --source <path> --id <id>; complete any resulting activation approval',
      },
      {
        effect: 'change',
        path: 'Use --reload or --deactivate in the process that owns the activation.',
      },
    ],
    check:
      'Confirm each host separately. Process-local deactivation is temporary and may require a restart.',
  },
  {
    id: 'surface',
    title: 'Surface and resident daemon',
    use_when: 'Check why a UI or background process is unavailable, or bring it back online.',
    inspection_commands: ['pnpm surfaces status', 'pnpm kyberion scheduler status --daemon <id>'],
    related_domains: ['conversation', 'discussion', 'audit', 'recovery'],
    actions: [
      {
        effect: 'resume',
        path: 'pnpm surfaces enable --surface <id> or start a stopped surface; use scheduler start --daemon <id> --apply for a stopped daemon',
      },
      {
        effect: 'register',
        path: 'Use scheduler reconcile, then scheduler reconcile --apply to register desired units.',
      },
    ],
    check: 'Check process state and endpoint/workload health separately.',
  },
  {
    id: 'ingress',
    title: 'Public HTTPS ingress and Tailscale Funnel',
    use_when:
      'Receive a public webhook, check Tailscale Funnel readiness, or withdraw a public URL.',
    inspection_commands: [
      'pnpm kyberion ingress --help',
      'pnpm kyberion ingress probe',
      'pnpm kyberion tool setup --tool tailscale',
      'pnpm kyberion ingress status --surface <surface-id>',
    ],
    inspection_note:
      'Start with ingress probe for public HTTPS. A needs_setup result includes provider-specific next steps. Check the tool setup if the CLI is missing, or follow the provider guidance if its session or preferences are unavailable. Check the opted-in surface locally before requesting public access.',
    related_domains: ['runtime', 'surface'],
    actions: [
      {
        effect: 'register',
        path: 'For a healthy, opted-in surface, use pnpm kyberion ingress up --surface <surface-id> --provider <provider-id>. Review the approval request and rerun the same command after approval.',
      },
      {
        effect: 'change',
        path: 'Use pnpm kyberion ingress down --surface <surface-id> to withdraw the public route.',
      },
    ],
    check:
      'Use ingress status for that surface to confirm the resulting public mapping or its withdrawal.',
  },
  {
    id: 'schedule',
    title: 'Pipeline schedules',
    use_when: 'Find, add, or remove a recurring pipeline run.',
    inspection_commands: ['pnpm kyberion schedule list'],
    related_domains: ['calendar', 'meeting', 'recovery'],
    actions: [
      { effect: 'change', path: 'pnpm kyberion schedule remove <id>' },
      {
        effect: 'register',
        path: 'pnpm kyberion schedule register <id> <pipeline-path> <actuator> "<cron>"',
      },
    ],
    check:
      'Inspect the registry after registering. Reconcile can recreate an entry whose ADF definition still declares it.',
  },
  {
    id: 'dot',
    title: 'Dot and autonomous operation',
    use_when: 'See why a Dot is paused, resume its charter, or check the global halt.',
    inspection_commands: ['pnpm kyberion dot status <id> --json', 'pnpm kyberion halt status'],
    actions: [
      {
        effect: 'resume',
        path: 'Use dot activate for a paused dot with its transition_expectations; use halt resume for a global halt.',
      },
      { effect: 'terminal', path: 'dot retire is permanent for that charter.' },
    ],
    check: 'Read back the charter or halt state.',
  },
  {
    id: 'customer',
    title: 'Customer channel and decision',
    use_when:
      'Find a customer conversation channel, reconnect it, or follow up on an unanswered decision.',
    inspection_commands: [
      'pnpm kyberion customer-channel list --tenant <tenant-slug>',
      'pnpm kyberion customer-decision overview --tenant <tenant-slug> --case <case-id> --detail',
    ],
    related_domains: ['discussion', 'channel'],
    actions: [
      {
        effect: 'change',
        path: 'Run customer-channel preview-unbind, then pass its review token to unbind.',
      },
      { effect: 'resume', path: 'Use customer-channel bind to reactivate the same channel.' },
      {
        effect: 'register',
        path: 'For an eligible unresolved question, use customer-decision draft --from-tasks --reask.',
      },
    ],
    check: 'Use list or overview to read back state. Decision status also attempts recovery.',
  },
  {
    id: 'pipeline',
    title: 'Pipeline execution and acceptance',
    use_when: 'Run a repeatable workflow or recover an unfinished pipeline acceptance.',
    inspection_commands: [
      'pnpm kyberion pipeline accept --pipeline <path> --intent <intent-id> --run-id <run-id> --tier <tier> --approval-id <approval-id> --status',
      'pnpm pipeline --help',
      'pnpm kyberion examples <actuator>',
    ],
    related_domains: ['actuator', 'schedule', 'mission', 'task', 'recovery'],
    actions: [
      {
        effect: 'resume',
        path: 'If pipeline acceptance reports receipt_pending, retry with the same inputs and approval ID, including any --tenant, --organization or --project options.',
      },
    ],
    check:
      'Recheck the run outcome and acceptance receipt. A retired pipeline binding has no reactivation command.',
  },
  {
    id: 'mission',
    title: 'Mission planning, execution and completion',
    use_when: 'Start a mission with a goal, recover its next step, or verify and close its result.',
    inspection_commands: [
      'pnpm kyberion mission list',
      'pnpm kyberion mission status <mission-id> --json',
      'pnpm mission triage <mission-id>',
    ],
    inspection_note:
      'For new work, review the intended scope, goal and success condition with mission --help before kickoff. For an existing mission, start with status and use triage for recovery.',
    related_domains: [
      'objectives',
      'project',
      'track',
      'workitem',
      'pipeline',
      'artifact',
      'approval',
      'knowledge',
    ],
    actions: [
      {
        effect: 'register',
        path: 'Use mission kickoff with the reviewed scope, mission type, goal and success condition.',
      },
      {
        effect: 'change',
        path: 'Use the next command from mission triage to resume, verify, distill, finish or abandon as applicable.',
      },
    ],
    check: 'Review mission status and its delivery evidence against the success condition.',
  },
  {
    id: 'workitem',
    title: 'WorkItem ownership and handoff',
    use_when: 'Find assigned work, recover its context, claim an available item, or hand it off.',
    inspection_commands: [
      'pnpm onboarding:context show --customer-slug <customer-slug> --json',
      'pnpm kyberion work list-items --tenant-slug <tenant-slug> --top-level',
      'pnpm kyberion work session-summary --item-id <item-id> --tenant-slug <tenant-slug> --json',
      'pnpm kyberion work --help',
    ],
    inspection_note:
      'Check the customer binding first. If it is absent, open the tenant guide to preview the bind and verify the tenant context. Run the summary from the matching authorized execution context. The tenant flag cross-checks that context.',
    related_domains: ['tenant', 'project', 'task', 'mission', 'artifact', 'workspace'],
    actions: [
      {
        effect: 'register',
        path: 'Use work create-item with the reviewed project context to add backlog work. Use --dependencies to record prerequisite WorkItem IDs.',
      },
      {
        effect: 'change',
        path: 'Use work claim-item for available work. The current holder uses work handoff-item with the current lease and receiving peer, or work release-item to give up the lease.',
      },
    ],
    check:
      'Check the returned lease and read the item again to confirm ownership, status, and linked work.',
  },
  {
    id: 'artifact',
    title: 'Artifacts, evidence and delivery',
    use_when:
      'Find a deliverable, check what proves the result, or confirm review and delivery status.',
    inspection_commands: [
      'pnpm project show <project-id> --json',
      'pnpm kyberion work session-summary --item-id <item-id> --json',
      'pnpm kyberion mission status <mission-id> --json',
      'pnpm kyberion artifact <artifact-path>',
    ],
    inspection_note:
      'Open Deliverables in the Concierge Library, inspect artifacts in project show, or start from the owning work. The WorkItem summary can list mission artifacts when the item is linked to a mission in the bound tenant. For a required artifact, start from the Track gate.',
    related_domains: [
      'track',
      'project',
      'mission',
      'workitem',
      'operations',
      'channel',
      'knowledge',
    ],
    actions: [
      {
        effect: 'change',
        path: 'Produce the deliverable through the owning workflow and use its scoped publication or delivery action when distribution is required.',
      },
    ],
    check: 'Check the artifact, review verdict, and required delivery receipt separately.',
  },
  {
    id: 'task',
    title: 'Task sessions and repeatable scenarios',
    use_when: 'Choose a bounded task session or find and preview a repeatable TaskScenario.',
    inspection_commands: ['pnpm kyberion task --help', 'pnpm kyberion task scenario list'],
    inspection_note:
      'Use a task session for bounded work that needs conversational context. For an existing session, use the session ID and the continuation from its originating surface. For repeatable work, start with the scenario catalog.',
    related_domains: ['workitem', 'mission', 'pipeline', 'conversation'],
    actions: [
      {
        effect: 'change',
        path: 'Use task plan to review a new bounded task and task scenario run <scenario-id> --dry-run to preview a registered scenario.',
      },
    ],
    check: 'Review the session or scenario result, remaining inputs, and any required approval.',
  },
  {
    id: 'knowledge',
    title: 'Knowledge ingestion, retrieval and learning',
    use_when:
      'Find how to ingest scoped knowledge, reuse it, or provide feedback and promote learning.',
    inspection_commands: [
      'pnpm kyberion knowledge scope-health --json',
      'pnpm kyberion knowledge ingest --help',
      'pnpm kyberion knowledge feedback --help',
    ],
    inspection_note:
      'Start by confirming the intended tenant, tier and source. Use the source-specific ingest workflow and look up the resulting knowledge in that same scope.',
    related_domains: ['tenant', 'artifact', 'mission'],
    actions: [
      {
        effect: 'change',
        path: 'Use knowledge ingest for a reviewed source and the existing feedback or curation workflow to improve reusable knowledge.',
      },
    ],
    check:
      'Check the resulting knowledge reference, its visibility, and any review required for promotion.',
  },
  {
    id: 'approval',
    title: 'Approvals and decision gates',
    use_when:
      'Find pending approval requests, review their scope, or inspect a mission gate before deciding.',
    inspection_commands: [
      'pnpm kyberion approvals',
      'pnpm mission gate-pass <mission-id> <gate-id> --dry-run --json',
    ],
    inspection_note:
      'Start with the approval queue for a pending request. Use the mission gate preview when deciding what a mission needs to advance.',
    related_domains: ['access', 'mission', 'track', 'operations'],
    actions: [
      {
        effect: 'change',
        path: 'Use the reviewed approval ID in the owning workflow after a human decision. Review the exact scope and effect before approving or denying.',
      },
    ],
    check: 'Confirm the decision and recheck the affected workflow or gate.',
  },
  {
    id: 'channel',
    title: 'Channels, inbox and notifications',
    use_when:
      'Find a connected channel, check unread inbox items, or choose a notification destination.',
    inspection_commands: [
      'pnpm kyberion channels list',
      'pnpm kyberion inbox',
      'pnpm kyberion notify',
    ],
    inspection_note:
      'Use the channel directory to find available connections and the inbox for received updates. Review the destination before changing notification preferences.',
    related_domains: ['runtime', 'customer', 'email', 'artifact', 'conversation'],
    actions: [
      {
        effect: 'change',
        path: 'Use notify --set <surface:target> to set a reviewed destination, or use the owning channel workflow for delivery.',
      },
    ],
    check: 'Recheck the notification preference or the owning workflow’s delivery receipt.',
  },
  {
    id: 'conversation',
    title: 'Conversations with Kyberion',
    use_when:
      'Talk with Kyberion, choose a chat surface, or find where to continue a conversation.',
    inspection_commands: [
      'pnpm surfaces status',
      'pnpm kyberion channels list',
      'pnpm kyberion chat local --help',
    ],
    inspection_note:
      'Choose who you want to speak with. Use ask or Presence Studio for Kyberion, a connected chat bridge for a team channel, and agent coordination for another Kyberion runtime. Continue on the original surface or thread when it retains conversation context.',
    related_domains: ['channel', 'voice', 'coordination', 'discussion', 'task'],
    actions: [
      {
        effect: 'change',
        path: 'Ask in the chosen surface. For interactive chat with a local model, review the configured local runtime before using chat local.',
      },
    ],
    check:
      'Check the conversation surface and thread, and confirm the intended workspace or channel before continuing.',
  },
  {
    id: 'discussion',
    title: 'Dialogue and multi-agent discussion',
    use_when:
      'Discuss a goal with Kyberion, compare viewpoints with multiple agents, or turn a discussion into a decision brief.',
    inspection_commands: ['pnpm surfaces status'],
    inspection_note:
      'Open Concierge /ops?section=discussion. Choose Dialogue Room to clarify a goal together, or Discussion Room to gather agent perspectives. Use the customer guide for a customer decision channel.',
    related_domains: ['conversation', 'customer', 'approval', 'workitem', 'mission'],
    actions: [
      {
        effect: 'change',
        path: 'Review the resulting brief and required approval before creating tasks or starting a mission.',
      },
    ],
    check: 'Check the recorded goal, decision or open questions and the approved follow-up.',
  },
  {
    id: 'coordination',
    title: 'Agent coordination and conversation sessions',
    use_when:
      'Coordinate provider CLIs in one checkout or open, continue, or close a conversation between distinct Kyberion runtimes.',
    inspection_commands: [
      'pnpm kyberion co-session status',
      'pnpm kyberion peer conversation --help',
      'pnpm kyberion peer conversation list-sessions --peer-id <peer-id> --tenant-id <tenant-id>',
    ],
    inspection_note:
      'Use Co-Session for provider CLIs sharing one checkout. Use Peer Conversation for distinct Kyberion runtimes, even on one host. Check tenant enrollment and the recipient before sending.',
    related_domains: ['peer', 'workitem', 'mission', 'conversation'],
    actions: [
      {
        effect: 'change',
        path: 'Use co-session start if the checkout has no session. Use join or leave for participation. For enrolled peers, use peer conversation open-session, send-message, and close-session with the reviewed IDs.',
      },
    ],
    check:
      'Read back presence or session state. For assigned work, confirm WorkItem ownership separately.',
  },
  {
    id: 'meeting',
    title: 'Meeting participation and follow-up',
    use_when:
      'Prepare for delegated attendance, check consent, or find the transcript, minutes and follow-up tasks.',
    inspection_commands: [
      'pnpm kyberion meeting preflight --mission <mission-id> --json',
      'pnpm meeting:consent status --mission <mission-id>',
      'pnpm kyberion meeting participate --help',
      'pnpm kyberion mission status <mission-id> --json',
    ],
    inspection_note:
      'Review role, scope, consent and devices before joining. For a completed meeting, start with its mission and linked evidence or deliverables.',
    related_domains: ['voice', 'calendar', 'approval', 'mission', 'artifact', 'workitem'],
    actions: [
      {
        effect: 'change',
        path: 'Use the governed meeting participation workflow with the agreed role and explicit scope. Review captured notes and proposed follow-up before sending or assigning them.',
      },
    ],
    check: 'Check participation evidence, approved minutes, and each follow-up owner or due date.',
  },
  {
    id: 'calendar',
    title: 'Workspace calendar and connected schedules',
    use_when:
      'See dated WorkItems, meeting action items and milestones together, or check a connected calendar.',
    inspection_commands: ['pnpm kyberion calendar status'],
    inspection_note:
      'Open the Calendar tab on Concierge Work (/work) for work dates. Use calendar status for provider readiness. Provider agenda reads require the authorized task context and credentials.',
    related_domains: ['workitem', 'schedule', 'meeting', 'channel'],
    actions: [
      {
        effect: 'change',
        path: 'Use the governed calendar workflow to prepare an event and review its approval before creation.',
      },
    ],
    check: 'Check the source of each date and any provider result.',
  },
  {
    id: 'audit',
    title: 'Operations activity and audit evidence',
    use_when: 'See who is doing work, review runtime activity, or verify the audit chain.',
    inspection_commands: [
      'pnpm kyberion audit verify',
      'pnpm kyberion mission journal --help',
      'pnpm kyberion work list-items --tenant-slug <tenant-slug> --top-level',
    ],
    inspection_note:
      'Open Concierge /ops for operator activity. Use the authorized tenant or project scope for ownership checks, and the audit command to verify ledger integrity.',
    related_domains: ['operations', 'workitem', 'mission', 'surface', 'approval'],
    actions: [
      {
        effect: 'change',
        path: 'Use the governing workflow to investigate a specific finding before applying a change.',
      },
    ],
    check: 'Check the actor, scope, event and evidence together.',
  },
  {
    id: 'recovery',
    title: 'Pause and recovery',
    use_when:
      'Find how to recover interrupted work, resume a paused workflow, or diagnose a global halt.',
    inspection_commands: [
      'pnpm kyberion halt status',
      'pnpm mission triage <mission-id>',
      'pnpm surfaces status',
    ],
    inspection_note:
      'Identify what stopped before resuming. For a mission use triage, for a paused track use the track guide, and for a global halt follow the halt status and authority guidance.',
    related_domains: ['mission', 'track', 'surface', 'backup', 'dot', 'workspace'],
    actions: [
      {
        effect: 'change',
        path: 'Follow the reviewed recovery action for the affected scope. Use the backup drill guide to rehearse recovery from data loss.',
      },
    ],
    check: 'Recheck the affected state and unfinished work after recovery.',
  },
  {
    id: 'release',
    title: 'Release notes and release checks',
    use_when:
      'Find repository release notes, prepare a changelog draft, or validate an install before release.',
    inspection_commands: [
      'pnpm kyberion release notes --help',
      'pnpm kyberion release changelog-draft --help',
      'pnpm kyberion release install-smoke --help',
    ],
    inspection_note:
      'Use the release commands for repository packaging and release notes. Use the track guide for a managed project’s release gate and its required artifacts.',
    related_domains: ['track', 'artifact', 'project'],
    actions: [
      {
        effect: 'change',
        path: 'Review the release notes and changelog for the intended version and use the install smoke workflow before publication.',
      },
    ],
    check: 'Check the version, release artifacts and smoke result against the intended release.',
  },
  {
    id: 'email',
    title: 'Email drafts and delivery',
    use_when: 'Preview a new email or reply, save a draft for review, or send with approval.',
    inspection_commands: [
      'pnpm kyberion email status',
      'pnpm kyberion email deliver --dry-run --draft-mode --body-file <reviewed-body>',
      'pnpm kyberion email deliver --dry-run --reply-mode reply --message-id <message-id> --body-file <reviewed-body>',
    ],
    inspection_note:
      'If email status reports needs_setup, follow the service connection and account guidance before creating a provider draft or sending. The local dry-run remains available for checking the requested delivery.',
    related_domains: ['runtime', 'credentials'],
    actions: [
      {
        effect: 'change',
        path: 'Use email deliver --draft-mode for a draft. Review the sending account and recipients and obtain approval before live delivery.',
      },
    ],
    check:
      'Review the provider result or draft artifact. A dry run does not resolve final recipients. Sent email has no rollback through this CLI.',
  },
  {
    id: 'backup',
    title: 'Backups and restore drills',
    use_when:
      'Protect current data, rehearse recovery in a disposable checkout, or recover from an incident.',
    inspection_commands: ['pnpm backup list', 'pnpm kyberion secret status kyberion-backup'],
    actions: [
      {
        effect: 'register',
        path: 'Use pnpm backup create --encrypt after configuring its passphrase in a protected store.',
      },
      {
        effect: 'change',
        path: 'Run pnpm backup drill --prepare-checkout --verify-baseline to rehearse recovery and check startup readiness in a disposable checkout.',
      },
      {
        effect: 'change',
        path: 'For incident recovery, use pnpm backup restore <archive> --target <clean-root> and declare the tenant scope when applicable.',
      },
    ],
    check:
      'Check the drill receipt for archive extraction and credential-member checks. When --verify-baseline is requested, check the separate Baseline verdict.',
  },
  {
    id: 'workspace',
    title: 'Workspace inspection and cleanup',
    use_when:
      'Find a workspace for assigned work, check its ownership, or preview cleanup of registered orphans.',
    inspection_commands: [
      'pnpm kyberion workspace list',
      'pnpm kyberion workspace gc --dry-run --json',
      'pnpm kyberion workspace gc --dry-run --only <workspace-id> --json',
    ],
    inspection_note:
      'To start or resume work, open its context with pnpm kyberion work session-summary --item-id <item-id> --json in the bound tenant, or use pnpm mission triage <mission-id>. Continue through the execution or dispatch route that owns the workspace. For cleanup, list registrations and preview GC before selecting an entry.',
    actions: [
      {
        effect: 'terminal',
        path: 'After reviewing the orphan list, use pnpm kyberion workspace gc --apply --only <workspace-id> for the selected eligible workspace.',
      },
    ],
    check:
      'Read the deleted IDs and errors, then list again. Unregistered directories are outside the cleanup scope.',
  },
  {
    id: 'voice',
    title: 'Voice runtimes and OS permissions',
    use_when:
      'Set up voice for the first time, troubleshoot the microphone, or check consent before recording.',
    inspection_commands: [
      'pnpm kyberion voice setup --json',
      'pnpm kyberion permissions status --json',
      'pnpm meeting:consent status --mission <mission-id>',
    ],
    inspection_note:
      'For first-time setup, start with voice setup. For microphone access, start with permissions status. Before meeting capture, check consent for the mission.',
    related_domains: ['conversation', 'meeting'],
    actions: [
      {
        effect: 'register',
        path: 'Use pnpm kyberion voice setup --apply --tool <tool-id> for a supported missing runtime. On macOS, use pnpm kyberion permissions warmup --only microphone to request microphone access.',
      },
      {
        effect: 'change',
        path: 'Use meeting:consent revoke --mission <mission-id> to withdraw mission consent. Change OS permissions separately in the host settings.',
      },
    ],
    check:
      'Use pnpm pipeline voice-health-check to check the runtime. Confirm OS permission and mission consent separately.',
  },
  {
    id: 'peer',
    title: 'Peer runtime',
    use_when:
      'Find a tenant peer, inspect its Mesh routes, or register or reconfigure its runtime.',
    inspection_commands: [
      'pnpm kyberion mesh-hub inspect peers --tenant-id <tenant-id>',
      'pnpm kyberion mesh-hub inspect routes --tenant-id <tenant-id>',
      'pnpm kyberion peer register --help',
    ],
    inspection_note:
      'Inspect the authorized tenant and its Mesh namespace for enrolled peers and recent routing decisions. For bootstrap registration, use the tenant and peer ID from its registration receipt.',
    related_domains: ['tenant', 'runtime', 'workitem', 'coordination'],
    actions: [
      {
        effect: 'register',
        path: 'Use pnpm kyberion peer register to replace the configuration for the same peer ID.',
      },
    ],
    check:
      'Review the registration receipt for the tenant and peer ID. Use the Mesh view after enrollment and confirm live connectivity separately.',
  },
  {
    id: 'offboard',
    title: 'Scope offboarding',
    use_when: 'Retire a tenant or project and review the export and deletion plan before approval.',
    related_domains: ['tenant', 'project'],
    inspection_commands: [
      'pnpm kyberion offboard tenant <tenant-slug> --json',
      'pnpm kyberion offboard project <project-id> --tenant-slug <tenant-slug> --organization-id <org-id> --json',
    ],
    actions: [
      {
        effect: 'terminal',
        path: 'Review the export and deletion plan. After approval, repeat the same scope with --execute --preview-id <preview-id> --approved-by <operator-id> --purpose "<reason>".',
      },
    ],
    check:
      'Review the offboarding receipt. There is no whole-scope restore command for data, identities and grants.',
  },
];

export const setupLifecycleDomains = routes.map(({ id }) => id);

export function buildSetupLifecycleGuide(domain?: string, summary = false) {
  const selected = routes.filter(({ id }) => !domain || id === domain);
  return {
    mode: 'reference',
    verification: 'not_run',
    summary,
    routes: selected.map((route) => ({
      ...route,
      guide_command: `${SETUP_LIFECYCLE_COMMAND} --domain ${route.id}`,
      related_guides: (route.related_domains ?? []).map((id) => ({
        id,
        guide_command: `${SETUP_LIFECYCLE_COMMAND} --domain ${id}`,
      })),
      inspect: route.inspection_commands.join('; ') || route.inspection_note || '',
    })),
  } as const;
}

export function formatSetupLifecycleGuide(
  guide: ReturnType<typeof buildSetupLifecycleGuide>
): string {
  return [
    guide.summary
      ? 'Lifecycle areas (reference only. No checks run.)'
      : 'Lifecycle guide (reference only. Replace <placeholders> with your values.)',
    ...guide.routes.flatMap(
      ({
        id,
        title,
        use_when,
        inspection_commands,
        inspection_note,
        actions,
        check,
        related_guides,
      }) =>
        guide.summary
          ? [`  ${id.padEnd(14)} ${use_when}`]
          : [
              '',
              `${title} [${id}]`,
              `  When to use: ${use_when}`,
              ...(inspection_note ? [`  Start here: ${inspection_note}`] : []),
              ...inspection_commands.map((command) => `  Inspect: ${command}`),
              ...actions.map(({ effect, path }) => `  ${effect}: ${path}`),
              `  Verify: ${check}`,
              ...related_guides.map(
                ({ id, guide_command }) => `  Related (${id}): ${guide_command}`
              ),
            ]
    ),
    '',
    `Show one area with ${SETUP_LIFECYCLE_COMMAND} --domain <id>`,
  ].join('\n');
}
