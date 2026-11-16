---
title: 推論の資格情報の持ち主・種類・貸し出しと claude CLI の隔離（設計）
status: active
last_updated: 2026-11-16
tags: [credential-binding, credential-custody, reasoning, claude-cli, resident-dot, tenant, stance]
---

# 推論の資格情報の持ち主・種類・貸し出しと claude CLI の隔離（設計）

## 0. 結論

1. **データの持ち主（テナント）と資格情報の持ち主（custody）を分ける。** 資格情報の持ち主は個人（person）かテナント（tenant）。持ち主は、承認したうえで別のテナントの仕事に資格情報を**貸し出せる**。
2. **資格情報の種類（kind）で、貸し出せる範囲を決める。** API キー（商用規約）はどのテナントにも貸し出せる。購読のトークン（`claude setup-token`）は**持ち主本人の仕事の範囲**に限る。
3. **claude CLI は、テナントの実行では必ず隔離して起動する。** operator の設定・hooks・MCP・ログインを読まない。資格情報は binding から渡したものだけを使う。
4. 承認・延長・失効は既存の `credential.use`（30 日、延長承認あり）に乗せる。新しい権限の経路は作らない。

### 想定するユースケース

| 場面                                         | データの持ち主               | 資格情報                                                                     | 種類                             |
| -------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| 会社の Dot（親会社が自社で使う）             | 親会社テナント               | 親会社テナントの API キー（Team プランの月次 API クレジットの Console 組織） | api_key（商用）                  |
| 子会社の仕事を親会社の契約で行う             | 子会社テナント               | 親会社テナントの API キーを**貸し出し**                                      | api_key（商用）                  |
| 個人で兼務・顧問をする顧問先                 | 顧問先テナント               | 本人の API キーを貸し出し（または顧問先のキー）                              | api_key（商用）                  |
| 家での個人開発                               | 本人が持ち主の開発用テナント | 本人の Pro/Max の `setup-token`                                              | subscription_token（消費者規約） |
| テナントを持たない Dot（repo-guardian など） | なし                         | 従来どおり operator の環境                                                   | 変更なし                         |

## 1. 前提となる事実

| 事実                                                                                                                                                                                        | 出典                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| OAuth（購読の資格情報）は購読者本人の通常の利用のため。製品・エージェントは Console の API キーを使う。自社の API キーを自社の許可された利用者が使い、課金がキーの持ち主に付く形は許される  | code.claude.com/docs/en/legal-and-compliance                     |
| `setup-token` は 1 年有効の OAuth トークン。Pro/Max/Ultra/Team/Enterprise で発行でき、`CLAUDE_CODE_OAUTH_TOKEN` で使う。`--bare` はこれを無視する                                           | code.claude.com/docs/en/authentication                           |
| `-p` では `ANTHROPIC_API_KEY` が保存済みログインより優先。`CLAUDE_CODE_OAUTH_TOKEN` も Keychain より優先。`CLAUDE_CONFIG_DIR` を変えると参照する Keychain の項目も変わる                    | 同上                                                             |
| Team プランは月次の API クレジット（Standard $20/席、Premium $100/席、合算で上限 $500/月、繰り越しなし）を紐づけた Console 組織に付与する。その組織の API キーで動かす `claude -p` に使える | support.claude.com/en/articles/17154008                          |
| Pro/Max は消費者規約、Team/Enterprise/API は商用規約                                                                                                                                        | code.claude.com/docs/en/legal-and-compliance                     |
| 導入済み CLI は 2.1.325。`--bare` `--restricted` `--setting-sources` `--strict-mcp-config` `--permission-prompts` が使える                                                                  | `claude --help`（2026-11-16）                                    |
| 現状、binding 下の claude-cli は `[CREDENTIAL_PROVIDER_DENIED]` になる（組込みの割り当てがプロバイダ環境を作らない）                                                                        | `credential-allocations.ts:313-329`、`credential-binding.ts:548` |
| 現状、delegate・stream 経路はリポジトリの `.claude/settings.json` の hooks をテナントの実行でも読み込む                                                                                     | `shell-claude-cli-backend.ts:542-552, 641-652, 670, 1131`        |
| 現状、`CLAUDE_CONFIG_DIR` と `CLAUDE_CODE_OAUTH_TOKEN` は子プロセスの環境から落とされる                                                                                                     | `provider-permission-profiles.ts:393, 498, 569-576`              |

