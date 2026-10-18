---
title: 'テスト用一時領域の後始末と削除境界'
tags: [testing, secure-io, storage, operations, regression]
last_updated: 2026-10-18
runtime_stages: [execution, review]
---

# テスト用一時領域の後始末と削除境界

## 前提

`active/shared/tmp/` はいつ消えてもよい一時領域であり、成果物や永続状態の保存先ではない。消失時の復元を運用前提にしない。一方、個々のテストの後始末は自分が作った fixture に限定する。他のテストや進行中ジョブの一時領域まで消すと、検証結果の再現性と並行実行を壊す。

## なぜ削除処理が入ったか

continuous owner の停止フラグ確認を、mock ではなく実際のファイル読取で検証する回帰テストを追加した。停止状態を後続テストへ持ち越さないため、`finally` に fixture の削除を入れた。この後始末自体は必要だった。

誤りは削除対象の作り方と広さにあった。`pathResolver.rootResolve` を `path.join` のように複数引数で呼んだが、API は1引数だけを受け付ける。JavaScript は余分な引数を無視するため、固有ジョブ名が落ち、返ったパスは共有 `active/shared/tmp` 自体になった。そのパスを再帰削除した。

Vitest / tsx の変換は TypeScript の型検査ではない。引数数の誤りを型検査で検出するより前に、テストと `finally` が実行された。また、当時の secure-io は書込権限を確認していたが、共有tmpルート自体の再帰削除を拒否する境界を持っていなかった。

## 採用した対策

1. 固有ジョブ名を含む全相対パスを、`rootResolve` の**単一引数**として渡す。API のシグネチャを読んでから fixture を作る。
2. cleanup は作成したフラグファイルだけを削除する。ディレクトリ削除が必要な場合も、固有 basename と期待する親からの相対パスを照合し、共有ルートを対象にしない。
3. 削除を含む新規テストでは、実行前に引数数などの型検査を済ませる。型検査の代わりに tsx / Vitest の成功を使わない。
4. `safeRmSync` は共有tmpルートの再帰削除を、正規化済みパスと canonical パスで拒否する。回帰テストは native 削除を mock し、ルート指定の5ケースで削除関数が呼ばれないことを確認する。
5. 一時領域全体の掃除は保持規約に従う janitor の仕事とし、個々のテストの cleanup に混ぜない。tmp の非永続性と、テストが消してよい範囲は別々に扱う。

## 検証と適用先

- 実停止フラグの absent / halted を読む owner 回帰テスト。
- 共有tmpルート・絶対パス・末尾 slash・正規化 alias・既定再帰 options の拒否テスト。
- 既存 secure-io の metadata / symlink / permission を含む関連テスト。
- 正規の成果物は `writeScopedArtifact`、永続状態は runtime floor、外部からの受入は staging に置く。一時領域にしかない情報を唯一の evidence としない。

運用手順と実装境界は [operations-hygiene-runbook](./operations-hygiene-runbook.md)、保存先の区別は [runtime-storage-layout](../architecture/runtime-storage-layout.md) を参照する。
