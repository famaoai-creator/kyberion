---
title: 'Approval Gate Design: Store First, Surface as Renderer'
tags: [governance, approval, mission, gate, human-in-the-loop]
last_updated: 2026-08-11
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