## 2. モデル

### 2.1 資格情報の記録（credential record）

```
credential_ref:   <custody>:<owner>:<service>[:<label>]   例 tenant:<parent>:anthropic:kyberion-sub
custody:          person | tenant
owner:            person の principal id | tenant slug
service:          anthropic（API）| claude-subscription（setup-token）
kind:             api_key | subscription_token
terms:            commercial | consumer           （api_key は commercial 固定）
plan:             api | team | enterprise | pro | max | ultra
token_expires_at: subscription_token のみ（登録時に入力、既定 登録日+365日）
```

値の保管場所（どちらも gitignore 済みの tier）:

- person: `knowledge/personal/connections/<service>[.<label>].json`（既存の場所）
- tenant: `knowledge/confidential/<owner>/connections/<service>[.<label>].json`（新設）

### 2.2 貸し出し（allocation）

既存の `credential.use` 割り当てに次を持たせる。

```
credential_ref        どの資格情報か
borrower_tenant       どのテナントの仕事に使うか（= binding のテナント）
allowed_backends      [claude-cli, anthropic, …]
budget_monthly_usd    任意。80% で通知、100% で以後の起動を止める（credential_grant として分類）
```

既存の割り当ては `custody=person, kind=api_key, credential_ref=person:<operator>:<provider>` として読み替える（動きは変わらない）。

### 2.3 貸し出せる範囲（eligibility）

| kind / terms                                                                         | 貸し出せる borrower_tenant                                                                                                                                                                                                                                                       | 判定に失敗したとき                  |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| api_key / commercial                                                                 | 持ち主の承認と、borrower 側の provider attestation があればどのテナントにも                                                                                                                                                                                                      | `[CREDENTIAL_ATTESTATION_REQUIRED]` |
| person が持つ subscription_token（Pro/Max/Ultra、Team/Enterprise の席も含む）        | **持ち主本人の個人テナントだけ**（テナントの `personal_owner` がその person で、その設定の承認が確かめられるもの。`pnpm tenant personal-owner` で本人の承認を得て設定する。member registry の owner や assigned_role は数えない）。person の資格情報に契約元テナントの経路はない | `[CREDENTIAL_KIND_NOT_ELIGIBLE]`    |
| tenant が持つ subscription_token / commercial（会社が登録した Team/Enterprise の席） | 持ち主テナント自身の仕事だけ（契約元テナント = 持ち主テナント）。**別テナントへの貸し出しは不可**                                                                                                                                                                                | `[CREDENTIAL_KIND_NOT_ELIGIBLE]`    |

判定は**承認の時点と使用の時点の両方**で行う（承認後にテナントの `personal_owner` が外されたり、承認の裏付けのない手書きの値だったりすれば、使用時に止まる）。会社が席やキーを使うときは、そのテナントの owner がテナントの資格情報として登録する（値や条件の差し替えには owner の承認が要る）。

### 2.4 承認

| 承認               | 誰が                                                          | 既存の仕組み                                          |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------- |
| 貸し出しの承認     | 資格情報の持ち主（person 本人、または持ち主テナントの owner） | `credential.use`（30 日、`grant_extension` で延長）   |
| データの送信の同意 | borrower テナント                                             | provider attestation（training_use）＋ egress overlay |

- 持ち主と borrower が同じ person（家での個人開発）の場合も承認は記録する。要求者と承認者の分離（SoD）は、既存の personal consent の規則（`a0ecc32df`）に従う。
- subscription_token は 1 年の期限を持つ。`token_expires_at` の 30 日前から通知する（`credential.use` の 7 日前通知とは別）。

### 2.5 テナントをまたぐ読み出し

