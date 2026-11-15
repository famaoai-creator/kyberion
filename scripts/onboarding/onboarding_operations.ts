/**
 * Resident-loop operations phase of onboarding. The autonomous dot loop
 * needs three settings beyond identity and reasoning — without them the
 * loop runs but produces nothing observable:
 *
 *   1. Resident services (scheduler + daemon watchdog) that actually drive
 *      the dot sweep — `pnpm kyberion scheduler reconcile --apply`.
 *   2. An operator notification channel — without one every alert lands as
 *      `operator_notification_undelivered` (no_channel_configured).
 *   3. Event intake sources + secrets — without them `event` triggers stay
 *      disarmed (`pnpm kyberion dot intake` shows ARMED=no).
 *
 * Interactive prompts run in the wizard; the same shape is accepted by the
 * non-interactive apply path (`operations` input). Secrets are never taken
 * at a prompt: enabling a source records the pending
 * `pnpm kyberion secret introduce event-intake <KEY>` step instead.
 */

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  EVENT_INTAKE_POLICY_PATH,
  EVENT_INTAKE_SECRET_SERVICE_ID,
  loadEventIntakePolicy,
} from '@agent/core/dot/dot-event-intake';
import {
  loadNotificationPreferences,
  saveNotificationPreferences,
} from '@agent/core/surface/operator-notifications';
import type { NotificationChannelTarget } from '@agent/core/surface/operator-notifications';
import type { OnboardingOperations } from '@agent/core/organization/onboarding-state';
import type { OnboardingApplyOperations } from '@agent/core/organization/onboarding-apply-input';
import { readJson, writeJson } from '@agent/core/foundation/json';
import { withExecutionContext } from '@agent/core/authority';
import { createLogger } from '@agent/core/logger';

const logger = createLogger('onboarding-operations');

// The surface union lives on OnboardingOperations — extend it there (plus the
// apply-input and state schemas) when a new notification channel registers.
const NOTIFICATION_SURFACES = [
  'slack',
  'imessage',
  'telegram',
  'discord',
  'inbox',
] as const satisfies readonly NonNullable<OnboardingOperations['notification_surface']>[];
type NotificationSurface = NonNullable<OnboardingOperations['notification_surface']>;

export interface OperationsPromptDeps {
  ask: (question: string, fallback?: string) => Promise<string>;
  print: (line: string) => void;
  /** Bilingual prompt renderer (en / ja). */
  t: (en: string, ja: string) => string;
  isAffirmative: (value: string) => boolean;
  /** Runs a supervised child CLI (`node <args...>`) with inherited stdio. */
  runTask: (taskId: string, args: string[]) => Promise<void>;
}

const SCHEDULER_RECONCILE_ARGS = [
  'scripts/kyberion_cli_entry.mjs',
  'scheduler',
  'reconcile',
  '--apply',
];

/**
 * Enable declared sources in the governed intake policy with ONE
 * read-modify-write pass (and therefore one audit record) — a per-source RMW
 * loop would write the policy N times and could leave a partially enabled
 * set on a mid-loop failure. Returns the ids this call actually enabled;
 * already-enabled and undeclared ids are not in the set.
 */
function enableIntakeSourcesInPolicy(sourceIds: readonly string[]): Set<string> {
  // EVENT_INTAKE_POLICY_PATH is repo-relative ('knowledge/product/...');
  // pathResolver.knowledge() would prefix 'knowledge/' a second time.
  const policyPath = path.join(pathResolver.rootDir(), EVENT_INTAKE_POLICY_PATH);
  const policy = readJson<{
    sources?: Record<string, { enabled?: boolean }>;
  }>(policyPath);
  const enabled = new Set<string>();
  for (const sourceId of sourceIds) {
    const entry = policy.sources?.[sourceId];
    if (!entry || entry.enabled === true) continue;
    entry.enabled = true;
    enabled.add(sourceId);
  }
  if (enabled.size > 0) writeJson(policyPath, policy);
  return enabled;
}

/** Configure the operator default notification channel (merges into prefs). */
function saveDefaultNotificationChannel(surface: NotificationSurface, target: string): void {
  const prefs = loadNotificationPreferences();
  const channel: NotificationChannelTarget = { surface, target };
  saveNotificationPreferences({ ...prefs, default_channel: channel });
}

/** The exact command an operator still owes for a push source to go live. */
export function intakeSecretCommand(secretKey: string): string {
  return `pnpm kyberion secret introduce ${EVENT_INTAKE_SECRET_SERVICE_ID} ${secretKey}`;
}

/** Operator-facing label for an intake source status in the summary. */
export function intakeStatusLabel(status: 'enabled' | 'pending_secret' | 'skipped'): string {
  switch (status) {
    case 'enabled':
      return 'enabled';
    case 'pending_secret':
      return 'enabled — awaiting secret';
    case 'skipped':
      return 'skipped';
  }
}

