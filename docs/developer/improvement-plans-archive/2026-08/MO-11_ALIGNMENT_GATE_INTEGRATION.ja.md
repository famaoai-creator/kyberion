---
title: MO 11 ALIGNMENT GATE INTEGRATION
tags: [improvement-plan, 2026-08]
last_updated: 2026-08-25
status: archived
---

# MO-11: アラインメント承認のゲート機構統合 — Sovereign 承認を第一級ゲートにする

> 優先度: **P2** / 規模: S〜M / 依存: MO-01(ミッションタイプ実効化)、MO-02(フェーズゲート)、MO-10(3層レジストリ・完了) / 後続: なし
>
> 起点: `origin/main` 合流時(2026-08-03)に、ローカル未コミットの `scripts/mission-alignment-gate/` と上流のゲートエンジンが同じ関心事に別方向から到達していることが判明。本計画はその整合統一。

## 背景

`scripts/mission-alignment-gate/`(未コミット)は、③アラインメントで整理したミッション計画を人間可読 HTML として Sovereign に渡し、編集・コメント・音声フィードバック付きで承認を得てから④実行に進む仕組み。`report-review` レイヤを流用している。

一方、上流には MO-01/MO-02 で**フェーズゲートエンジンが実装済み**であり、両者は接続されていない。alignment-gate は承認後に `mission_controller start` コマンドを**標準出力に印字するだけ**で、人間がそれを手で実行する。承認という最も価値のある証跡が、監査チェーンにもゲート記録にも載らない。

### 検証済みの現状(2026-08-03 時点)

| 要素                    | 実体                                                                                          | 出典                                        |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| ゲート定義の永続化      | `<missionDir>/gates/definitions/<GATE_ID>.json`(`plan-tasks` が phase_specs から生成)         | `libs/core/mission-process-planning.ts:114` |
| ゲート評価              | 14 種のチェック種別(`command_succeeds` / `reviewer_approved` / `evidence_exists` ほか)        | `libs/core/mission-gate-engine.ts:194-488`  |
| ゲート実行 CLI          | `mission_controller gate-pass <ID> <GATE_ID>`                                                 | `scripts/mission_controller.ts:1729`        |
| 状態遷移                | 初回ゲート通過で `planned` → `active`                                                         | `libs/core/mission-process-planning.ts:412` |
| ミッション初期状態      | `create` は `status: 'planned'` で生成                                                        | `libs/core/mission-creation.ts:340`         |
| `create` の物理影響範囲 | ミッション専用マイクロリポジトリ(`active/missions/<ID>/.git`)の `git init` + 初期コミットのみ | `libs/core/mission-git.ts:23`               |

### 発見1: 接合点は既に存在する — `status: 'planned'`

上流は `create` 直後のミッションを `planned` とし、**初回ゲート通過で初めて `active` に昇格**させる。これは alignment-gate が求める「ミッションは存在するが、まだ動いていない」状態そのものであり、「承認が起動ゲート」という設計思想を上流の状態機械が既に持っている。既存の `start` は即時 active 化の操作なので、このフローでは使用しない。

### 発見2: README の前提は過大評価だった

alignment-gate の README は「開始操作の前に承認しなければならない」としていた。しかし `create` が作るのは**ミッション専用マイクロリポジトリ**であり、**メインリポジトリのブランチ・作業ツリーには一切触れない**。planned 容器の作成を承認前に行っても、メインプロジェクトの Zero Physical Change は維持される。

したがって「承認は `start` の前」という制約は、それが守ろうとしている不変条件よりも強すぎる。順序を反転させても Zero Physical Change の精神は損なわれない。

### 発見3: `reviewer_approved` は現状ラバースタンプ

`gate-pass` は `humanConfirmed: true` を渡し、これが `reviewer_approved` の `params.approved` と `human_override` の `params.allow` を**自動的に真にする**(`mission-process-planning.ts:287-288`)。

```ts
if (humanConfirmed && check.kind === 'reviewer_approved') params.approved = true;
if (humanConfirmed && check.kind === 'human_override') params.allow = true;
```