tenant custody の資格情報を別テナント（borrower）の実行で使うとき、値の読み出しは**仲介（broker）を通し、必ず監査する**（`credential.lent_read`: credential_ref, borrower_tenant, mission/task, grant id）。値は borrower 側の保管場所に書かない。binding の secrets に入るだけ。

## 3. binding の出力（2 つの実装の境界）

binding（`withConfiguredTaskCredentials` → 組込みの資格情報の割り当て）は、claude 系の backend に対して次を返す。

```
secrets:
  api_key            → ANTHROPIC_API_KEY
  subscription_token → CLAUDE_CODE_OAUTH_TOKEN
providerEnvironments.claude:
  HOME              = active/shared/cache/<tier>/<borrower_tenant>/provider-auth/claude/<credential hash>/home
  CLAUDE_CONFIG_DIR = $HOME/.claude
credentialKind: api_key | subscription_token     （spawn 側が起動引数を選ぶため）
```

- プロバイダ環境には秘密の値を入れない（`credential-binding.ts:332-339` の禁止を守る）。
- HOME は `provider-auth-home.ts` の規則（テナントの非 public tier の cache 配下、リンク禁止など）に従う。資格情報ごとに分けるので、同じテナントでも資格情報が変われば設定も分かれる。

## 4. claude CLI の起動（binding 下）

| 項目           | api_key                                                                                                                                                                                                                                                     | subscription_token                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 共通           | `--setting-sources ''` `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` `--settings '{"disableAllHooks":true}'`、cwd = テナントの作業用ディレクトリ（`createScratchWorkspace`）、`DISABLE_AUTOUPDATER=1` `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | 同左                                             |
| 追加           | `--bare`（Keychain と OAuth を読まない）                                                                                                                                                                                                                    | `--bare` は付けない（トークンを無視するため）    |
| 環境に通すもの | HOME、CLAUDE_CONFIG_DIR、ANTHROPIC_API_KEY                                                                                                                                                                                                                  | HOME、CLAUDE_CONFIG_DIR、CLAUDE_CODE_OAUTH_TOKEN |
| 落とすもの     | CLAUDE_CODE_OAUTH_TOKEN、ANTHROPIC_AUTH_TOKEN、その他のプロバイダのキー                                                                                                                                                                                     | ANTHROPIC_API_KEY、ANTHROPIC_AUTH_TOKEN、その他  |

- delegate・stream・prompted-tools の**全経路**に適用する。binding が無い実行（operator 自身の作業）は今のまま。
- **canary**: binding 下で資格情報を渡さずに起動したら必ず失敗すること（隔離した `CLAUDE_CONFIG_DIR` には保存済みログインが無い）。単体テスト（spawn 引数と環境の検査）と、`pnpm doctor` の実機確認（`claude` を隔離環境で起動し、未ログインで失敗することを確かめる）の 2 つで守る。

## 5. プロバイダの識別子

- 「claude」を事業者（Anthropic）の識別子とする。`claude-cli`（CLI）と `anthropic`（API）はその実行手段（reasoning backend）。
- `reasoning-providers/anthropic.json` に `egress_provider_id: "claude"` を足し、attestation と egress overlay が両方の実行手段に効くようにする。
- `claude-subscription` を資格情報の service として登録する（API 証明 `api_proof` は持たない。kind=subscription_token）。

## 6. 利用量の台帳

- 起動・executor の 1 回ごとに `{borrower_tenant, credential_ref, kind, backend, input_tokens, output_tokens, est_cost_usd, at}` を記録する（tenant tier の runtime 台帳。保持期間は storage-retention-catalog に従う）。
- Chronos の月次ジョブで borrower ごと・資格情報ごとに集計し、`budget_monthly_usd` の 80% で通知する。Team の API クレジット（上限 $500/月）の使い過ぎの早期警告に使う。

## 7. CLI

```
# 資格情報の登録（値は表示しない入力）
pnpm kyberion reasoning credentials register --custody person|tenant [--owner <tenant>] \
  --service anthropic|claude-subscription [--label <l>] [--plan api|team|enterprise|pro|max] [--token-expires <YYYY-MM-DD>]

