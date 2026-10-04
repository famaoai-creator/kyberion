---
title: '人間承認の信頼性 改善計画 (HA-01〜08)'
tags: [improvement-plan, governance, approval, authn, security]
last_updated: 2026-10-05
status: planned
---

# 人間承認の信頼性 改善計画 (HA-01〜08)

- 状態: **計画確定(実装待ち)**
- 発端: PR #915 のレビューで「`pnpm kyberion approve` は端末上の任意の呼び出し元を認証済みの人間として記録する」ことが残課題になった。調査の結果、問題は CLI だけではなく承認経路全体に共通していると分かった。
- 関連:
  - [AUTONOMOUS_OPERATION_MOBILE_DECISION_PLAN](../improvement-plans-2026-09/AUTONOMOUS_OPERATION_MOBILE_DECISION_PLAN_2026-09-27.ja.md) の P5(passkey 承認)
  - [ACCOUNTABILITY_CHARTER_PLAN](../improvement-plans-2026-09/ACCOUNTABILITY_CHARTER_PLAN_2026-09-30.ja.md)(責任者は認証済みメンバー)
  - [passkey-push-protocol](../../../knowledge/product/architecture/passkey-push-protocol.md)(設計のみ)
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

| ID        | 状態                                       |
| --------- | ------------------------------------------ |
| HA-01〜08 | 未着手(すべて決定済み。実装待ち) |