/** Operator-facing follow-ups for anything the phase could not finish. */
export function operationsNextSteps(ops: OnboardingOperations): string[] {
  const steps: string[] = [];
  if (ops.resident_services === 'pending' || ops.resident_services === 'skipped') {
    steps.push(
      'Install resident services so dots wake on their own: `pnpm kyberion scheduler reconcile --apply`'
    );
  }
  for (const entry of ops.intake_sources) {
    if (entry.status === 'pending_secret' && entry.secret_key) {
      steps.push(
        `Store the HMAC secret for the '${entry.source}' intake source: \`${intakeSecretCommand(entry.secret_key)}\``
      );
    }
  }
  if (!ops.notification_surface) {
    steps.push(
      'No operator notification channel is configured — alerts will stay undelivered; set one in Settings or rerun `pnpm onboarding`'
    );
  }
  const enabled = ops.intake_sources.filter((s) => s.status !== 'skipped');
  if (enabled.length > 0) {
    steps.push(
      'Verify event intake readiness: `pnpm kyberion dot intake` (sources show ARMED once enabled with their secret stored)'
    );
  }
  return steps;
}

/** Non-interactive apply: honour an operations input block without prompting. */
export function applyResidentLoopOperations(
  input: OnboardingApplyOperations
): OnboardingOperations {
  const ops: OnboardingOperations = {
    // The apply path never spawns service installers: 'install' records
    // 'pending' and the summary prints the reconcile command. 'defer' (and an
    // absent field) is also 'pending' — still owed — only an explicit 'skip'
    // opts out.
    resident_services: input.resident_services === 'skip' ? 'skipped' : 'pending',
    intake_sources: [],
  };
  if (input.notification && NOTIFICATION_SURFACES.includes(input.notification.surface)) {
    const { surface, target } = input.notification;
    try {
      withExecutionContext('sovereign_concierge', () =>
        saveDefaultNotificationChannel(surface, target)
      );
      ops.notification_surface = surface;
      ops.notification_target = target;
    } catch (error) {
      // The surface stays unset — the summary lists the gap — but the cause
      // must not vanish with the non-interactive run.
      logger.warn(
        `notification channel ${surface} could not be saved during apply — ${error instanceof Error ? error.message : String(error)} | next: configure it in Settings or rerun onboarding | evidence: scripts/onboarding/onboarding_operations.ts`
      );
    }
  }
  const policy = loadEventIntakePolicy();
  const requested = input.intake_enable ?? [];
  const toEnable = requested.filter(
    (id) => policy.sources[id] && policy.sources[id].enabled !== true
  );
  const enabledNow =
    toEnable.length > 0
      ? withExecutionContext('sovereign_concierge', () => enableIntakeSourcesInPolicy(toEnable))
      : new Set<string>();
  for (const id of requested) {
    const entry = policy.sources[id];
    if (!entry) {
      ops.intake_sources.push({ source: id, status: 'skipped' });
      continue;
    }
    // Match the interactive path: a source already enabled before this run is
    // 'enabled', not 'pending_secret' — its secret may already be stored.
    const alreadyEnabled = entry.enabled === true;
    ops.intake_sources.push({
      source: id,
      status: alreadyEnabled ? 'enabled' : enabledNow.has(id) ? 'pending_secret' : 'skipped',
      ...(entry.secret_key ? { secret_key: entry.secret_key } : {}),
    });
  }
  return ops;
}