つまり現在の `reviewer_approved` は「誰かが CLI を叩いた」という事実しか担保しない。**alignment-gate はこの形骸化したチェックに、編集・コメント・音声・タイムスタンプ・実施者付きの本物の Sovereign 判断を供給できる。** これは上流への一方的追従ではなく、上流の弱点を埋める貢献である。

### 発見4: サーフェス非依存の承認基盤が既に存在する

**承認は既に「どのサーフェスからでも下せる」形で実装されている。** alignment-gate 専用の HTML サーバを独立した承認窓口として立てるのは、この基盤と並列な第二の承認経路を作ることになり、誤りである。

| 層                 | 実体                                                                                                  | 出典                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 正本ストア         | `active/shared/coordination/channels/<ch>/approvals/requests/<id>.json`                               | `libs/core/approval-store.ts:355`             |
| イベントログ       | `active/shared/observability/channels/<ch>/approvals.jsonl`                                           | `libs/core/approval-store.ts:359`             |
| 生成 / 読取 / 決裁 | `createApprovalRequest` / `loadApprovalRequest` / `listApprovalRequests` / `decideApprovalRequest`    | `libs/core/approval-store.ts:363,659,668,710` |
| 人間性の強制       | `validateHumanFinalDecision` — `human_only` なら人間・認証済み・payloadHash・effectBinding 一致を要求 | `libs/core/approval-store.ts:325`             |
| 効果への束縛       | `computeApprovalPayloadHash`(正規化 JSON の SHA-256)                                                  | `libs/core/approval-store.ts:308`             |
| 事前執行ゲート     | 「承認が得られるまで統制対象操作をブロックする層」                                                    | `libs/core/approval-gate.ts`                  |
| サーフェス描画     | `surface-approval-ui.ts`(slack/telegram/discord/imessage/presence)、`slack-approval-ui.ts`            | `libs/core/surface-approval-ui.ts:18`         |

既に承認キューを表示・決裁しているサーフェス: **concierge**(`/api/approvals/[id]`)、**chronos-mirror-v2**、**presence-studio**、**ターミナル系**(`cli.ts` / `kyberion_home.ts` / `virtual_office.ts`)、**Slack**。

concierge の決裁実装が参照実装になる(`presence/displays/concierge/src/app/api/approvals/[id]/route.ts:34`):

```ts
decideApprovalRequest('sovereign_concierge', {
  channel,
  storageChannel,
  requestId: id,
  decision,
  decidedBy: 'concierge',
  decidedByRole: 'sovereign',
  authMethod: 'surface_session',
  decidedByType: 'human',
  authenticated: true,
  payloadHash: record.accountability?.payloadHash,
  effectBinding: record.accountability?.effectBinding,
});
```

### 当初案の欠陥 — 承認が brief に束縛されていない

初版の本計画は HTML の `data-decision` 属性を判定の正本にしていた。これには実害のある穴がある: **承認後に `mission-brief.json` を書き換えても、HTML は「承認済み」のまま**である。承認が「何を承認したのか」に束縛されていない。

`approval-store` は `computeApprovalPayloadHash` + `validateHumanFinalDecision` で既にこれを解決している。**HTML を正本にしてはならない。**

## 方針 — 方式B(改訂): 承認は approval-store が正本、HTML は描画の一つ

`command_succeeds` は「コマンドが exit 0 なら pass」であり(`mission-gate-engine.ts:237`)、**`humanConfirmed` による自動充足の対象外**。したがって新しいチェック種別を追加せずに、本物の承認判定をゲートに載せられる。ただし**判定の入力は HTML ではなく approval-store のレコード**とする。

