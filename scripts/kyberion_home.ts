#!/usr/bin/env node
/**
 * `pnpm kyberion` — the operator's single entry point (E2E-04 / SU-01 minimal).
 *
 * Design rule: every command this screen advertises MUST actually work from
 * here. The home view answers "do I need to do anything?" and each queue
 * (inbox / approvals) is actionable in place; `ask` talks to the same brain
 * every other surface uses.
 */
import { formatNextAction, getGovernanceControlSummary } from '@agent/core';
import {
  decideApprovalRequest,
  ingestAudioIntoDealRequirements,
  listApprovalRequests,
  listCustomerChannelBindings,
  listDeals,
  listInboxEntries,
  loadNotificationPreferences,
  markInboxEntry,
  readDealRequirementsCapture,
  runSurfaceMessageConversation,
  saveNotificationPreferences,
  type NotificationChannelTarget,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { collectOperatorHomeSummary } from '@agent/core';
import { collectDoctorReport } from './run_doctor.js';

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['pnpm kyberion', 'ホーム: 状態ダイジェストと次の一手'],
  ['pnpm kyberion ask "<依頼>"', 'Kyberion に話しかける(Slack と同じ脳)'],
  ['pnpm kyberion inbox [--read <id>|--accept <id>]', '成果物 inbox の確認と受領'],
  ['pnpm kyberion approvals [--approve <id>|--deny <id>]', '承認キューの確認と裁可'],
  ['pnpm kyberion notify [--set slack:<channel>]', '通知先の確認・設定'],
  ['pnpm kyberion deals [--requirements <deal-id>]', '商談一覧と要件ヒアリング内容の確認'],
  [
    'pnpm kyberion deals --ingest-audio <deal-id> --audio <path>',
    '通話録音を要件ドラフトへ取り込み',
  ],
  ['pnpm mission create', 'ミッションの作成'],
  ['pnpm app:preflight', 'アプリ開発の前提チェック'],
  ['pnpm doctor', '健全性と次の一手の診断'],
  ['pnpm dashboard', 'ダッシュボード表示'],
] as const;

function printCommands(): void {
  console.log('コマンド:');
  for (const [command, description] of COMMANDS) {
    console.log(`  ${command.padEnd(52)} ${description}`);
  }
}

// E2E-04 Task 2: `pnpm kyberion notify --set slack:C012345` writes the
// operator's default notification channel (surface:target).
function handleNotifySubcommand(setValue: string): void {
  const [surface, ...rest] = setValue.split(':');
  const target = rest.join(':');
  const allowed = ['slack', 'imessage', 'telegram', 'discord'];
  if (!allowed.includes(surface) || !target) {
    console.error(`Usage: pnpm kyberion notify --set <${allowed.join('|')}>:<channel-id>`);
    process.exitCode = 1;
    return;
  }
  const prefs = loadNotificationPreferences();
  prefs.default_channel = { surface, target } as NotificationChannelTarget;
  const filePath = saveNotificationPreferences(prefs);
  console.log(`Default notification channel set to ${surface}:${target} (${filePath})`);
}

