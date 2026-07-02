import { pathResolver } from './path-resolver.js';
import { secretGuard } from './secret-guard.js';
import { loadSurfaceManifest, loadSurfaceState } from './surface-runtime.js';
import { getServicePresetPolicy } from './service-preset-policy.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { listSurfaceAsyncRequests, listSurfaceNotifications } from './surface-coordination-store.js';
import { listSurfaceProviderManifests } from './surface-provider-manifest.js';
import { buildNextAction } from './next-action.js';

export interface SurfaceDirectoryRow {
  id: string;
  kind: string;
  description: string;
  enabled: boolean;
  runtime_status: 'running' | 'stale' | 'stopped';
  startup_mode: string;
  authority_role: string;
  auth_requirement: 'required' | 'session_or_oauth' | 'host-managed';
  auth_strategy: string;
  auth_status: 'ready' | 'missing' | 'n/a';
  required_secrets: string[];
  use_cases: string[];
  operator_notes: string;
  next_command: string;
  best_for: string;
  blocked_by: string[];
}

export interface SurfaceScenarioGuide {
  id: string;
  title: string;
  summary: string;
  surface_ids: string[];
  guidance: string;
}

export interface SurfaceDirectorySummary {
  total: number;
  enabled: number;
  auth_required: number;
  auth_missing: number;
  running: number;
  stale: number;
  blocked: number;
}

export interface SurfaceRecoveryAction {
  reason: string;
  next_step?: string;
  command?: string;
  fallback?: string;
}

export interface SurfaceLauncherRecommendation {
  id: 'chronos' | 'voice-first-win' | 'messaging';
  title: string;
  whenToUse: string;
  surfaces: string[];
  readiness: 'ready' | 'needs_setup' | 'unavailable';
  reason: string;
  suggestedCommand: string;
}

export interface SurfaceDoctorSummary {
  manifestId: string;
  counts: { must: number; should: number; nice: number };
}