```
③アラインメント
 1) mission_controller create <ID>         → status: planned(マイクロrepoのみ)
 2) brief.json を <missionDir>/evidence/mission-brief.json へ配置
 3) createApprovalRequest(kind: 'mission_gate')
      accountability.payloadHash = computeApprovalPayloadHash(brief)
      source = { missionId }
      → この時点で【全サーフェスの承認キューに同時に現れる】
 4) mission_controller plan-tasks <ID>     → gates/definitions/ALIGNMENT_APPROVED.json 生成
 5) Sovereign が【任意のサーフェス】で決裁:
      ├─ concierge 承認キュー        → POST /api/approvals/<id>
      ├─ chronos / presence-studio   → 既存キュー UI
      ├─ Slack                       → slack-approval-ui のボタン
      ├─ ターミナル (cli/home/office) → 既存 CLI
      └─ brief HTML (report-review)  → ✏️編集/💬コメント/🎤音声 つきの【リッチ描画】
                                        決裁は他と同じ decideApprovalRequest を呼ぶ
      いずれも decidedByType:'human' / authenticated:true / payloadHash を伴う
 6) mission_controller gate-pass <ID> ALIGNMENT_APPROVED
      → command_succeeds が判定コマンドを実行
      → loadApprovalRequest(...) が status==='approved'
        かつ payloadHash === computeApprovalPayloadHash(現在の brief) なら exit 0
      → planned → active に昇格(＝承認が起動ゲート)
④実行
```

**HTML サーバは承認チャネルではなく、承認リクエストのリッチなレンダラである。** 差分は「表示の豊かさ」(brief 全文・インライン編集・音声コメント)だけで、決裁の書き込み口・正本・監査経路は他サーフェスと完全に同一。

workflow-catalog に追加するフェーズ定義:

```json
{
  "id": "alignment",
  "title": "アラインメント承認",
  "kind": "judgment",
  "default_tasks": [
    {
      "task_id_suffix": "brief",
      "team_role": "planner",
      "description": "意図・測定可能ゴール・スコープ・体制・リスクを evidence/mission-brief.json に整理する",
      "acceptance_criteria": ["victory_conditions が測定可能", "scope.in/out が明示されている"],
      "expected_output_format": "structured",
      "estimated_scope": "S",
      "risk": "medium",
      "deliverable": "evidence/mission-brief.json"
    }
  ],
  "exit_gate": {
    "id": "ALIGNMENT_APPROVED",
    "checks": [
      { "kind": "evidence_exists", "params": { "path": "evidence/mission-brief.json" } },
      {
        "kind": "command_succeeds",
        "params": {
          "command": "node",
          "args": [
            "dist/scripts/mission_alignment_decision.js",
            "--mission",
            "<MISSION_ID>",
            "--strict"
          ]
        }
      }
    ]
  }
}
```

## サーフェス整合 — 決めるべき4点

### S-1. 承認レコードの `kind` を拡張する

現状 `kind: 'channel-approval' | 'secret_mutation'`(`approval-store.ts:147`)。ミッションゲート承認はどちらでもないので **`'mission_gate'` を追加**する。`listApprovalRequests({ kind })` で絞れるため、各サーフェスは「ゲート承認だけ」を出し分けられる。

### S-2. サーフェス識別子 — **決定: `'brief'` を追加する**(2026-08-03)

2 つの列挙があり、どちらにも brief HTML に相当する値がなかった:

- `ApprovalRequesterContext.surface`: `'slack' | 'chronos' | 'terminal' | 'presence' | 'api' | 'system'`(`approval-store.ts:52`)
- `SurfaceApproval`: `'slack' | 'telegram' | 'discord' | 'imessage' | 'presence'`(`surface-approval-ui.ts:18`)

`'presence'` の再利用(列挙を触らず安価)ではなく、**両列挙に `'brief'` を追加する**。承認の出所は監査の一次情報であり、presence-studio からの決裁と brief HTML からの決裁を監査上区別できないことは、列挙を触らない節約に見合わない。

波及範囲: 両列挙 + 契約 schema + 既存の網羅的 switch/マッピング。追加時は**既存サーフェスの挙動を変えないこと**を契約テストで固定する(新値は既存分岐にフォールスルーしない)。

### S-3. HTML サーバの認証を他サーフェスと揃える

