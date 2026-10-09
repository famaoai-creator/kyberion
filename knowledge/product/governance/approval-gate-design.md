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
  - 決定者の identity を呼び出し側が自由文字列で渡す surface（`unverified_decider`）。現在は MCP の
    `kyberion.approval.decide` と approval-actuator の `decide` op がこれに当たり、決定に
    `deciderIdentitySource: 'caller_supplied'` を記録する。ON ではこの 2 つから承認できない。
- **ON・利用時**: 承認済みレコードを効果に変える箇所は、すべて `assertApprovalUsable(record)` で同じ判定を
  やり直す。OFF のときに記録された自己承認などは、ON にした後では効果にならない（監査される）。
  呼び出し箇所: `enforceApprovalGate`（一致した承認と session cache の両方）、`claimApprovalApply`、
  project trust、DOT release と DOT dispatch、plugin view action の実行と plugin の有効化判定、MCP の
  governed tool、pipeline の `core:await_decision` と `approval_ref` 束縛、mission の scope-approve と
  reconcile-work、secret introduction、background review patch、peer runtime recovery、marketing
  publication、held action の apply、agent prompt approval、system-actuator の computer 操作、
  approval-actuator の `request_review`、および script 側の audit mirror reconcile、entity governance cleanup、
  mission alignment gate、organization decision、security-policy の直接書き込み（`pnpm org`）、personal workbench。
- **利用できない承認の扱い**: 承認済みレコードは取り消せない（cancel は pending だけが対象）。そのため
  利用時の拒否メッセージは「この承認は再利用されない。新しい承認を依頼し、別の、サーバーが識別した
  principal に決定してもらう」と、分かる場合は再依頼の正確なコマンドを示す。`enforceApprovalGate` と
  provider attestation の `--request-approval` と approval-actuator の `request_review` は、利用できない
  承認済みレコードを再利用せず、新しい依頼を開く。
- 却下（`rejected`）は対象外。依頼者が自分の依頼を却下するのは取り下げにすぎない。
- **比較する identity**: 依頼側は `requestedBy`、`requestedByContext.actorId`、`source.agentId` のすべて。
  決定側は `decidedBy`（staged workflow では承認済みの各 stage の `approvedBy` も）。どちらも NFKC 正規化・
  前後空白除去・小文字化し、principal 種別の接頭辞（`user:` `human:` `operator:` `member:` `principal:`
  `agent:` `service:` `persona:` `actor:` `policy:`）を外してから比較する。`user:alice` と `alice` は同じ principal。
- **policy が読めないとき**: `approval-policy.json` が無い・壊れているときは、承認の決定と利用を
  `[POLICY_VIOLATION] approval decision blocked — approval-policy.json unreadable | next: fix <path> | evidence: <原因>`
  で止める（却下は policy を読まないので通る）。
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
- **対象外の承認経路。** approval-store を通らない独自の承認は設定の対象外。例:
  `scripts/service_recording.ts` の `review --approve`（recording に reviewer を直接書く）。
- 確実に分離するには、承認を依頼者とは別の認証済み member（chronos / presence-studio の `user:<member_id>`）が行う。
