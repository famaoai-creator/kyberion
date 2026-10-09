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
- **ON**: 承認（`approved`）の決定者が依頼者と同じ principal なら、approval-store が
  `[POLICY_VIOLATION] Separation of duties: …` で拒否する。拒否は監査台帳（`approval_decision` /
  `separation_of_duties`、`result: denied`）と、その channel の approval イベントログ
  （`separation_of_duties_refused`）に記録され、依頼は `pending` のまま残る。
- 判定は全サーフェスが通る唯一の決定経路 `decideApprovalRequest` で行う。CLI（`pnpm kyberion approvals --approve`）、
  Slack、concierge、chronos、presence-studio、brief のどれから決めても同じ。さらに `claimApprovalApply` でも
  再判定するため、OFF のときに自己承認された依頼を ON にした後で適用することもできない。
- 却下（`rejected`）は対象外。依頼者が自分の依頼を却下するのは取り下げにすぎない。
- **比較する identity**: 依頼側は `requestedBy`、`requestedByContext.actorId`、`source.agentId` のすべて。
  決定側は `decidedBy`。どちらも NFKC 正規化・前後空白除去・小文字化し、principal 種別の接頭辞
  （`user:` `human:` `operator:` `member:` `principal:` `agent:` `service:` `persona:` `actor:` `policy:`）を
  外してから比較する。`user:alice` と `alice` は同じ principal とみなす。誤一致は拒否側に倒れるだけなので安全側。
- **依頼者が記録されていない依頼**（古いレコード・不正なレコード）は、分離を証明できないため ON では拒否する
  （fail closed）。決定者の identity が空の決定も同様。
- **スコープ**: 設定は `approval-policy.json` 全体と同じく、有効な customer overlay
  （`customer/<slug>/policy/approval-policy.json`）がある場合はそれが product 既定を丸ごと置き換える。
  tenant・organization 単位の上書きはない（global 設定）。
- **限界**: 比較は記録された文字列 identity の一致で行う。エージェントが依頼し人間が承認する通常経路
  （例: 依頼者 `sovereign` / `worker`、承認者は onboarding identity の名前）は ON でも通る。逆に、同じ人が
  CLI の persona 名と onboarding の表示名という別の文字列で依頼と承認を行うと、同一人物でも検出できない。
  確実に分離するには、承認を依頼者とは別の認証済み member（chronos / presence-studio の `user:<member_id>`）が行う。