| サーフェス          | 認証                                                           | `authMethod`      |
| ------------------- | -------------------------------------------------------------- | ----------------- |
| concierge           | `requireConciergeMutationAccess` + セッション                  | `surface_session` |
| report-review(現状) | 起動時生成トークン(`x-rv-token`)+ 127.0.0.1 束縛 + Origin 検査 | —(未接続)         |

report-review の姿勢は**ローカル運用としては妥当**(`server.ts:60-62,82`)だが、「起動時に印字されたトークンの所持」であって**同一性ではない**。`decideApprovalRequest` に `authenticated: true` を渡す資格をどこから得るかを決める必要がある。当面は `authMethod: 'local_token'` 相当を新設して**正直に弱い認証として記録**し、`human_only` を要求する高リスクゲートでは brief サーフェスからの決裁を許可しない、という段階運用を推奨する。

> 弱い認証を `surface_session` と偽って記録するのは絶対に避ける。監査証跡の意味が壊れる。

### S-4. 決裁の競合と冪等性

同じリクエストが全サーフェスに同時に現れる以上、**二重決裁が起こりうる**(Slack で承認した直後に HTML でも承認)。`decideApprovalRequest` は `status` が既に `pending` でないレコードをどう扱うか — 現状の挙動を確認のうえ、「最初の決裁が勝ち、以降は冪等に無視 or 明示エラー」を契約テストで固定する。

**また、要修正(`changes`)のコメントをどこに書くか**も揃える。HTML の音声・インラインコメントは brief 固有のリッチ入力だが、他サーフェスは `reasonCategory`(`RejectionReasonCategory`、LC-10 の閉じた語彙)+ `note` を使う。brief 側のリッチコメントは `note` に要約を、詳細は evidence に残し、**判定に使う語彙は他サーフェスと同一**にする。

## 実装上の落とし穴(検証済み)

### 1. `command_succeeds` の `args` はミッション相対に解決されない

`resolveGateCheckPaths` がミッション相対パスを解決するのは `PATH_KEYS = {path, paths, artifact_path, deliverable, evidence_paths}` のみ(`mission-process-planning.ts:270`)。**`args` と `cwd` は対象外**なので、`args` に相対パスを書くとリポジトリルート基準のまま解決されて壊れる。

→ 対策: 判定コマンドは `--mission <ID>` を受け取り、`findMissionPath()` で自分の責任で evidence パスを解決する。ゲート定義側にパスを書かない。

### 2. `tsx` ではなくコンパイル済み成果物を呼ぶ

ゲートは実行時経路であり、dev 依存の `tsx` に依存させない。判定ロジックは `scripts/mission_alignment_decision.ts` としてビルド対象に置き、ゲートからは `node dist/scripts/mission_alignment_decision.js` を呼ぶ。現行の `scripts/mission-alignment-gate/read-decision.ts`(tsx 前提・ハイフン付きディレクトリ)は、対話操作用の薄いラッパとして残すか統合する。

### 3. ゲート ID の別途登録は不要

`check_workflow_catalog_refs.ts` の `allGateIds` は catalog / review registry / gate-profiles からゲート ID を**収集して集合を作る**側であり、catalog 宣言のゲート ID はその供給源になる。`ALIGNMENT_APPROVED` を gate-profile-registry に別途登録する必要はない。

ただし `check_workflow_catalog_refs.ts:54` により **`default_tasks` を持つフェーズには `exit_gate` が必須**。上記定義はこれを満たす。

### 4. `report-review` への依存が未コミット

alignment-gate は `scripts/report-review/`(未追跡・`docs/report-review-capability_2026-07-31.patch` で受け渡し中)に依存する。**依存側が未コミットのまま alignment-gate を本体に入れることはできない。** 先に report-review の取り込み可否を決める必要がある。

→ 依存順序: report-review 確定 → MO-11 実装。

## ゴール(受入条件)

