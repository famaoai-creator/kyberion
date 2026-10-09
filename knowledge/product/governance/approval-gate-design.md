---
title: 'Approval Gate Design: Store First, Surface as Renderer'
tags: [governance, approval, mission, gate, human-in-the-loop]
last_updated: 2026-10-08
---

# Approval Gate Design

人間承認を伴うゲートは、承認の保存・判定と、人間向けの表示・入力を分離する。新しい承認 UI を作るときは、先に共有 `approval-store` のリクエスト契約を作り、サーフェスはそのリクエストを描画する renderer として接続する。

## 原則

1. **Store first**: `mission_gate` などの承認リクエストを共有 approval-store に作成し、対象 payload のハッシュを記録する。サーフェス固有の承認ストアや決裁 API は追加しない。
2. **Surface is not authority**: HTML、ブラウザ状態、`data-decision`、ローカルの保存ファイルは表示・入力の一時表現であり、承認の正本ではない。決定は既存の approval-store の決定 API を通して保存する。
3. **Hash-bound approval**: 承認対象が変わったら同じ承認を再利用しない。ゲートは approval-store の決定と、現在の brief のハッシュが一致することを確認する。
4. **Explicit machine gate**: 承認ゲートは `command_succeeds` で strict な判定コマンドを実行する。コマンドは approval-store、ハッシュ、必要な認証強度を確認し、失敗時にミッションを進めない。
5. **Do not widen legacy behavior**: 既存の `reviewer_approved` や `human_override` の `humanConfirmed` 自動充足を、既存ゲート全体で一括変更しない。新しいゲートは command-based な証拠を選び、既存挙動の段階的な移行は別の変更として扱う。

## Mission alignment への適用

`mission_controller create` は planned 状態のミッション容器を作るライフサイクル操作であり、承認そのものでも実行開始でもない。既存の `mission_controller start` は active 化する操作なので、この承認フローでは使わない。`ALIGNMENT_APPROVED` の `command_succeeds` ゲートが最初に成功したときだけ planned から active へ遷移する。ブラウザや UI から create/start を直接呼び出さない。

標準経路は次のとおり。

```text
mission brief
  -> approval-store request + payloadHash
  -> approved surface decision
  -> strict command_succeeds check
  -> first gate pass: planned -> active
```

この分離により、サーフェスを追加・交換しても、承認の監査記録とゲートの判定契約は共有のまま保てる。

## 職務分離（separation of duties）

依頼者が自分の依頼を承認できるかどうかは policy で選ぶ。設定は
`knowledge/product/governance/approval-policy.json` の `separation_of_duties.enabled`（既定 `false`）。

- **OFF（既定）**: 従来どおり。Kyberion は 1 人の operator で運用されることが多いため、依頼者本人の承認も通る。
- **ON・決定時**: approval-store の `decideApprovalRequest` が、承認（`approved`）の決定を次の場合に
  `[POLICY_VIOLATION] Separation of duties: …` で拒否する。拒否は監査台帳（`approval_decision` /
  `separation_of_duties`、`result: denied`）と、その channel の approval イベントログ
  （`separation_of_duties_refused`）に記録され、依頼は `pending` のまま残る。
  - 決定者が依頼者と同じ principal（`self_approval`）。
  - 依頼に依頼者の identity が記録されていない（`missing_requester`、fail closed）。
  - 決定者の identity が空、または surface の代替値（`missing_decider`）。代替値の一覧は
    `APPROVAL_PLACEHOLDER_DECIDERS`（`concierge`、`chronos-localadmin`、`sovereign-user` など）の 1 か所にある。
  - 決定者の identity を呼び出し側が自由文字列で渡す surface（`unverified_decider`）。決定に
    `deciderIdentitySource: 'caller_supplied'` を記録する surface は次の 2 つだけで、ON ではここから承認できない。
    - `libs/core/governance/approval-cowork-adapter.ts`（MCP の `kyberion.approval.decide`）
    - `libs/actuators/approval-actuator/src/approval-actuator-helpers.ts`（approval-actuator の `decide` op）
  - mission brief の承認ページ（`scripts/mission-alignment-gate/serve-brief.ts`）は、ページの token が
    所持しか証明しないため、決定者をページから受け取らない。CLI と同じ `resolveOperatorDisplayName()` で
    サーバー側が決め、ページで入力された名前は note に残すだけ。
- **ON・利用時**: 承認済みレコードを効果に変える箇所は、次の consumer id で同じ判定をやり直す
  （`assertApprovalUsable` / `approvalUsabilityRefusal`、拒否は `use:<consumer id>` として監査）。OFF のときに
  記録された自己承認などは、ON にした後では効果にならない。一覧は
  `libs/core/governance/approval-sod-consumers.contract.test.ts` と一致させる。
  - 承認ゲートと store: `approval_gate`、`approval_gate_session_cache`、`apply_claim`
  - DOT: `dot_release`、`dot_dispatch`、`dot_autonomy_promotion`（拒否時は昇格待ちを監査付きで取り消す）、
    `front_desk_execution`
  - mission と discussion: `mission_scope_approve`、`mission_reconcile_work`、`discussion_mission`
  - plugin と MCP: `plugin_view_action`、`plugin_activation`（plugin の有効化判定。監査なしで判定し、
    使えない承認は `pending_approval` にする）、`mcp_governed_tool`
  - pipeline: `pipeline_await_decision`、`pipeline_bound_approval`
  - その他の効果: `project_trust`、`secret_introduction`、`background_review_patch`、`peer_runtime_recovery`、
    `marketing_publication`、`held_action_apply`（held action は取り消され、依存する held action も取り消される。
    drain は他の held action を続ける）、`agent_prompt_approval`、`system_actuator_computer`、
    `approval_actuator_request_review`
  - script: `audit_mirror_reconcile`、`entity_governance_cleanup`、`mission_alignment_gate`、
    `organization_decision`、`org_security_policy_write`（`scripts/org.ts`）、`personal_workbench`
