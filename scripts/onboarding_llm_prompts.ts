/**
 * Interactive onboarding steps for the reasoning model and provider egress.
 *
 * The wizard (`onboarding_wizard.ts`) owns the terminal; these steps take its
 * `ask` / `print` so they can be driven with scripted answers in tests. They
 * only orchestrate prompts — validation, persistence, approval and audit are
 * the same helpers `pnpm onboarding llm` uses.
 */
import { captureCliAttestationInvoker } from './lib/cli-attestation-invoker.js';
import { loadProviderEgressPolicy } from '@agent/core/provider/provider-egress-gate';
import {
  captureAttestationInvoker,
  type AttestationInvoker,
} from '@agent/core/organization/tenant-governance';
import { getLlmSelectionSnapshot } from '@agent/core/llm-selection-preferences';
import {
  applyLlmSelection,
  applyProviderAttestation,
  availabilityFor,
  defaultModelForBackend,
  formatAvailability,
  requestProviderAttestationApproval,
  resolveModelId,
  type OnboardingLlmOptions,
} from './onboarding_llm.js';

export type Ask = (question: string, defaultValue?: string) => Promise<string>;

export interface LlmPromptDeps extends OnboardingLlmOptions {
  ask: Ask;
  print: (value: unknown) => void;
  /** Bilingual text picker; defaults to English. */
  t?: (en: string, ja: string) => string;
  invoker?: AttestationInvoker;
}

const MAX_ATTEMPTS = 3;
const affirmative = (value: string): boolean => /^(y|yes|はい)$/i.test(value.trim()); // i18n-exempt: bilingual prompt pair (JA side intentional)

function pick(deps: LlmPromptDeps): (en: string, ja: string) => string {
  return deps.t ?? ((en) => en);
}

/**
 * Ask for the model of the chosen backend (registered models only; Enter
 * keeps the backend's default) and record backend + model in the operator
 * LLM selection. Returns the recorded model, or undefined when skipped.
 */
export async function promptReasoningModel(
  backend: string,
  deps: LlmPromptDeps
): Promise<{ recorded: boolean; model_id?: string }> {
  const t = pick(deps);
  const candidate = getLlmSelectionSnapshot().candidates.find(
    (entry) => entry.provider === backend
  );
  if (!candidate || !candidate.selectable) {
    deps.print(
      t(
        `Model selection skipped: ${backend} is not ready here (${candidate?.reason ?? 'unknown runtime'}).`,
        `モデル選択をスキップしました: ${backend} はこの環境で使えません（${candidate?.reason ?? '不明なランタイム'}）。` // i18n-exempt: bilingual prompt pair (JA side intentional)
      )
    );
    return { recorded: false };
  }
  const models = candidate.model_ids;
  const fallback = defaultModelForBackend(backend, models);
  let model: string | undefined = fallback;
  if (models.length > 0) {
    deps.print(t(`Models registered for ${backend}:`, `${backend} で使える登録済みモデル:`)); // i18n-exempt: bilingual prompt pair (JA side intentional)
    models.forEach((id, index) =>
      deps.print(`  ${index + 1}. ${id}${id === fallback ? ' (default)' : ''}`)
    );
    model = undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !model; attempt += 1) {
      const answer = (
        await deps.ask(
          t(
            `Model [1-${models.length}, id, or Enter for ${fallback ?? 'the provider default'}]: `,
            `モデル [1-${models.length}・id・Enter で ${fallback ?? 'プロバイダ既定'}]: ` // i18n-exempt: bilingual prompt pair (JA side intentional)
          ),
          ''
        )
      ).trim();
      if (!answer) {
        model = fallback;
        break;
      }
      const resolved = /^\d+$/.test(answer)
        ? models[Number.parseInt(answer, 10) - 1]
        : resolveModelId(answer, models);
      if (resolved && models.includes(resolved)) model = resolved;
      else
        deps.print(
          t(
            `'${answer}' is not a registered model.`,
            `'${answer}' は登録済みモデルではありません。` // i18n-exempt: bilingual prompt pair (JA side intentional)
          )
        );
    }
    if (!model) model = fallback;
  }
  const change = applyLlmSelection({
    backend,
    ...(model ? { model } : {}),
    ...(deps.envLocalPath ? { envLocalPath: deps.envLocalPath } : {}),
    actor: (deps.invoker ?? captureAttestationInvoker()).actor,
  });
  deps.print(
    t(
      `Recorded backend=${change.selection.provider}${change.selection.model_id ? ` model=${change.selection.model_id}` : ''} in ${change.storage_path}`,
      `backend=${change.selection.provider}${change.selection.model_id ? ` model=${change.selection.model_id}` : ''} を ${change.storage_path} に記録しました` // i18n-exempt: bilingual prompt pair (JA side intentional)
    )
  );
  return {
    recorded: true,
    ...(change.selection.model_id ? { model_id: change.selection.model_id } : {}),
  };
}