function handleInboxSubcommand(argv: { read?: string; accept?: string; json?: boolean }): void {
  if (argv.read || argv.accept) {
    const entryId = String(argv.read || argv.accept);
    const status = argv.read ? 'read' : 'accepted';
    const updated = markInboxEntry(entryId, status, { reviewedBy: 'operator' });
    if (!updated) {
      console.error(`inbox entry not found: ${entryId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`✓ ${updated.entry_id} → ${updated.status}: ${updated.title}`);
    return;
  }
  const entries = listInboxEntries({ limit: 30 });
  if (argv.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log('Inbox は空です。');
    return;
  }
  const unread = entries.filter((entry) => entry.status === 'unread');
  console.log(`Inbox (${unread.length} 件未読 / ${entries.length} 件):`);
  for (const entry of entries) {
    const marker = entry.status === 'unread' ? '●' : entry.status === 'accepted' ? '✔' : '○';
    console.log(`  ${marker} [${entry.entry_id}] ${entry.title}`);
    console.log(`      ${entry.summary.slice(0, 100)}`);
    if (entry.artifact_paths.length > 0) {
      console.log(
        `      → ${entry.artifact_paths[0]}${entry.artifact_paths.length > 1 ? ` (+${entry.artifact_paths.length - 1})` : ''}`
      );
    }
  }
  console.log('');
  console.log('既読化: pnpm kyberion inbox --read <id> / 受領: --accept <id>');
}

function handleApprovalsSubcommand(argv: {
  approve?: string;
  deny?: string;
  note?: string;
  json?: boolean;
}): void {
  const pending = listApprovalRequests({ status: 'pending' });
  if (argv.approve || argv.deny) {
    const requestId = String(argv.approve || argv.deny);
    const request = pending.find((entry) => entry.id === requestId);
    if (!request) {
      console.error(`pending approval not found: ${requestId}`);
      process.exitCode = 1;
      return;
    }
    const decided = decideApprovalRequest('mission_controller', {
      channel: request.channel,
      storageChannel: request.storageChannel,
      requestId: request.id,
      decision: argv.approve ? 'approved' : 'rejected',
      decidedBy: 'sovereign-user',
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      note: argv.note || 'decided via pnpm kyberion approvals',
    });
    console.log(`✓ ${decided.id} → ${decided.status}: ${decided.title}`);
    return;
  }
  if (argv.json) {
    console.log(JSON.stringify(pending, null, 2));
    return;
  }
  if (pending.length === 0) {
    console.log('承認待ちはありません。');
    return;
  }
  console.log(`承認待ち (${pending.length} 件):`);
  for (const request of pending) {
    console.log(`  ● [${request.id}] ${request.title}`);
    if (request.summary) console.log(`      ${String(request.summary).slice(0, 120)}`);
    console.log(
      `      requested by ${request.requestedBy} via ${request.channel} at ${request.requestedAt}`
    );
  }
  console.log('');
  console.log('裁可: pnpm kyberion approvals --approve <id> / --deny <id> [--note "..."]');
}

async function handleAskSubcommand(text: string, json: boolean): Promise<void> {
  if (!text.trim()) {
    console.error('Usage: pnpm kyberion ask "<依頼・質問>"');
    process.exitCode = 1;
    return;
  }
  const correlationId = `kyberion-ask-${Date.now().toString(36)}`;
  const result = await runSurfaceMessageConversation({
    surface: 'cli',
    text,
    channel: 'kyberion-home',
    threadTs: correlationId,
    correlationId,
    receivedAt: new Date().toISOString(),
    actorId: 'operator',
    senderAgentId: 'kyberion:home-cli',
    agentId: 'cli-surface-agent',
    delegationSummaryInstruction:
      'Produce a concise terminal-friendly reply in the operator language. No A2A blocks.',
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const reply = (result as { text?: string })?.text;
  console.log(reply?.trim() || '(応答が空でした — pnpm doctor で backend 設定を確認してください)');
}

function printCustomerBindingsWarning(): void {
  try {
    const bindings = listCustomerChannelBindings().filter(
      (entry) => entry.binding.active !== false
    );
    if (bindings.length === 0) return;
    console.log('');
    console.log(
      `⚠ 顧客モード channel binding: ${bindings.length} 件アクティブ(誤バインディング注意)`
    );
    for (const entry of bindings.slice(0, 5)) {
      console.log(
        `  - ${entry.binding.surface}:${entry.binding.channel_id} → ${entry.tenantSlug}` +
          (entry.binding.counterpart?.org ? ` (${entry.binding.counterpart.org})` : '')
      );
    }
    if (bindings.length > 5) console.log(`  ... 他 ${bindings.length - 5} 件`);
  } catch {
    // home must never fail on an optional panel
  }
}

async function showHome(json: boolean): Promise<void> {
  const doctor = await collectDoctorReport({});
  const governance = getGovernanceControlSummary();
  const home = collectOperatorHomeSummary({ limit: 8 });

  if (json) {
    console.log(
      JSON.stringify(
        {
          doctor,
          governance,
          home,
          commands: COMMANDS.map(([command, description]) => ({ command, description })),
        },
        null,
        2
      )
    );
    return;
  }

  console.log('Kyberion Home');
  console.log(`Status: ${home.statusLabel} — ${home.statusDetail}`);
  console.log(`Doctor gaps: ${doctor.totalMissing}`);
  console.log(
    `承認待ち ${governance.pending_approvals} 件 / 質問 ${home.counts.clarificationQuestions} 件 / inbox 未読 ${home.counts.unreadInbox} 件`
  );
  const recent = [...home.activeMissions]
    .sort((left, right) =>
      String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    )
    .slice(0, 3);
  console.log(
    `実行中ミッション: ${home.counts.activeMissions} 件(直近7日で動きあり ${home.counts.recentlyActiveMissions} 件)` +
      (recent.length > 0 ? ' — 直近:' : '')
  );
  for (const mission of recent) {
    console.log(
      `  - ${mission.missionId} [${mission.missionType || 'mission'}] ${String(mission.goalSummary || '').slice(0, 70)}`
    );
  }
  console.log('');
  for (const line of formatNextAction(home.nextAction)) {
    console.log(line);
  }
  printCustomerBindingsWarning();
  console.log('');
  printCommands();
}

// Customer-path operator view: which deals are live, at what stage, and what
// the requirements hearing has captured so far (E2E-06 follow-up).
async function handleDealsIngestAudio(argv: {
  ingestAudio?: string;
  audio?: string;
}): Promise<void> {
  const bindings = listCustomerChannelBindings();
  const tenants = Array.from(new Set(bindings.map((binding) => binding.tenantSlug)));
  const match = tenants
    .flatMap((tenantSlug) => listDeals(tenantSlug).map((deal) => ({ tenantSlug, deal })))
    .find((entry) => entry.deal.deal_id === argv.ingestAudio);
  if (!match) {
    console.error(`deal not found: ${argv.ingestAudio}`);
    process.exitCode = 1;
    return;
  }
  if (!argv.audio) {
    console.error('Usage: pnpm kyberion deals --ingest-audio <deal-id> --audio <path>');
    process.exitCode = 1;
    return;
  }
  const result = await ingestAudioIntoDealRequirements({
    tenantSlug: match.tenantSlug,
    dealId: match.deal.deal_id,
    audioPath: argv.audio,
    projectName: match.deal.summary?.slice(0, 80),
  });
  if (!result) {
    console.error(
      '取り込みに失敗しました(文字起こし不可、または reasoning backend が stub)。ログを確認してください。'
    );
    process.exitCode = 1;
    return;
  }
  console.log(`✓ 要件ドラフト更新 (${result.capture.turns_captured} 回目の取り込み)`);
  if (result.transcript_path) console.log(`  文字起こし: ${result.transcript_path}`);
  console.log(`  確認: pnpm kyberion deals --requirements ${match.deal.deal_id}`);
}

function handleDealsSubcommand(argv: { requirements?: string; json?: boolean }): void {
  const bindings = listCustomerChannelBindings();
  const tenants = Array.from(new Set(bindings.map((binding) => binding.tenantSlug)));
  const deals = tenants.flatMap((tenantSlug) =>
    listDeals(tenantSlug).map((deal) => ({ tenantSlug, deal }))
  );

  if (argv.requirements) {
    const match = deals.find((entry) => entry.deal.deal_id === argv.requirements);
    if (!match) {
      console.error(`deal not found: ${argv.requirements}`);
      process.exitCode = 1;
      return;
    }
    const capture = readDealRequirementsCapture(match.tenantSlug, match.deal.deal_id);
    if (!capture) {
      console.log(
        `要件キャプチャはまだありません (${match.deal.deal_id} / stage: ${match.deal.stage})。` +
          ' discovery ステージの顧客対話で自動収集されます。'
      );
      return;
    }
    if (argv.json) {
      console.log(JSON.stringify(capture, null, 2));
      return;
    }
    const req = capture.requirements;
    console.log(
      `要件ドラフト ${match.deal.deal_id} (${capture.turns_captured} ターン / 更新 ${capture.updated_at})`
    );
    for (const fr of req.functional_requirements || []) {
      console.log(`  [${fr.priority}] ${fr.id}: ${fr.description}`);
    }
    for (const nfr of req.non_functional_requirements || []) {
      console.log(`  [nfr:${nfr.category}] ${nfr.description}`);
    }
    const open = (req.open_questions || []).filter((q) => (q.status || 'open') === 'open');
    if (open.length > 0) {
      console.log('  未解決の質問:');
      for (const q of open) console.log(`    - ${q.blocking ? '[blocking] ' : ''}${q.question}`);
    }
    return;
  }

  if (argv.json) {
    console.log(JSON.stringify(deals, null, 2));
    return;
  }
  if (deals.length === 0) {
    console.log('商談はありません。顧客チャネルの binding から自動で開始されます。');
    return;
  }
  console.log(`商談 (${deals.length} 件):`);
  for (const { tenantSlug, deal } of deals) {
    console.log(
      `  [${deal.deal_id}] ${tenantSlug} / ${deal.stage.padEnd(10)} ${deal.summary.slice(0, 60)}`
    );
  }
  console.log('');
  console.log('要件ヒアリング内容: pnpm kyberion deals --requirements <deal-id>');
}

async function main(): Promise<void> {
  // The home CLI acts with the operator's own authority — same role the
  // mission controller CLI assumes (inbox/approvals live under active/shared).
  if (!process.env.MISSION_ROLE) {
    process.env.MISSION_ROLE = 'mission_controller';
  }
  // yargs intercepts a literal `help` positional with its own dump — answer
  // with the command table (what the home screen advertises) instead.
  if (process.argv[2] === 'help') {
    printCommands();
    return;
  }
  const argv = await createStandardYargs()
    .option('json', { type: 'boolean', default: false })
    .option('set', { type: 'string', description: 'notify: set default channel surface:target' })
    .option('read', { type: 'string', description: 'inbox: mark entry as read' })
    .option('accept', { type: 'string', description: 'inbox: mark entry as accepted' })
    .option('approve', { type: 'string', description: 'approvals: approve request id' })
    .option('deny', { type: 'string', description: 'approvals: reject request id' })
    .option('note', { type: 'string', description: 'approvals: decision note' })
    .option('requirements', {
      type: 'string',
      description: 'deals: show captured requirements for a deal id',
    })
    .option('ingest-audio', {
      type: 'string',
      description: 'deals: transcribe a call recording into the requirements draft',
    })
    .option('audio', { type: 'string', description: 'deals: audio file path for --ingest-audio' })
    .parseSync();

  const subcommand = String(argv._[0] || '');
  switch (subcommand) {
    case 'notify':
      if (argv.set) handleNotifySubcommand(String(argv.set));
      else console.log(JSON.stringify(loadNotificationPreferences(), null, 2));
      return;
    case 'inbox':
      handleInboxSubcommand(argv as { read?: string; accept?: string; json?: boolean });
      return;
    case 'approvals':
      handleApprovalsSubcommand(
        argv as { approve?: string; deny?: string; note?: string; json?: boolean }
      );
      return;
    case 'deals':
      if (argv['ingest-audio']) {
        await handleDealsIngestAudio({
          ingestAudio: String(argv['ingest-audio']),
          audio: argv.audio ? String(argv.audio) : undefined,
        });
        return;
      }
      handleDealsSubcommand(argv as { requirements?: string; json?: boolean });
      return;
    case 'ask':
      await handleAskSubcommand(argv._.slice(1).map(String).join(' '), Boolean(argv.json));
      return;
    case 'help':
      printCommands();
      return;
    case '':
      await showHome(Boolean(argv.json));
      return;
    default:
      console.error(`unknown subcommand: ${subcommand}`);
      printCommands();
      process.exitCode = 1;
  }
}

void main();