- **利用できない承認の扱い**: 承認済みレコードは取り消せない（cancel は pending だけが対象）。そのため
  利用時の拒否メッセージは「この承認は再利用されない。新しい承認を依頼し、別の、サーバーが識別した
  principal に決定してもらう」と、分かる場合は再依頼の正確なコマンドを示す（held action の場合は held action
  自体を依頼し直すよう示す）。再依頼の入口（`enforceApprovalGate`、provider attestation の `--request-approval`、
  approval-actuator の `request_review`、mission の scope-approve と reconcile-work、project trust、
  background review、agent prompt）は、利用できない承認済みレコードを返さず、新しい依頼を開く。
  承認ゲートは、使える候補が残っていないときだけ（新しい依頼を開くときに）1 回監査する。
- 却下（`rejected`）は対象外。依頼者が自分の依頼を却下するのは取り下げにすぎない。
- **比較する identity**: 依頼側は `requestedBy`、`requestedByContext.actorId`、`source.agentId` のすべて。
  決定側は `decidedBy`（staged workflow では承認済みの各 stage の `approvedBy` も）。どちらも NFKC 正規化・
  前後空白除去・小文字化し、principal 種別の接頭辞（`user:` `human:` `operator:` `member:` `principal:`
  `agent:` `service:` `persona:` `actor:` `policy:`）を外してから比較する。`user:alice` と `alice` は同じ principal。
- **policy ファイルが無いとき・壊れているとき**: 承認の決定と、承認済みレコードの利用は、まず
  `approval-policy.json` を読んで SoD の設定を確かめる。
  - ファイルが無い（customer overlay も product 既定も無い。例: knowledge を持たない作業用 root）ときは、
    出荷時の既定（`separation_of_duties.enabled: false`）として扱い、debug ログを 1 行出す。既定は OFF なので、
    これで新しく許されることは無く、SoD OFF の振る舞いは変わらない。
  - ファイルはあるが読めない・schema に合わないときは、SoD を OFF にしているつもりでも、承認の決定と利用は
    `[POLICY_VIOLATION] approval decision blocked — approval-policy.json unreadable | next: fix <path> | evidence: <原因>`
    で止まる（fail closed）。却下は policy を読まないので通る。plugin の有効化判定だけは、例外を投げずに
    `pending_approval` に落とし、診断の警告をログに出す（plugin 一覧や読み込みが止まらないように）。
    DOT autonomy の昇格待ちは取り消さず、次の sweep で再試行する。
- **スコープ**: 設定は `approval-policy.json` 全体と同じく、有効な customer overlay
  （`customer/<slug>/policy/approval-policy.json`）がある場合はそれが product 既定を丸ごと置き換える。
  tenant・organization 単位の上書きはない（global 設定）。

### 限界

- **文字列 identity の一致で判定する。** 次の場合、同じ人でも検出できない（false negative）。
  - 同じ人を別の文字列で表す場合: メールアドレスと member id、onboarding の表示名と `user:<member_id>`、
    CLI の persona 名（例 `sovereign`）と表示名。既定の 1 人運用の CLI 経路では、依頼者は CLI を実行した
    persona、承認者は onboarding identity の名前になるので、本人の依頼を本人が承認しても通る。CLI の
    identity モデルは現時点では変えていない（既知の限界）。
  - NFKC で同一化されない見た目の似た文字（例: ラテン文字の `a` とキリル文字の `а`）。
  - 依頼を作った人間ではなく component 名を依頼者として記録する作成元
    （`<surface>_surface_steering`、`system-actuator`、`pipeline:<runId>` など）。
- **依頼者が値を決められる誤一致（false positive）。** `requestedBy` などは依頼側が書くので、依頼者が承認者の
  identity を名乗ると、その承認者の承認が拒否される。拒否側に倒れるだけで承認が不正に通ることはないが、
  承認の妨害には使える。
- **policy / service の決定者は別 principal として扱う。** veto window の自動決定（`policy:veto-window`）や
  secret introduction の自動承認（`policy:secret-introduction-local-low-risk`）は人の名前ではないが、
  代替値の一覧には入れていないので、依頼者と文字列が違えば「別の principal」とみなされ承認が通る。
  これらの自動決定を SoD の対象にするかは、それぞれの policy（veto window、secret introduction の自動承認条件）で決める。
- **対象外の承認経路。** approval-store を通らない独自の承認は設定の対象外。例:
  `scripts/service_recording.ts` の `review --approve`（recording に reviewer を直接書く）。
- 確実に分離するには、承認を依頼者とは別の認証済み member（chronos / presence-studio の `user:<member_id>`）が行う。