/** Interactive wizard prompts for the operations phase. */
export async function promptResidentLoopOperations(
  deps: OperationsPromptDeps
): Promise<OnboardingOperations> {
  const { ask, print, t, isAffirmative, runTask } = deps;
  const ops: OnboardingOperations = { resident_services: 'skipped', intake_sources: [] };

  // --- 1. Resident services -------------------------------------------------
  const wantsServices = isAffirmative(
    await ask(
      // i18n-exempt: bilingual prompt pair (JA side intentional)
      t(
        'Install resident services (scheduler + daemon watchdog) so dots run on their own? (Y/n): ',
        'ドットが自律的に動くよう常駐サービス(scheduler + watchdog)をインストールしますか? (Y/n): '
      ),
      'y'
    )
  );
  if (wantsServices) {
    try {
      await runTask('scheduler-reconcile', SCHEDULER_RECONCILE_ARGS);
      ops.resident_services = 'installed';
      print(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t('Resident services installed.', '常駐サービスをインストールしました。')
      );
    } catch (error) {
      ops.resident_services = 'pending';
      print(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t(
          `Resident service install failed (${error instanceof Error ? error.message : String(error)}) — run it later: pnpm kyberion scheduler reconcile --apply`,
          `常駐サービスのインストールに失敗しました (${error instanceof Error ? error.message : String(error)}) — 後で実行してください: pnpm kyberion scheduler reconcile --apply`
        )
      );
    }
  } else {
    ops.resident_services = 'pending';
  }

  // --- 2. Operator notification channel -------------------------------------
  const surfaceInput = (
    await ask(
      // i18n-exempt: bilingual prompt pair (JA side intentional)
      t(
        'Operator notification surface — where alerts land (slack/imessage/telegram/discord/inbox/none; inbox is the built-in local inbox, works with no external setup) [inbox]: ',
        'オペレータ通知の宛先 — アラートの届き先 (slack/imessage/telegram/discord/inbox/none。inbox は内蔵ローカル受信箱で外部設定不要) [inbox]: '
      ),
      'inbox'
    )
  )
    .trim()
    .toLowerCase();
  if (surfaceInput !== 'none' && surfaceInput !== '') {
    const surface = (
      NOTIFICATION_SURFACES.includes(surfaceInput as NotificationSurface) ? surfaceInput : 'inbox'
    ) as NotificationSurface;
    const target =
      (
        await ask(
          // i18n-exempt: bilingual prompt pair (JA side intentional)
          t(
            `Notification target on ${surface} (channel/chat/recipient id; a local label for inbox) [operator]: `,
            `${surface} の通知ターゲット (チャンネル/チャット/受信者 ID。inbox はローカルラベル) [operator]: `
          ),
          'operator'
        )
      ).trim() || 'operator';
    try {
      withExecutionContext('sovereign_concierge', () =>
        saveDefaultNotificationChannel(surface, target)
      );
      ops.notification_surface = surface;
      ops.notification_target = target;
      print(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t(`Operator notifications → ${surface}:${target}`, `オペレータ通知 → ${surface}:${target}`)
      );
    } catch (error) {
      print(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t(
          `Could not save notification preferences (${error instanceof Error ? error.message : String(error)}) — configure it later in Settings.`,
          `通知設定を保存できませんでした (${error instanceof Error ? error.message : String(error)}) — 後で Settings で設定してください。`
        )
      );
    }
  }

  // --- 3. Event intake sources ----------------------------------------------
  const policy = loadEventIntakePolicy();
  const declared = Object.entries(policy.sources);
  if (declared.length > 0) {
    print(
      // i18n-exempt: bilingual prompt pair (JA side intentional)
      t(
        '\nDeclared event intake sources (webhook feeds that can wake dots):',
        '\n宣言済みイベント intake ソース (ドットを起こせる webhook フィード):'
      )
    );
  }
  for (const [id, source] of declared) {
    if (source.enabled) {
      ops.intake_sources.push({
        source: id,
        status: 'enabled',
        ...(source.secret_key ? { secret_key: source.secret_key } : {}),
      });
      print(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t(`  '${id}' is already enabled.`, `  '${id}' は有効化済みです。`)
      );
      continue;
    }
    const wants = isAffirmative(
      await ask(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t(
          `Enable '${id}' events?${source.description ? ` ${source.description}` : ''} (y/N): `,
          `'${id}' イベントを有効化しますか?${source.description ? ` ${source.description}` : ''} (y/N): `
        ),
        'n'
      )
    );
    if (!wants) {
      ops.intake_sources.push({ source: id, status: 'skipped' });
      continue;
    }
    let enabled = false;
    try {
      enabled = withExecutionContext('sovereign_concierge', () =>
        enableIntakeSourcesInPolicy([id]).has(id)
      );
    } catch (error) {
      // A governed write failure must not crash the wizard — record the gap
      // and tell the operator exactly what to retry by hand.
      print(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t(
          `  Could not enable '${id}' (${error instanceof Error ? error.message : String(error)}) — flip "enabled" in knowledge/product/governance/event-intake-policy.json later.`,
          `  '${id}' を有効化できませんでした (${error instanceof Error ? error.message : String(error)}) — 後で knowledge/product/governance/event-intake-policy.json の "enabled" を変更してください。`
        )
      );
    }
    ops.intake_sources.push({
      source: id,
      status: enabled ? 'pending_secret' : 'skipped',
      ...(source.secret_key ? { secret_key: source.secret_key } : {}),
    });
    if (enabled && source.secret_key) {
      print(
        // i18n-exempt: bilingual prompt pair (JA side intentional)
        t(
          `  '${id}' enabled — store its HMAC secret next: ${intakeSecretCommand(source.secret_key)}`,
          `  '${id}' を有効化しました — 次に HMAC secret を保存してください: ${intakeSecretCommand(source.secret_key)}`
        )
      );
    }
  }
  return ops;
}