1. **ゲート化**: `ALIGNMENT_APPROVED` が workflow-catalog の `alignment` フェーズ exit_gate として宣言され、`plan-tasks` でミッションに展開される。
2. **単一の正本**: 判定の入力は `approval-store` のレコードのみ。HTML は正本にならない。判定コマンドは `status !== 'approved'` のとき非ゼロ終了する(`--strict`)。
3. **効果への束縛**: 承認後に `mission-brief.json` を書き換えるとゲートが fail する(`payloadHash` 不一致)。**これを契約テストで固定する。**
4. **サーフェス等価性**: concierge / Slack / ターミナル / brief HTML のいずれで決裁しても、同一の `ApprovalRequestRecord` が同一に更新され、ゲートの結果が変わらない。契約テストでサーフェス横断の等価性を検証する。
5. **証跡の監査チェーン搭載**: 承認が `gate.passed` として監査チェーンに記録され、`decidedBy` / `decidedAt` / `authMethod` / 決裁サーフェスが metadata に載る。
6. **状態遷移**: 承認によってミッションが `planned` → `active` に昇格する(承認前に `active` にならないこと)。
7. **要修正ループ**: `rejected` でゲートが fail し、理由に `reasonCategory` と Sovereign コメントが現れる。
8. **認証の正直な記録**: brief HTML からの決裁が、実際の認証強度どおりに記録される(`surface_session` を騙らない)。
9. **CI 登録**: 新規スクリプト・テストが registration ceremony([kyberion-development-practices](../../../../knowledge/product/governance/kyberion-development-practices.md))に従って登録される。
10. **3層整合**: MO-10 の 3 層モデルと矛盾しないこと。ゲート定義は R層(catalog)、判定コマンドは実行コード、運用手順は K層(`phases/alignment.md`)。**brief の内容を runtime が意味解析しないこと**(runtime が読むのは承認レコードと brief のハッシュのみ)。

## 実装フェーズ

### AG-01 — 承認レコードへの接続(サーフェス非依存の土台)

- `approval-store` に `kind: 'mission_gate'` を追加(S-1)。schema / 契約テストを更新。
- `scripts/mission_alignment_decision.ts` を新設(ビルド対象)。`--mission <ID>` で `findMissionPath()` から brief を解決し、`listApprovalRequests({ kind: 'mission_gate' })` から該当レコードを引く。`--strict` で「`status === 'approved'` かつ `payloadHash` 一致」以外は exit 1。
- 単体テスト: approved / rejected / pending × payloadHash 一致・不一致。**「承認後に brief を書き換えたら fail」を明示的に固定する。**
- この段階では catalog を変更しないため、既存挙動への影響ゼロ。

### AG-02 — brief サーフェスの決裁経路を既存基盤に載せる

- `render-brief.ts` を「承認リクエストを描画する」形に変更(brief JSON + 承認リクエスト id を入力に取る)。出力先は `<missionDir>/evidence/`。
- report-review サーバの保存ハンドラから `decideApprovalRequest` を呼ぶ。concierge の実装(`api/approvals/[id]/route.ts:34`)を参照実装とする。
- 認証強度を正直に記録(S-3)。`authMethod` の新値追加と、`human_only` 要求ゲートでの brief サーフェス不許可を実装。
- サーフェス識別子を決めて反映(S-2)。
- 二重決裁の契約テスト(S-4)。
- **`scripts/report-review/` の本体取り込みが前提**(下記ブロッカー)。

### AG-03 — catalog へのフェーズ追加とゲート展開

- workflow-catalog の対象テンプレートに `alignment` フェーズ + `ALIGNMENT_APPROVED` exit_gate を追加。**全 41 テンプレートに一斉適用はしない** — まず judgment 系・高リスク系の少数に限定し、golden 回帰で挙動を確認してから広げる。
- `check_workflow_catalog_refs.js` / `check_mission_process_bindings.js` を通す。
- V層: orchestration scenario pack に alignment ゲートを含む golden シナリオを追加(MO-10 Phase 3 のハーネスに載せる)。
- サーフェス横断等価性テスト(受入条件 4)。

### AG-04 — 運用手順と Review