# 貸し出しの申請 → 承認 → 確定
pnpm kyberion reasoning credentials assign --tenant <borrower> --credential <credential_ref> \
  --backends claude-cli,anthropic [--budget-usd <n>] --purpose "<why>"
pnpm kyberion approvals --approve <id>
pnpm kyberion reasoning credentials assign … --approval <id>

# 延長・状態・利用量
pnpm kyberion reasoning credentials extend --tenant <borrower> --grant <GRT-…>
pnpm kyberion reasoning credentials allocations --tenant <borrower>
pnpm kyberion reasoning credentials usage --tenant <borrower> [--month YYYY-MM]
```

既存の `--provider anthropic` は `--credential person:<operator>:anthropic` の省略形として残す。

## 8. 実装の分担（並行作業の境界）

| 担当                      | 範囲                                                                                        | 主なファイル                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: 起動の隔離             | §4、canary、環境の許可リスト、spawn 時の credentialKind による引数の切り替え、doctor の確認 | `libs/core/shell/shell-claude-cli-backend.ts`、`provider/provider-permission-profiles.ts`、`provider/provider-spawn-env.ts`、`scripts/doctor*`                                                                                                     |
| B: 持ち主・種類・貸し出し | §2、§3（binding の出力）、§5、§6、§7、概念文書                                              | `secret/credential-allocations.ts`、`governance/grant-store.ts`（必要最小限）、`reasoning/reasoning-api-credentials.ts`、`reasoning-providers/*.json`、`scripts/reasoning/*`、`stance-tenant-customer-model.md`、`concept-registry.json`、GLOSSARY |

A と B の境界は §3 の binding の出力だけ。A は §3 の形を入力として受け取り、B は §3 の形を出力する。

## 9. 確認の計画

| 確認                  | どこで         | 何をもって成功とするか                                                                                                                     |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 単体・結合テスト      | CI             | 種類ごとの eligibility、テナントをまたぐ読み出しの監査、binding の出力、spawn の引数と環境、canary                                         |
| canary（実機）        | 会社・家の端末 | 隔離環境で資格情報なしに起動すると必ず失敗する                                                                                             |
| hooks が入り込まない  | 実機           | テナントの実行でリポジトリの hooks が起動しない（監査ログに当該実行の session_hook 行が出ない）                                            |
| 会社の Dot が一周回る | 会社の端末     | 親会社テナントの Dot が API キーで推論 → 提案 → executor まで進む。子会社テナントの Dot が貸し出しで同じく進む                             |
| 家の Dot が一周回る   | 家の端末       | 開発用テナントの Dot が Pro の `setup-token` で一周回る。会社テナントに同じトークンを割り当てようとすると `[CREDENTIAL_KIND_NOT_ELIGIBLE]` |
| 延長                  | 実機           | 延長の申請 → 承認で期限だけが延び、Grant の ID が変わらない                                                                                |

## 10. 範囲外（同じ形で後から足す）

- Codex（`CODEX_ACCESS_TOKEN` / API キー、`CODEX_HOME`）、Cursor（`CURSOR_API_KEY`）、agy（`GEMINI_API_KEY` + `modelProvider`、ADC）。資格情報の種類と eligibility、隔離の考え方は本設計と同じ。違うのは環境変数と設定ディレクトリだけ。
- Anthropic の Admin API によるキーの自動発行・失効。

## 11. 未確認の点

- `setup-token` の取り消し方法（公式ドキュメントに記載なし）。
- `--bare` が `~/.claude/settings.json` を読まないか（HOME を隔離するので影響しない想定。§9 の実機確認で確かめる）。
- 24 時間動く Dot が購読の「通常の利用」に含まれる範囲。個人開発の範囲に限り、会社・顧問先には API キーを使う方針で回避する。

## 運用手順

準備から日々の運用までの流れは [reasoning-credential-lending-playbook](../../../knowledge/product/orchestration/reasoning-credential-lending-playbook.ja.md) を参照。