export interface AttestationPromptResult {
  outcome: 'declined' | 'cancelled' | 'requested' | 'applied';
  request_id?: string;
}

/**
 * Opt-in: let a provider receive a tenant's confidential material. Default is
 * "no". For `training_use none` this opens a human approval request and prints
 * the approve command — it never approves on the operator's behalf. `used` /
 * `unknown` never open egress and are recorded after an explicit confirmation.
 */
export async function promptProviderAttestation(
  tenants: readonly string[],
  deps: LlmPromptDeps
): Promise<AttestationPromptResult> {
  const t = pick(deps);
  if (tenants.length === 0) return { outcome: 'declined' };
  const optIn = await deps.ask(
    t(
      'Allow an LLM provider to receive a tenant’s confidential material (e.g. mission distillation)? (y/N): ',
      'テナントの機密情報（mission distill など）を LLM provider に送ることを許可しますか? (y/N): ' // i18n-exempt: bilingual prompt pair (JA side intentional)
    ),
    'n'
  );
  if (!affirmative(optIn)) {
    deps.print(
      t(
        'Confidential material stays with local-only providers. Enable it later with `pnpm onboarding llm attest`.',
        '機密情報は local-only provider だけで扱います。後から `pnpm onboarding llm attest` で有効にできます。' // i18n-exempt: bilingual prompt pair (JA side intentional)
      )
    );
    return { outcome: 'declined' };
  }
  const tenant =
    tenants.length === 1
      ? tenants[0]!
      : (
          await deps.ask(
            t(
              `Tenant [${tenants.join(', ')}] (${tenants[0]}): `,
              `テナント [${tenants.join(', ')}] (${tenants[0]}): ` // i18n-exempt: bilingual prompt pair (JA side intentional)
            ),
            tenants[0]
          )
        ).trim() || tenants[0]!;
  if (!tenants.includes(tenant)) {
    deps.print(
      t(
        `Unknown tenant '${tenant}'; nothing recorded.`,
        `テナント '${tenant}' は未登録です。何も記録していません。` // i18n-exempt: bilingual prompt pair (JA side intentional)
      )
    );
    return { outcome: 'cancelled' };
  }
  const loaded = loadProviderEgressPolicy();
  const external =
    loaded.status === 'ok'
      ? Object.entries(loaded.policy.providers)
          .filter(([, declaration]) => declaration.egress !== 'local-only')
          .map(([id]) => id)
          .sort()
      : [];
  const provider = (
    await deps.ask(
      t(`Provider [${external.join(', ')}]: `, `Provider [${external.join(', ')}]: `),
      ''
    )
  ).trim();
  if (!external.includes(provider)) {
    deps.print(
      t(
        `Unknown provider '${provider}'; nothing recorded.`,
        `provider '${provider}' は宣言されていません。何も記録していません。` // i18n-exempt: bilingual prompt pair (JA side intentional)
      )
    );
    return { outcome: 'cancelled' };
  }
  const trainingUse = (
    await deps.ask(
      t(
        'Does the plan train on what you send? training_use [none|used|unknown] (unknown): ',
        'そのプランは送信内容を学習に使いますか? training_use [none|used|unknown] (unknown): ' // i18n-exempt: bilingual prompt pair (JA side intentional)
      ),
      'unknown'
    )
  ).trim();
  if (trainingUse !== 'none' && trainingUse !== 'used' && trainingUse !== 'unknown') {
    deps.print(
      t(
        `Invalid training_use '${trainingUse}'; nothing recorded.`,
        `training_use '${trainingUse}' は無効です。何も記録していません。` // i18n-exempt: bilingual prompt pair (JA side intentional)
      )
    );
    return { outcome: 'cancelled' };
  }
  const plan = (await deps.ask(t('Plan name (contract): ', '契約プラン名: '), '')).trim(); // i18n-exempt: bilingual prompt pair (JA side intentional)
  const basis = (
    await deps.ask(
      t('Basis (terms URL or contract ref): ', '根拠（規約 URL または契約の参照）: '), // i18n-exempt: bilingual prompt pair (JA side intentional)
      ''
    )
  ).trim();
  const attestedBy = (
    await deps.ask(t('Attested by (e.g. human:owner): ', '記名（例 human:owner）: '), '')
  ) // i18n-exempt: bilingual prompt pair (JA side intentional)
    .trim();
  if (trainingUse === 'none' && (!plan || !basis || !attestedBy)) {
    deps.print(
      t(
        'training_use none needs plan, basis and attested-by; nothing recorded.',
        'training_use none には契約プラン名・根拠・記名が必要です。何も記録していません。' // i18n-exempt: bilingual prompt pair (JA side intentional)
      )
    );
    return { outcome: 'cancelled' };
  }
  deps.print(
    [
      t('About to state, for this tenant only:', 'このテナントについて次の内容を宣言します:'), // i18n-exempt: bilingual prompt pair (JA side intentional)
      `  tenant=${tenant} provider=${provider} training_use=${trainingUse}`,
      ...(plan ? [`  plan=${plan}`] : []),
      ...(basis ? [`  basis=${basis}`] : []),
      ...(attestedBy ? [`  attested_by=${attestedBy}`] : []),
    ].join('\n')
  );
  const confirm = await deps.ask(
    trainingUse === 'none'
      ? t(
          'Open a human approval request for this attestation? It takes effect only after a human approves it. (y/N): ',
          'この宣言の承認依頼を作成しますか? 人間が承認するまで有効になりません。 (y/N): ' // i18n-exempt: bilingual prompt pair (JA side intentional)
        )
      : t(
          'Record this attestation? This is your statement about the plan’s terms. (y/N): ',
          'この宣言を記録しますか? プランの条件についてのあなたの表明になります。 (y/N): ' // i18n-exempt: bilingual prompt pair (JA side intentional)
        ),
    'n'
  );
  if (!affirmative(confirm)) {
    deps.print(t('Nothing recorded.', '何も記録していません。')); // i18n-exempt: bilingual prompt pair (JA side intentional)
    return { outcome: 'cancelled' };
  }
  const input = {
    tenant,
    provider,
    training_use: trainingUse,
    ...(plan ? { plan } : {}),
    ...(basis ? { basis } : {}),
    ...(attestedBy ? { attested_by: attestedBy } : {}),
    invoker: deps.invoker ?? captureCliAttestationInvoker(),
    ...(deps.tenantRegistryRootDir ? { tenantRegistryRootDir: deps.tenantRegistryRootDir } : {}),
  } as const;
  if (trainingUse === 'none') {
    const request = requestProviderAttestationApproval(input);
    deps.print(
      [
        t(
          `Approval request ${request.request_id} is ${request.status}. A human must approve it — this wizard does not:`,
          `承認依頼 ${request.request_id} は ${request.status} です。承認は人間が行います（このウィザードは承認しません）:` // i18n-exempt: bilingual prompt pair (JA side intentional)
        ),
        `  ${request.approve_command}`,
        t('Then record the attestation with:', 'その後、次のコマンドで記録します:'), // i18n-exempt: bilingual prompt pair (JA side intentional)
        `  pnpm onboarding llm attest --tenant ${tenant} --provider ${provider} --training-use none --plan "${plan}" --basis "${basis}" --attested-by "${attestedBy}" --apply --accept --approval-request-id ${request.request_id}`,
        ...formatAvailability(availabilityFor(tenant, deps)),
      ].join('\n')
    );
    return { outcome: 'requested', request_id: request.request_id };
  }
  applyProviderAttestation(input);
  deps.print(formatAvailability(availabilityFor(tenant, deps)).join('\n'));
  return { outcome: 'applied' };
}