- `knowledge/product/governance/phases/alignment.md` に新フローを記載し、`runtime_stages` frontmatter との整合を保つ(MO-10 Phase 4 の規約)。
- alignment-gate README を更新し、「承認は start の前」「HTML が判定の正本」という 2 つの古い前提を訂正する。
- 学びを `knowledge/product/governance/` に distill: (a)「`humanConfirmed` 自動充足を避けて `command_succeeds` に寄せる」ゲート設計作法、(b)**「新しい人間向け承認 UI を作るときは、まず `approval-store` に載せる。サーフェスは描画であって承認チャネルではない」**。
- 本 doc の実装状況追記、temp 掃除。

## 非目標

- **`reviewer_approved` の自動充足の廃止**: 既存ゲートの挙動を変えるため本計画のスコープ外。必要なら別途 MO 項目として、`humanConfirmed` の適用範囲を段階的に絞る(MO-02 の署名モードと同じ warn → enforce 方式)。
- **ブラウザからの `mission_controller create` / `start` 直接実行**: 監査可能性を損なう。作成・起動は引き続き人間の明示操作。
- **brief 内容の runtime 意味解析**: K層原則に反する。runtime が読むのは承認レコードと brief のハッシュのみ。
- **全テンプレートへの一斉適用**: AG-03 参照。
- **brief 専用の承認ストア・独自の決裁 API**: 発見4 の理由により禁止。決裁の書き込み口は `decideApprovalRequest` 一本。
- **既存サーフェスの承認 UI の作り替え**: 本計画は `kind: 'mission_gate'` を足すだけで、各サーフェスは既存のキュー描画のまま新種別を拾う。

## 実施形態

**ミッション + pipeline 経由**で行う(mission-gate 判定: 5+ アーティファクト変更、かつガバナンス証跡に関わるため ≥2 条件成立)。ただし AG-01 は独立性が高く単独実施可。

## 検証コマンド(実装時)

```bash
pnpm build
node dist/scripts/check_workflow_catalog_refs.js
node dist/scripts/check_mission_process_bindings.js
node dist/scripts/check_governance_rules.js
pnpm vitest run libs/core/mission-orchestration-scenario-pack.test.ts
pnpm vitest run libs/core/mission-process-planning.test.ts
pnpm vitest run libs/core/approval-store.test.ts
pnpm vitest run presence/displays/concierge/test/concierge-contract.test.ts
```

## 実装状況 (2026-08-03)