function readJsonSafe<T>(absPath: string): T | null {
  try {
    if (!safeExistsSync(absPath)) return null;
    return JSON.parse(safeReadFile(absPath, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function surfaceScenarioIds(surfaceId: string): string[] {
  const ids = new Set<string>();
  if (['presence-studio', 'voice-hub'].includes(surfaceId)) ids.add('voice-first-win');
  if (['slack-bridge', 'imessage-bridge', 'telegram-bridge', 'discord-bridge'].includes(surfaceId)) ids.add('messaging-ingress');
  if (['chronos-mirror-v2', 'terminal-bridge', 'computer-surface'].includes(surfaceId)) ids.add('operator-control');
  if (surfaceId === 'oauth-callback-surface') ids.add('oauth-bootstrap');
  if (surfaceId === 'mcp-server-cowork') ids.add('desktop-cowork');
  if (['chronos-mirror-v2', 'slack-bridge', 'oauth-callback-surface'].includes(surfaceId)) ids.add('customer-engagement');
  return [...ids];
}

function surfaceOperatorNotes(surfaceId: string): string {
  switch (surfaceId) {
    case 'slack-bridge':
      return 'External channel ingress. Auth readiness matters before runtime repair.';
    case 'oauth-callback-surface':
      return 'Loopback-only helper for completing OAuth handshakes into personal connections.';
    case 'chronos-mirror-v2':
      return 'Primary operator control UI for mission and runtime visibility.';
    case 'presence-studio':
      return 'Best suited for expressive voice / transcript feedback during first-win demos.';
    case 'voice-hub':
      return 'Pairs with Presence Studio. Browser and OS permissions usually fail before the runtime itself.';
    case 'computer-surface':
      return 'Use for governed browser or terminal walkthroughs after runtime is already healthy.';
    case 'terminal-bridge':
      return 'Background bridge. Operators usually feel breakage here indirectly through control surfaces.';
    case 'mcp-server-cowork':
      return 'Desktop integration surface. Good fit when the operator already lives in an MCP client.';
    default:
      return 'Managed runtime surface exposed through the surface manifest catalog.';
  }
}

function surfaceBestFor(surfaceId: string): string {
  switch (surfaceId) {
    case 'presence-studio':
      return 'short conversation, transcript feedback, first-run launcher';
    case 'voice-hub':
      return 'realtime voice ingress and spoken replies';
    case 'chronos-mirror-v2':
      return 'durable work, mission visibility, and runtime control';
    case 'slack-bridge':
      return 'threaded remote requests and follow-up';
    case 'computer-surface':
      return 'guided browser and terminal walkthroughs';
    case 'oauth-callback-surface':
      return 'interactive OAuth callback completion';
    case 'mcp-server-cowork':
      return 'desktop MCP integration';
    default:
      return 'managed runtime access';
  }
}

function surfaceNextCommand(row: Pick<SurfaceDirectoryRow, 'auth_requirement' | 'auth_status' | 'runtime_status' | 'id'>): string {
  if (row.auth_requirement !== 'host-managed' && row.auth_status === 'missing') {
    return 'pnpm surfaces:setup';
  }
  if (row.runtime_status === 'stale') {
    return `pnpm surfaces:repair -- --surface ${row.id}`;
  }
  if (row.runtime_status === 'stopped') {
    return `pnpm surfaces:start --surface ${row.id}`;
  }
  return `pnpm surfaces:status -- --surface ${row.id}`;
}

function loadAuthorityRoleIndex(): Record<string, any> {
  const payload = readJsonSafe<{ authority_roles?: Record<string, any> }>(
    pathResolver.rootResolve('knowledge/product/governance/authority-role-index.json'),
  );
  return payload?.authority_roles || {};
}

function loadServiceEndpointCatalog(): Record<string, any> {
  const payload = readJsonSafe<{ services?: Record<string, any> }>(
    pathResolver.rootResolve('knowledge/product/orchestration/service-endpoints.json'),
  );
  return payload?.services || {};
}

function inspectSurfaceAuthReadOnly(definition: Record<string, any>): Pick<
  SurfaceDirectoryRow,
  'auth_requirement' | 'auth_strategy' | 'auth_status' | 'required_secrets'
> {
  const presetPath = typeof definition.preset_path === 'string' ? definition.preset_path : '';
  if (!presetPath) {
    return {
      auth_requirement: 'host-managed',
      auth_strategy: 'host-managed',
      auth_status: 'n/a',
      required_secrets: [],
    };
  }

  const resolvedPresetPath = pathResolver.rootResolve(presetPath);
  const preset = readJsonSafe<Record<string, any>>(resolvedPresetPath);
  const policy = getServicePresetPolicy(preset);
  const strategy = (policy.auth_strategy || 'none').toLowerCase();
  const serviceId = typeof definition.service_id === 'string' ? definition.service_id : String(definition.id || '');
  const endpoint = loadServiceEndpointCatalog()[serviceId];
  const suffixes = endpoint?.credential_suffixes || {};
  const requiredSecrets = Array.from(new Set(
    strategy === 'bearer'
      ? [...(suffixes.accessToken || ['ACCESS_TOKEN', 'BOT_TOKEN', 'TOKEN'])]
      : strategy === 'basic'
        ? [
            ...(suffixes.clientId || ['CLIENT_ID']),
            ...(suffixes.clientSecret || ['CLIENT_SECRET']),
            ...(suffixes.accessToken || ['ACCESS_TOKEN']),
          ]
        : strategy === 'session'
          ? [
              ...(suffixes.clientId || ['CLIENT_ID']),
              ...(suffixes.clientSecret || ['CLIENT_SECRET']),
              ...(suffixes.redirectUri || ['REDIRECT_URI']),
            ]
          : []
  )).map((suffix) => `${serviceId.toUpperCase()}_${suffix}`);
  const hasAnySecret = requiredSecrets.some((envName) => Boolean(secretGuard.getSecret(envName)));

  if (strategy === 'session') {
    return {
      auth_requirement: 'session_or_oauth',
      auth_strategy: strategy,
      auth_status: hasAnySecret ? 'ready' : 'missing',
      required_secrets: requiredSecrets,
    };
  }

  if (strategy === 'none') {
    return {
      auth_requirement: 'host-managed',
      auth_strategy: strategy,
      auth_status: 'n/a',
      required_secrets: [],
    };
  }

  return {
    auth_requirement: 'required',
    auth_strategy: strategy,
    auth_status: hasAnySecret ? 'ready' : 'missing',
    required_secrets: requiredSecrets,
  };
}

function detectBlockedBy(row: Pick<SurfaceDirectoryRow, 'enabled' | 'auth_status' | 'runtime_status'>): string[] {
  const blocked: string[] = [];
  if (!row.enabled) blocked.push('disabled');
  if (row.auth_status === 'missing') blocked.push('auth');
  if (row.runtime_status === 'stale') blocked.push('runtime_stale');
  if (row.runtime_status === 'stopped') blocked.push('runtime_stopped');
  return blocked;
}

export function getSurfaceDirectory(): SurfaceDirectoryRow[] {
  const manifest = loadSurfaceManifest();
  const state = loadSurfaceState();
  const roles = loadAuthorityRoleIndex();

  return manifest.surfaces
    .map((definition) => {
      const record = state.surfaces[definition.id];
      const runtimeStatus: SurfaceDirectoryRow['runtime_status'] = record
        ? isProcessRunning(record.pid) ? 'running' : 'stale'
        : 'stopped';
      const auth = inspectSurfaceAuthReadOnly(definition as Record<string, any>);
      const authorityRole = String((definition as any).env?.MISSION_ROLE || 'surface_runtime');
      const authority = roles[authorityRole];
      const notes = authority?.description
        ? `${surfaceOperatorNotes(definition.id)} ${authority.description}`
        : surfaceOperatorNotes(definition.id);
      const row: SurfaceDirectoryRow = {
        id: definition.id,
        kind: definition.kind,
        description: definition.description,
        enabled: definition.enabled !== false,
        runtime_status: runtimeStatus,
        startup_mode: definition.startupMode || 'background',
        authority_role: authorityRole,
        auth_requirement: auth.auth_requirement,
        auth_strategy: auth.auth_strategy,
        auth_status: auth.auth_status,
        required_secrets: auth.required_secrets,
        use_cases: surfaceScenarioIds(definition.id),
        operator_notes: notes,
        next_command: '',
        best_for: surfaceBestFor(definition.id),
        blocked_by: [],
      };
      row.next_command = surfaceNextCommand(row);
      row.blocked_by = detectBlockedBy(row);
      return row;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function getSurfaceScenarioGuide(): SurfaceScenarioGuide[] {
  return [
    {
      id: 'voice-first-win',
      title: 'Voice first win',
      summary: 'Use when demonstrating the first conversational loop with transcript and audio feedback.',
      surface_ids: ['presence-studio', 'voice-hub'],
      guidance: 'Check browser and OS permissions before debugging runtime health. If the loop fails, treat permissions as the first suspect.',
    },
    {
      id: 'messaging-ingress',
      title: 'Messaging ingress',
      summary: 'Use when the operator wants natural-language requests to arrive through Slack or another message channel.',
      surface_ids: ['slack-bridge', 'imessage-bridge', 'telegram-bridge', 'discord-bridge'],
      guidance: 'Auth readiness comes before runtime repair. Start with pnpm surfaces:setup, then reconcile the specific bridge.',
    },
    {
      id: 'operator-control',
      title: 'Operator control',
      summary: 'Use for mission visibility, browser walkthroughs, and governed runtime supervision.',
      surface_ids: ['chronos-mirror-v2', 'terminal-bridge', 'computer-surface'],
      guidance: 'This is the default control path for browser-heavy or long-running work. Repair stale background bridges before blaming the UI.',
    },
    {
      id: 'oauth-bootstrap',
      title: 'OAuth bootstrap',
      summary: 'Use when a service integration needs an interactive callback to finish session-based auth.',
      surface_ids: ['oauth-callback-surface'],
      guidance: 'Keep this loopback helper available during onboarding and service setup. It is not the day-to-day operator UI.',
    },
    {
      id: 'customer-engagement',
      title: 'Customer engagement handoff',
      summary: 'Use when switching overlays and validating which surfaces are fit for the active customer engagement.',
      surface_ids: ['chronos-mirror-v2', 'slack-bridge', 'oauth-callback-surface'],
      guidance: 'After customer switch and doctor/onboard, confirm the operator UI, the target channel, and any auth helper needed for that engagement.',
    },
    {
      id: 'desktop-cowork',
      title: 'Desktop cowork',
      summary: 'Use when Kyberion should surface capabilities through an MCP-connected desktop client.',
      surface_ids: ['mcp-server-cowork'],
      guidance: 'Prefer this when the operator already works inside an MCP host and does not need a separate web surface.',
    },
  ];
}

export function getSurfaceDirectorySummary(): SurfaceDirectorySummary {
  const rows = getSurfaceDirectory();
  return rows.reduce<SurfaceDirectorySummary>((acc, row) => {
    acc.total += 1;
    if (row.enabled) acc.enabled += 1;
    if (row.auth_requirement !== 'host-managed') acc.auth_required += 1;
    if (row.auth_status === 'missing') acc.auth_missing += 1;
    if (row.runtime_status === 'running') acc.running += 1;
    if (row.runtime_status === 'stale') acc.stale += 1;
    if (row.blocked_by.length > 0) acc.blocked += 1;
    return acc;
  }, {
    total: 0,
    enabled: 0,
    auth_required: 0,
    auth_missing: 0,
    running: 0,
    stale: 0,
    blocked: 0,
  });
}

function findSurfaceRow(rows: SurfaceDirectoryRow[], surfaceId: string): SurfaceDirectoryRow | undefined {
  return rows.find((row) => row.id === surfaceId);
}

function summarizeSurfaceReadiness(rows: SurfaceDirectoryRow[], surfaceIds: string[]): 'ready' | 'needs_setup' | 'unavailable' {
  const matched = surfaceIds.map((surfaceId) => findSurfaceRow(rows, surfaceId)).filter(Boolean) as SurfaceDirectoryRow[];
  if (matched.length !== surfaceIds.length || matched.some((row) => !row.enabled)) {
    return 'unavailable';
  }
  if (matched.some((row) => row.blocked_by.length > 0)) {
    return 'needs_setup';
  }
  return 'ready';
}

export function buildSurfaceLauncherRecommendations(params: {
  rows?: SurfaceDirectoryRow[];
  doctorSummaries?: SurfaceDoctorSummary[];
} = {}): SurfaceLauncherRecommendation[] {
  const rows = params.rows || getSurfaceDirectory();
  const doctorByManifest = new Map((params.doctorSummaries || []).map((summary) => [summary.manifestId, summary]));
  const chronos = findSurfaceRow(rows, 'chronos-mirror-v2');
  const voiceRows = ['presence-studio', 'voice-hub'];
  const slack = findSurfaceRow(rows, 'slack-bridge');
  const meetingDoctor = doctorByManifest.get('meeting-participation-runtime');

  const chronosReadiness =
    !chronos || !chronos.enabled
      ? 'unavailable'
      : chronos.blocked_by.length > 0
        ? 'needs_setup'
        : 'ready';

  const voiceReadinessBase = summarizeSurfaceReadiness(rows, voiceRows);
  const voiceReadiness: SurfaceLauncherRecommendation['readiness'] =
    voiceReadinessBase === 'ready' && meetingDoctor && (meetingDoctor.counts.must + meetingDoctor.counts.should > 0)
      ? 'needs_setup'
      : voiceReadinessBase;

  const messagingReadiness =
    !slack || !slack.enabled
      ? 'unavailable'
      : slack.blocked_by.length > 0
        ? 'needs_setup'
        : 'ready';

  return [
    {
      id: 'chronos',
      title: 'Chronos control surface',
      whenToUse: 'Open this first when you want durable work, mission visibility, and runtime control.',
      surfaces: ['chronos-mirror-v2'],
      readiness: chronosReadiness,
      reason:
        chronosReadiness === 'ready'
          ? 'Chronos is enabled and not currently blocked by auth or runtime state.'
          : chronosReadiness === 'needs_setup'
            ? 'Chronos exists, but its runtime state still needs recovery before it should be the main entry point.'
            : 'Chronos is disabled or unavailable in the current manifest.',
      suggestedCommand:
        chronosReadiness === 'ready'
          ? 'pnpm chronos:dev'
          : chronosReadiness === 'needs_setup'
            ? chronos?.next_command || 'pnpm surfaces:reconcile'
            : 'pnpm surfaces:status',
    },
    {
      id: 'voice-first-win',
      title: 'Presence Studio + voice path',
      whenToUse: 'Use this when you want a short conversation loop with transcript and realtime voice feedback.',
      surfaces: voiceRows,
      readiness: voiceReadiness,
      reason:
        voiceReadiness === 'ready'
          ? 'Presence Studio and voice-hub are available, and doctor did not flag the meeting runtime.'
          : voiceReadiness === 'needs_setup'
            ? 'Voice surfaces exist, but auth, permissions, or meeting runtime checks still block the first voice win.'
            : 'One or more required voice surfaces are disabled or unavailable.',
      suggestedCommand:
        voiceReadiness === 'ready'
          ? 'pnpm pipeline --input pipelines/voice-hello.json'
          : 'pnpm doctor --runtime browser',
    },
    {
      id: 'messaging',
      title: 'Slack thread surface',
      whenToUse: 'Use this when requests should arrive and complete in a remote threaded channel.',
      surfaces: ['slack-bridge'],
      readiness: messagingReadiness,
      reason:
        messagingReadiness === 'ready'
          ? 'Slack is enabled and its auth/runtime path is not currently blocked.'
          : messagingReadiness === 'needs_setup'
            ? 'Slack is the right messaging surface, but auth or runtime readiness still needs repair.'
            : 'Slack is disabled or unavailable in the current manifest.',
      suggestedCommand:
        messagingReadiness === 'ready'
          ? 'pnpm surfaces:start --surface slack-bridge'
          : 'pnpm surfaces:setup',
    },
  ];
}

export function buildSurfaceLauncherNextActions(params: {
  summary?: SurfaceDirectorySummary;
  rows?: SurfaceDirectoryRow[];
  doctorSummaries?: SurfaceDoctorSummary[];
}) {
  const summary = params.summary || getSurfaceDirectorySummary();
  const rows = params.rows || getSurfaceDirectory();
  const doctorSummaries = params.doctorSummaries || [];
  const actions: Array<ReturnType<typeof buildNextAction>> = [];

  if (summary.auth_missing > 0) {
    actions.push(buildNextAction({
      title: 'Repair surface authentication',
      reason: `${summary.auth_missing} surfaces are blocked by missing auth or session setup.`,
      next_action_type: 'bootstrap_environment',
      suggested_command: 'pnpm surfaces:setup',
    }));
  }

  const staleRows = rows.filter((row) => row.runtime_status === 'stale');
  if (staleRows.length > 0) {
    actions.push(buildNextAction({
      title: 'Repair stale runtimes',
      reason: `${staleRows.length} surfaces have stale runtime records and should be reconciled before use.`,
      next_action_type: 'run_command',
      suggested_command: 'pnpm surfaces:reconcile',
    }));
  }

  const doctorSummary = doctorSummaries.find((entry) => entry.counts.must + entry.counts.should > 0);
  if (doctorSummary) {
    actions.push(buildNextAction({
      title: `Bootstrap ${doctorSummary.manifestId}`,
      reason: `Doctor reports ${doctorSummary.counts.must} must and ${doctorSummary.counts.should} should gaps.`,
      next_action_type: 'bootstrap_environment',
      suggested_command: `pnpm env:bootstrap --manifest ${doctorSummary.manifestId} --apply`,
    }));
  }

  if (actions.length === 0) {
    actions.push(buildNextAction({
      title: 'Inspect the current surface status',
      reason: 'Surfaces look ready right now. Re-check before switching workflows.',
      next_action_type: 'inspect_artifact',
      suggested_command: 'pnpm surfaces:status',
    }));
  }

  return actions.slice(0, 4);
}

function listKnownSurfaceChannels(): string[] {
  const channels = new Set<string>(['presence']);
  for (const manifest of listSurfaceProviderManifests()) {
    if (manifest.id) channels.add(manifest.id);
  }
  return [...channels].sort();
}

export function listSurfaceAsyncRequestsAcrossChannels(): Array<Record<string, any>> {
  return listKnownSurfaceChannels()
    .flatMap((surface) => listSurfaceAsyncRequests(surface).map((entry) => ({ ...entry, surface })))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export function listSurfaceNotificationsAcrossChannels(): Array<Record<string, any>> {
  return listKnownSurfaceChannels()
    .flatMap((surface) => listSurfaceNotifications(surface).map((entry) => ({ ...entry, surface })))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export function formatSurfaceRecoveryAction(
  action: SurfaceRecoveryAction,
  language: 'ja' | 'en',
): string {
  if (language === 'ja') {
    const parts = [action.reason];
    if (action.next_step) parts.push(`次の一手: ${action.next_step}`);
    if (action.command) parts.push(`実行コマンド: ${action.command}`);
    if (action.fallback) parts.push(`代替手段: ${action.fallback}`);
    return parts.join(' ');
  }
  const parts = [action.reason];
  if (action.next_step) parts.push(`Next step: ${action.next_step}`);
  if (action.command) parts.push(`Command: ${action.command}`);
  if (action.fallback) parts.push(`Fallback: ${action.fallback}`);
  return parts.join(' ');
}

export function buildSurfaceAsyncAcceptedReply(params: {
  requestId: string;
  receiver: string;
  language: 'ja' | 'en';
}): string {
  if (params.language === 'ja') {
    return `依頼を受け付けました。${params.receiver} に回しています。リクエストIDは ${params.requestId} です。進行状況は Presence Studio の async requests で確認でき、完了したらこの surface に通知します。`;
  }
  return `Accepted. Routing this to ${params.receiver}. The request id is ${params.requestId}. You can track it in Presence Studio async requests, and I will notify this surface when it completes.`;
}
