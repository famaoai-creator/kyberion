---
title: '人間承認の信頼性 改善計画 (HA-01〜08)'
tags: [improvement-plan, governance, approval, authn, security]
last_updated: 2026-10-10
status: partial
---

# 人間承認の信頼性 改善計画 (HA-01〜08)

- 状態: **HA-01〜06 実装済み(#1033、#1037)、HA-07〜08 は本 PR で実装**(残りは §6 の「HA-07〜08 の補足」)
- 発端: PR #915 のレビューで「`pnpm kyberion approve` は端末上の任意の呼び出し元を認証済みの人間として記録する」ことが残課題になった。調査の結果、問題は CLI だけではなく承認経路全体に共通していると分かった。
- 関連:
  - [AUTONOMOUS_OPERATION_MOBILE_DECISION_PLAN](../improvement-plans-2026-09/AUTONOMOUS_OPERATION_MOBILE_DECISION_PLAN_2026-09-27.ja.md) の P5(passkey 承認)
  - [ACCOUNTABILITY_CHARTER_PLAN](../improvement-plans-2026-09/ACCOUNTABILITY_CHARTER_PLAN_2026-09-30.ja.md)(責任者は認証済みメンバー)
  - [passkey-push-protocol](../../../knowledge/product/architecture/passkey-push-protocol.md)(HA-07 で実装)
  - [authn-authz-seams](../../../knowledge/product/architecture/authn-authz-seams.md)

## 0. 問題

`finalDecision: 'human_only'` は「人間しか確定できない決定」を表す。対象は次のとおり。

- mission の scope-approve と reconcile
- dot の隔離解除
- dual-key シークレット
- plugin のインストール
- project の trust
- decision card (`decide`)
- そのほか約 20 箇所

ところが、これらが「人間が決めた」と判断する根拠は、**呼び出し元が自分で申告した `decidedByType: 'human'` と `authenticated: true` だけ**になっている。

- `validateHumanFinalDecision`(approval-store.ts)の検査は、`authMethod === 'local_token'` を拒否することだけ。
  - `authMethod` が未指定でも、`manual` でも通る。
- `payloadHash` と `effectBinding` は、ほぼすべての呼び出し元が承認レコード自身の値をそのまま渡している。
  - そのため、人間が実際に見た内容と照合できていない(自己照合)。
- passkey、WebAuthn、TOTP の検証器は存在しない(型の上だけにある)。
- 「プロバイダ CLI(Claude Code、Codex など)の配下で動いているか」を判定する共通ヘルパがない。

### 経路ごとの現状

| 経路                                                     | 記録される内容                                                         | 実際の認証                                                                                                            | 深刻度                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| MCP `kyberion.approval.decide` → approval-cowork-adapter | human / authenticated / authMethod なし / decidedBy は呼び出し元が指定 | **なし**(エージェント向けツール)                                                                                      | **最重大**: エージェントが human_only を確定できる |
| approval-actuator `decide` op                            | 呼び出し元が渡した値をそのまま記録                                     | **なし**                                                                                                              | 重大                                               |
| `pnpm kyberion approve` / `approvals --approve`          | human / authenticated / `manual`                                       | **なし**(TTY もプロバイダ CLI も検査しない)                                                                           | 重大                                               |
| Concierge、Chronos、Presence Studio                      | `surface_session`                                                      | cookie セッション、または localadmin bearer、または loopback。Chronos はメンバー解決に失敗すると sovereign 扱いになる | 中                                                 |
| Slack、Telegram、Discord、iMessage                       | authMethod 未指定                                                      | チャネルの本人性(iMessage は偽装可能)                                                                                 | 中(記録が区別できない)                             |
| brief (serve-brief)                                      | `local_token`、decidedBy は body 由来                                  | ローカルトークン                                                                                                      | 低(human_only では拒否される)                      |
| veto window、シークレットの自動承認                      | service / false                                                        | —                                                                                                                     | 問題なし                                           |

## 1. 目標

1. **エージェントは human_only を確定できない**。
   - エージェント向けの経路(MCP、actuator、プロバイダ CLI 配下のシェル)からの human_only 決定は、構造的に拒否する。
2. **人間の証明は、強度つきで記録する**。
   - `authMethod` を必須にする。
   - 決定ごとに必要な最低強度(assurance)を宣言し、validator が allow-list で検査する。
3. **人間が見た内容に束縛する**。
   - `payloadHash` と `effectBinding` は、決定者に提示したもの(または署名したもの)から作る。
4. **強い手段を 1 つ実装する**。
   - passkey(WebAuthn)を実装して、高リスクの human_only の既定にする。

## 2. 設計

### 2.1 Assurance level(新規)

| level | 受け入れる authMethod                                                                | 用途の例                                                          |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `A0`  | なし(service や veto)                                                                | human_only では不可                                               |
| `A1`  | `channel_identity`(Slack などのチャネル本人性)、`surface_session`(cookie セッション) | 通常の decision card                                              |
| `A2`  | `surface_session` + メンバー解決済み、`terminal_attested`(後述)、`totp`              | dot の隔離解除、scope-approve、plugin のインストール              |
| `A3`  | `passkey`(WebAuthn assertion を検証済み)                                             | dual-key シークレット、policy や charter の変更、project の trust |

- `ApprovalRecord.accountability.min_assurance` を追加する。
  - 既定は、human_only なら `A2`、dual-key なら `A3`。
- `validateHumanFinalDecision` を変更する。
  - `authMethod` の allow-list を使って、`min_assurance` 以上であることを検査する。
  - authMethod が未指定なら拒否する。
- `localadmin` の bearer token は `surface_session` とみなさない。
  - 新たに `local_admin_token`(A1 相当)として区別する。
  - Chronos がメンバー解決に失敗したときの sovereign フォールバックは、human_only では拒否する。

### 2.2 エージェント経路の遮断

- 共通ヘルパ `detectAgentExecutionContext()` を新設する(`libs/core/agent-execution-context.ts`)。
  - 判定材料: `CLAUDECODE`、`CODEX_*`、`TERM_PROGRAM=codex`、agy / gemini / grok のマーカー、agent-token / agent-context の principal、`KYBERION_AGENT_*`。
  - 既存のばらばらな判定(claude-agent.ts、image-generation-bridge.ts)も、このヘルパに寄せる。
- 以下の経路は、human_only 決定を `[APPROVAL_HUMAN_PROOF_REQUIRED]` で拒否する。
  - MCP `kyberion.approval.decide` と approval-actuator `decide`。
  - 通常の決定(human_only でないもの)は従来どおり受け付けるが、`decidedByType: 'agent'` で記録する。
- CLI の `approve` / `approvals --approve` は次のとおりにする。
  - エージェント実行コンテキストでは、human_only を拒否する。
  - そうでなければ、対話的な **端末アテステーション** を要求する(stdin と stdout が TTY であること、かつ決定内容のハッシュを短いコードで提示して人間に入力させるチャレンジ)。
    - これを通れば `terminal_attested`(A2)。
    - それ以外は `manual`(A1、human_only では不可)。
  - 非対話(CI など)で human_only を承認したい場合は、passkey 経路に誘導する。

### 2.3 提示内容への束縛

- 各サーフェスは、決定画面を描画するときに **提示ダイジェスト**(表示した action、target、effect の正規化ハッシュ)を作り、決定リクエストに含める。
  - 対象: Concierge、Chronos、CLI、ブリッジ。
- validator は、提示ダイジェストと `record.accountability.payloadHash` の一致を検査する。
  - これにより自己照合をやめる。
- ブリッジは、カード生成時のダイジェストをカードの action id に埋め込む。

### 2.4 passkey 実装(A3)

- `passkey-push-protocol.md` の設計に沿って、Concierge PWA に WebAuthn 登録と assertion を実装する。
  - challenge = 提示ダイジェスト + request id + 有効期限。
- サーバ側の検証器は `libs/core/authn/webauthn-verifier.ts` に置く。
  - 依存は CBOR / COSE の最小実装、または既存の依存。
  - 依存を追加する場合は lockfile review を行う。
- 登録済みの認証器は `knowledge/personal/` 配下に置く。
  - メンバー単位で、公開鍵のみ。
- CLI からの A3 承認は、push 通知 → PWA で assertion → 署名済みの決定を store に書く、という流れにする。

## 3. タスク

| ID    | 内容                                                                                                                              | 主なファイル                                                        | 依存         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------ |
| HA-01 | `detectAgentExecutionContext()` を新設し、既存の判定を集約                                                                        | 新規 `agent-execution-context.ts`                                   | —            |
| HA-02 | MCP `kyberion.approval.decide` と approval-actuator `decide` で human_only を拒否し、それ以外は agent として記録                  | mcp-server-engine.ts、approval-cowork-adapter.ts、approval-actuator | HA-01        |
| HA-03 | assurance level と `min_assurance` を導入。validator を allow-list 化し、authMethod 未指定は拒否                                  | approval-store.ts と各 human_only 生成箇所                          | —            |
| HA-04 | CLI の端末アテステーション(`terminal_attested`)と、エージェント実行コンテキストでの拒否                                           | scripts/cli.ts、kyberion_home.ts                                    | HA-01、HA-03 |
| HA-05 | サーフェスの authMethod を正確化(`local_admin_token`、`channel_identity`、Chronos の sovereign フォールバック廃止)                | concierge、chronos、presence-studio、surface-approval-ui            | HA-03        |
| HA-06 | 提示ダイジェストへの束縛(自己照合の廃止)                                                                                          | 各サーフェスと validator                                            | HA-03        |
| HA-07 | WebAuthn passkey(PWA 登録と assertion、サーバ検証)を実装し、A3 を既定化                                                           | concierge PWA、authn/webauthn-verifier.ts                           | HA-03、HA-06 |
| HA-08 | 移行: 既存の pending な human_only の扱い、警告モード → 強制モード(`KYBERION_APPROVAL_ASSURANCE=warn\|enforce`)、ドキュメント更新 | env-registry、approval-gate-design.md                               | 全部         |

- HA-01〜03 は小さく、効果が最も大きい(最重大のギャップを塞ぐ)。最初の PR はこの 3 つにする。
- HA-04〜06 は 2 本目の PR、HA-07 は 3 本目の PR に分ける。

## 4. 移行と互換

- まず `KYBERION_APPROVAL_ASSURANCE=warn` で導入する。
  - 不足があった決定は通すが、監査に `assurance_shortfall` を記録し、運用者に通知する。
- 2 週間の観測で warn ログを確認してから、`enforce` に切り替える。
  - 例外: HA-02(エージェント経路の遮断)は**最初から enforce** にする。安全側の変更で、人間の正規の経路を壊さないため。
- 既存の pending な human_only の扱い:
  - 導入時点でまだ決定されていないものは、新しい validator で評価する。
  - 決定済みのものは遡及しない。
- dot の隔離解除の再検査(`applyApprovedDotReleases`)は、`decidedAuthMethod` の assurance も見るようにする。

## 5. 決定事項(2026-10-05 レビュー)

1. **CLI の端末アテステーション** — 5.1 の方式を A2 とする。**決定: OK**(限界: 同じ OS ユーザーで動く悪意あるプロセスには耐えないため、侵害耐性が必要な決定は A3 のみとする)。
2. **localadmin bearer token** — human_only では使えなくする。**決定: はい**(HA-05)。
3. **WebAuthn の依存** — どちらでもよい。**決定: `@simplewebauthn/server` を採用し、lockfile review を行う**(自作の CBOR/COSE 実装は保守の負担になるため)。
4. **強制までの期間** — 変更してよい。**決定: warn で 1 週間 → enforce**。ただし HA-02(エージェント経路の遮断)は最初から enforce にする。warn のあいだに `assurance_shortfall` が残っている経路が出たら延長する。

### 5.1 端末アテステーション(提案方式)

`pnpm kyberion approve <id>` が human_only の決定に対して行う処理は次のとおり。

1. **エージェント実行コンテキストなら拒否する。**
   `detectAgentExecutionContext()` が真のときは `[APPROVAL_HUMAN_PROOF_REQUIRED]` で止める。判定材料は次のとおり。
   - プロバイダ CLI の環境マーカー(`CLAUDECODE`、`CODEX_*` など)
   - agent principal
   - 親プロセスの系譜(プロバイダ CLI の子孫か)
2. **TTY であることを要求する。** stdin と stdout がともに TTY でなければ拒否する。パイプ、CI、バックグラウンド実行は対象外になる。
3. **内容に束縛したチャレンジを出す。** 次の 3 つを表示する。
   - 決定内容の要約(action、target、tenant、effect)
   - 提示ダイジェスト(HA-06)
   - 提示ダイジェストと nonce から作った **ランダムな 6 文字の確認コード**

   人間はそのコードを打ち返す。コードは 60 秒で失効し、1 回だけ使える。
   - コードを毎回変えるので、決まった文字列をパイプで流し込む操作はできない。
   - 表示された内容を読まずに承認することも防げる。

4. **成功したら記録する。** `authMethod: 'terminal_attested'`(A2)と、`decidedBy` = OS ユーザー + onboarding の operator id を記録する。端末の情報(tty 名、親プロセスの系譜)は監査用の証跡に残す。

限界:

- 同じ OS ユーザー権限を持つ悪意あるプロセスは、疑似端末(pty)を作って画面を読み、コードを入力できる。したがって A2 は「誤操作とエージェントの自走を防ぐ」強度であり、「侵害された端末に耐える」強度ではない。
- 侵害に耐える必要がある決定(dual-key、policy の変更など)は、A3(passkey)だけにする。

## 6. 状況

| ID    | 状態                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HA-01 | **実装済み**。`libs/core/agent-execution-context.ts` の `detectAgentExecutionContext()`(env を注入可能)。判定材料は `KYBERION_AGENT_ID` / `KYBERION_NHI_ID` / `KYBERION_RUN_ORIGIN=agent`、reasoning-provider レジストリの `cli.session_markers`(agy-cli に `AGY_CLI` / `ANTIGRAVITY_CLI` を追加)、`AI_AGENT`、agent 種別の authn principal。`cli-operator-principal.ts`、`claude-agent.ts`、`image-generation-bridge.ts`、`scripts/generate_avatar.ts` の個別判定をこのヘルパに集約した                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| HA-02 | **実装済み(最初から enforce)**。`approval-cowork-adapter.ts`(MCP `kyberion.approval.decide`)と approval-actuator `decide` は human_only を approve / reject とも `[APPROVAL_HUMAN_PROOF_REQUIRED]` で拒否し、それ以外は `decidedByType: 'ai_agent'`、`authenticated: false` で記録する(呼び出し元の申告は無視)。共通の拒否は `approval-human-decision.ts` の `refuseHumanOnlyDecisionOnAgentPath`。MCP は拒否コードだけを wire に返す                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| HA-03 | **実装済み(既定は warn)**。`libs/core/governance/approval-assurance.ts` に A0〜A3 と authMethod の allow-list を置いた。`min_assurance` は作成時に既定 A2、dual-key(approval-gate)は A3。`validateHumanFinalDecision` は authMethod 未指定・未知・`local_token` / `local_admin_token` を常に拒否し、水準不足は `KYBERION_APPROVAL_ASSURANCE=enforce` で拒否、warn では通してレコードとイベントに `assurance_shortfall` を残し監査と運用者通知を行う。チャットブリッジは `channel_identity`、presence のテキスト決定は `manual` を記録する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| HA-04 | **実装済み**。`pnpm kyberion approvals --approve/--reject` は human_only に対して既存の `cli_tty_challenge`(`scripts/lib/approval-cli-decision.ts`)を使う。エージェントのセッション内(環境マーカー・agent principal)とプロバイダ CLI の子孫プロセス(`providerHarnessInProcessLineage`、`libs/core/agent-execution-context.ts`。`ps -o command=` の完全なコマンドラインで pid 1 まで(上限 64 段)たどり、argv[0] と、node / bun / python などで包まれた場合はスクリプトを、バイナリ名とレジストリの `cli.install_path_markers`(`/@anthropic-ai/claude-code/` など)で照合する)は `[APPROVAL_HUMAN_PROOF_REQUIRED]` で拒否し、TTY でない場合も同じコードで拒否する(`cli-operator-principal.ts` は職務分離の設定にかかわらず human_only でこのコードを返す)。チャレンジは request id、提示ダイジェスト、有効期限を表示し、`sha256(nonce:digest:id:expiresAt)` の先頭 6 文字を確認コードにする(60 秒で失効、毎回変わる)。成功すると `authMethod: 'terminal_attested'`(A2)で決定し、`decidedBy` は onboarding の operator(`user:<member>`)、OS ユーザー・tty・親プロセスの系譜・提示ダイジェストは監査チェーンの `terminal_attested` に残す(`scripts/lib/cli-tty-io.ts` の `resolveCliTerminalEvidence`。テスト用の差し替えは、テストが明示的に組み込んだときだけ有効で、`VITEST` 環境変数だけでは実際の端末と親プロセスの調査を省かない)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| HA-05 | **実装済み**。`surfaceDecisionAuthMethod()`(`approval-assurance.ts`)で決める。検証済みセッション(`browser-session` / `oidc-jwt` / `registry-token`)からメンバーを解決したときだけ `surface_session`、localadmin bearer(`env-token`)とメンバー未解決(Chronos の sovereign フォールバック)は `local_admin_token`、資格情報なしの loopback(Presence Studio の承認 inbox)は `manual`。Concierge(承認・plugin)、Chronos(`api/intelligence/actions.ts`)、Presence Studio に適用。チャットブリッジは `channel_identity` のまま                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| HA-06 | **実装済み(既定は warn)**。`libs/core/governance/approval-presentation.ts` の `computeApprovalPresentedDigest()`(既存の `computeApprovalPayloadHash` の正規化を再利用。request id、title、summary、details、target、tenant、kind、channel、severity、sourceText、requestedAt、expiresAt、organization、要求者(requestedBy、表示名、requestedByContext 全体。Chronos はここの tenant も読む)、justification 全体、risk 全体、track、work_loop 全体(Chronos の work loop 表示が出す intent、execution shape、outcome、team、authority、project、tenant。作成時に決まり、その後は変わらない)、workflow の形(mode、requiredRoles、stages)、steering の内容(mission の verb と missionId、held effect の op と束縛。返信先の surface、thread、correlation は含めない)、veto の固定値、decision card の表示内容(question、recommendation、risk、reversible、deadline、evidence)、payloadHash、effectBinding を覆い、表示したものと違う内容に束縛できないようにする。対象のサーフェスは Chronos、Concierge、Presence Studio、Slack、チャットのテキスト / カード、CLI。表示はしても含めないのは、保留中に変わる値(workflow の approvals と currentStage、veto の配信時刻とそこから導く「応答がない場合」の文言、status)と、レコードの外の文脈(会話ターンの intent 契約、蒸留済みのタイトル、mission の状態から読んだ tenant)だけ)。Chronos の承認ワークスペースは tenant を `scope.tenant_slug` から優先して読み、要求に書かれていない mission 由来の tenant には「ミッションから取得・要求には未記載」と付けて表示する。project は `work_loop.context.project_id` から読む。各サーフェスは描画時にダイジェストを付けて送り、決定時に送り返す(Concierge、Chronos、Presence Studio、CLI)。チャットはカードの action id に 12 桁の短縮ダイジェストを入れる(`appr:<id>:approve:<12hex>`、Telegram の 64 バイト制限内)。短縮形を受け付けるのはチャットブリッジのコールバック経路だけで(`resolveCompactPresentedDigest` が全桁に展開する)、store と HTTP の経路は全桁しか受け付けない。Slack はボタン値に全桁を入れる。store(`bindPresentedDecision`、`approval-human-decision.ts`)は記録から再計算して照合し、不一致は `[POLICY_VIOLATION]` で拒否する。ダイジェストのない human_only の決定は warn では監査(`presented_digest_missing`)して通し、enforce では拒否する |
| HA-07 | **実装済み(本 PR)**。`libs/core/authn/webauthn-verifier.ts`(`@simplewebauthn/server`)で登録と assertion を検証する。承認のチャレンジ(`governance/approval-passkey-challenge.ts`)は request id、決定、提示ダイジェスト、期限、nonce を束ねた文字列の `sha256` を base64url にしたもので、単回・120 秒(依頼の期限より後にはならない)、approval store の `passkey-challenges/` に保存する。検証は rpID / origin(`KYBERION_OIDC_PUBLIC_BASE_URLS` の `concierge=` か `KYBERION_OIDC_PUBLIC_BASE_URL`、loopback だけリクエストの origin)、チャレンジ、期限、未使用、資格情報の持ち主、署名カウンタの前進(後退は拒否)、UV 必須。store は `authMethod: 'passkey'` の決定で検証済みチャレンジを消費し、ダイジェストが一致したときだけ記録する(`settlePasskeyDecisionProof`)。資格情報は `knowledge/personal/members/{id}/passkeys.json`(公開鍵、カウンタ、transports、ラベル、作成日時)で、一覧・削除できる。Concierge は 設定 › プロフィール › パスキー で登録し(`/api/me/passkeys`)、`min_assurance` が A3 の承認カードはパスキーで決める(`/api/approvals/{id}/passkey`)。member はサーバー側で解決する。A3 の既定: dual-key、`approval-policy.json` の rule の `min_assurance`(secret の付与・vault 直接書き込み・権限付与・`config-policy-update`)、project trust(作成時と、決定時のチャネル下限)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| HA-08 | **実装済み(本 PR)**。モードは `approval-policy.json` の `assurance_mode`(出荷時 `warn`、schema に追加)から読む。`KYBERION_APPROVAL_ASSURANCE=enforce` は締める方向だけに効き、policy の `enforce` を緩められない(エージェントが外せないように)。policy が読めないときは `enforce`。未決の human_only は決定時の validator で判定し(`min_assurance` の無い旧レコードは A2、project trust はチャネル下限で A3)、決定済みは再判定しない。warn の不足は従来どおり `assurance_shortfall` を監査と運用者通知に残し、Concierge の承認カードには `min_assurance` を出す                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

HA-01〜03 の補足:

- `surface_session` は「サーフェスが検証済みセッションからメンバーを解決した」前提で A2 とした。localadmin bearer と Chronos の sovereign フォールバックを `local_admin_token` に移すのは HA-05 で行う。
- 決定済みレコードを効果適用時に再検査する箇所(scope-approve、reconcile-work、EG-11、SA-01、provider attestation)は `phase: 'recheck'` で呼ぶ。assurance は決定時に判定済みとして再判定しない(§4 の「遡及しない」)。それ以外の規則は再検査する。
- 要求側は human_only の `min_assurance` を引き上げられるが、A2 未満には下げられない(作成時に A2 へ引き上げる)。
- Cloudflare OS の held action は `HeldActionDecision.authMethod` を承認ストアへ引き渡す。Presence Studio からの決定はメンバー解決後なので `surface_session` とする。
- A3 を要求するのは現時点では dual-key のみ。project の trust、policy や charter の変更を A3 にするのは、passkey 経路(HA-07)ができてからにする。それまでに enforce にすると承認できなくなるため。
- HA-04 のうち「エージェント実行コンテキストでの拒否」は 1 本目の PR で前倒しした。端末アテステーションは 2 本目の PR で入れた(HA-04 の行を参照)。
- レビューで残した課題:
  - **対応済み(2 本目)**: `decideApprovalRequest` は、決定するプロセスがエージェント(`detectAgentExecutionContext().isAgent`)なら human_only を `[APPROVAL_HUMAN_PROOF_REQUIRED]` で拒否する(`refuseHumanOnlyDecisionByAgentProcess`)。除外するのは surface runtime が起動したサーフェスのサーバだけで、`SYSTEM_ROLE`(`buildSurfaceLaunchEnv` が設定)が人間の決定を受けるサーフェスの一覧(`HUMAN_DECISION_SURFACE_SYSTEM_ROLES`: chronos、concierge、presence-studio、operator-surface、各チャットブリッジ)にあり、かつ agent principal でないときに限る。`mcp_server_cowork` など人間の決定を受けないロールは除外しない。それ以外は拒否する(fail closed)。HTTP の決定経路は認証済み principal を `deciderPrincipal` で渡すので、agent token の principal はサーフェス内でも拒否される。
  - **対応済み(2 本目)**: warn で assurance が不足した決定は、セッションキャッシュに入れない。
  - 除外の判定は環境変数(`SYSTEM_ROLE`)に基づくため、マーカーと同じく助言的な強度にとどまる。エージェントのシェルから手で起動したサーフェスは除外されず、human_only を決定できない(fail closed)。
  - warn / enforce は決定するプロセスの環境変数から読むため、エージェントが外せる。HA-08 で、モードを統治されたポリシーから読むように移す。
- 拒否メッセージの次の手順は、署名済みの Concierge / Chronos のセッションか、端末のチャレンジを案内する。Presence Studio は `manual`(A1)として記録され、enforce では拒否されるため、案内しない。
- **未移行**: deliverable-inbox の受け入れ(`acceptInboxEntryWithHumanReceipt`)は、まだ `surface_session` を固定で記録している。承認ストアとは別のスキーマ(`surface_session | totp | passkey`)のため、2 本目では移していない。該当箇所: Concierge `api/outcomes/[id]/route.ts:81`、Chronos `api/deliverable-review/route.ts:55`、operator-surface `api/inbox/route.ts:44`。
- **未移行**: mission steering の承認要求(`surface-mission-steering.ts` の `buildSteeringApprovalRequest`)には `payloadHash` / `effectBinding` を付けていない。付けると、ダイジェストもハッシュも送らない決定経路(warn の間に残る旧クライアント)が「payload hash does not match」で拒否されるため。verb と missionId は提示ダイジェストが覆うので、ダイジェスト付きの決定は表示した内容に束縛される。
- **受け入れた残存リスク(2 本目の時点)**:
  - 親プロセスのコマンドラインは空白で区切って解釈する。空白を含むパスにインストールされた CLI は、最初の空白で切れるため検出できない(環境マーカーによる検出は残る)。
  - `SYSTEM_ROLE` による除外と、呼び出し元が申告する `authMethod` は、同じプロセス内では助言的である。プロセス内で動くエージェントは、どちらも申告できてしまう。検証可能な証跡(署名済みの assertion)は passkey(HA-07)で入る。
  - loopback / `manual` の決定(Presence Studio の承認 inbox など)は、enforce になるまでは human_only を監査記録つき(`assurance_shortfall`)で確定できる。enforce(HA-08)で拒否される。

HA-07〜08 の補足:

- charter の受け入れは approval store を通らないため、A3 をまだ適用していない(製品判断が必要)。
- HA-07 以前に gate が作った未決の依頼も、決定時に今の policy の下限で判定する。gate の依頼は `policy_rule_id`(無い旧レコードは effect binding = intent id)で rule を引き、`min_assurance` と dual-key(= A3)の強い方と作成時の値の高い方を使う。payload 条件は記録されないため、effect を挙げる rule はすべて数える(強い側に倒す)。
- パスキーの登録・削除は本人のブラウザ / OIDC セッションだけ(registry token・資格情報の無い loopback・agent は拒否)。使えるパスキーがあれば step-up(目的・member・対象・nonce に束ねた単回 120 秒。検証したブラウザにだけ単回の token を返し、変更はその token を要求する)が要り、step-up 無しの登録は `passkey_enrollment_cooldown_hours`(既定 24、最小 1)の間 A3 に使えない。使えるパスキーが無い間に最初に登録した者が勝つ bootstrap race は残り、cooldown と通知で緩和する。登録・削除は audit と operator 通知に残す。
- staged workflow の後段承認もパスキーで決められる(依頼が approved でも workflow の承認が残っている間はチャレンジを発行する)。
- パスキーファイルは runtime floor に分けず personal 層に残した。分けるには security-policy・role-write-access・保護プレフィックスの変更が要るため。personal 層は gitignore 済みで、knowledge index(`.md` だけ)・`generate_knowledge_index`(personal を除外)・tenant ingest(members を読まない)の対象外。`sovereign_concierge` の読み書き権限はテスト(`passkey-credential-authority.test.ts`)で固定した。
- CLI 起点の Push から PWA で署名して CLI に戻す往復は未実装。A3 の決定は Concierge の承認キューで行う。
- rpID / origin は環境変数の公開 origin から取り、Concierge に保存した OIDC 設定は参照しない。
- enforce への切り替え(§5 の 4)は、warn の期間に `assurance_shortfall` を確認してから `assurance_mode` を変更して行う。