- **AG-01: 完了**(2026-08-03)。S-1 `kind: 'mission_gate'`、S-2 `surface: 'brief'`、`scripts/mission_alignment_decision.ts`(+ 単体テスト 11 件)を実装。承認後の brief 改変・payloadHash 欠落・brief 欠落をいずれも fail-closed で落とすことをテストで固定した。`--strict` のみ終了コードに反映するため、既存の対話利用は影響を受けない。
- **AG-02: 完了**(2026-08-03)。実機スモーク(後片付け済み)で全経路を確認: 決裁前 `--strict` exit 1 → brief から HTTP 承認(`authMethod=local_token`, `surface=brief`)→ exit 0 → 二重決裁 409 → 承認後に brief を改変して再び exit 1。
  - S-3 決定・実装: `authMethod: 'local_token'` を追加。brief は 127.0.0.1 束縛+起動時トークンで「所持」を示すだけなので `surface_session` を騙らない。**他サーフェスは従来どおり未記録のまま** — 全サーフェスを `surface_session` と決め打つのは逆方向の同じ不誠実(`presence` もローカルサーバ)。あわせて `decidedAuthMethod` をレコードに追加(従来は workflow を持たないレコードで認証強度が消えており、各サーフェスのキューUIはレコードを読むため画面に出なかった)。
  - S-4 実装: `decideApprovalRequest` で終結済みレコードへの再決裁を拒否。**穴は core にあった** — `applySurfaceApprovalDecision` は既に `status !== 'pending'` を弾いていたが、concierge の `/api/approvals/[id]` は core を直接呼ぶため素通りしていた。多段承認は `workflow.approvals` に pending が残っていれば通す。
  - `scripts/mission_alignment_request.ts`: brief のハッシュを束縛した `mission_gate` 承認リクエストを作る。作成した時点で全サーフェスのキューに現れる。pending は再利用するが、brief が変わっていた場合は再利用しない。
  - `scripts/mission_alignment_e2e.test.ts`: mission ディレクトリ解決だけを差し替え、approval-store・payload 束縛・ゲート判定を実物で通す統合テスト。
  - `brief` チャネルを security-policy.json の `surface_runtime` に登録済み。
  - `scripts/mission-alignment-gate/serve-brief.ts`: brief サーフェスの配信と決裁。`render-brief.ts` をモジュール化し、ゲート部分を承認ストア連携に置換。**承認リクエストに未紐付けの静的HTMLは決裁不可として描画する** — 承認ストアに記録されない決定は決定ではないため、旧来の「HTML に `data-decision` を焼く」経路は廃止した。
  - サーバ側の防御: 決裁対象はサーバ側で解決しページ由来の `requestId` と不一致なら 409 / 決裁者名必須 / 却下は理由カテゴリ必須 / トークン + Origin 検査。
  - **バグ修正**: `applySurfaceApprovalDecision` が `note` / `reasonCategory` を受け取っておらず、スプレッド引数は超過プロパティ検査を通らないため**却下理由が黙って捨てられていた**。イベントログに届くことをテストで固定。
  - **import 修正**: `@agent/core/secure-io.js` は exports マップに存在しない(他 11 スクリプトは `.js` なし)。tsx では通るがコンパイル後は `ERR_PACKAGE_PATH_NOT_EXPORTED` で落ちる。4 ファイル修正。
- **AG-03: 完了**(2026-08-11)。全テンプレートへの一斉適用は避け、判断・高リスク・顧客向けの初回対象として `stage-gated-high-stakes`、`decision-support-exploratory`、`crystallize-then-freeze`、`customer-engagement-stage-gated`、`research-report` に `alignment` フェーズと `ALIGNMENT_APPROVED` exit gate を展開した。ゲートは `mission-brief.json` の存在と `node dist/scripts/mission_alignment_decision.js --mission {MISSION_ID} --strict` の成功を要求する。汎用 `explore-then-govern` が decision-support/customer-engagement の interactive 経路を先取りしないよう対象クラスを限定し、既存の decision-support 向け `crystallize-then-freeze` にも同じ gate を付与した。V層には実際に `stage-gated-high-stakes` を解決する `golden-alignment-gated-high-stakes` を追加し、カタログ解決時にゲートが残ることを回帰固定した。
- **AG-04: 完了 (2026-08-11)**。`alignment.md` と `scripts/mission-alignment-gate/README.md` を、planned → approval-store → strict gate-pass → active の運用に更新した。`runtime_stages` は既存の分類ステージと整合するよう維持し、alignment は planning 配下の統制サブフェーズとして明記した。`knowledge/product/governance/approval-gate-design.md` に、`humanConfirmed` の自動充足を新規ゲートで避けて `command_succeeds` を使う設計、および approval-store を正本・サーフェスを renderer とする知見を整理した。
- **改訂履歴**: 初版は HTML の `data-decision` を判定の正本にしていたが、サーフェス整合の検討で `approval-store`(サーフェス非依存の承認基盤)の存在が判明したため全面改訂。承認の正本は approval-store のレコードとし、brief HTML はその描画の一つに降格。あわせて「承認が brief に束縛されていない」という初版の穴を `payloadHash` で塞いだ。
- **決定済み**: S-1 / S-2 / S-3 / S-4 すべて決定・実装済み(2026-08-03)。
- **未決定事項**: なし。ただし S-3 で `authenticated: true` を渡すのは「トークン所持を認証とみなす」割り切りであり、`authMethod: 'local_token'` を監査で抳えば後から段階的に絞れる余地を残してある。
