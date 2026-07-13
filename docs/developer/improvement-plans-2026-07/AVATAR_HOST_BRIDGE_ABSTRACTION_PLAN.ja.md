# Avatar Host Bridge 抽象化計画

## 目的

`create-my-avatar` を、単発の固定手順ではなく再利用可能な avatar onboarding flow として扱えるようにする。
同時に、画像生成の host bridge を `codex` / `agy` / 従来の host agent で共有できる境界に寄せる。

## 背景

現状の avatar 生成は次の問題を持つ。

- 生成プロセスが `scripts/generate_avatar.ts` 内の固定設定に依存している
- 登録処理が `scripts/register_avatar.ts` に埋め込まれていて、入力差し替えがしづらい
- pipeline が具体パスと具体名を直書きしており、別ホストや別 profile に流用しにくい
- host bridge が `host_agent` だけを前提にしていて、`codex` / `agy` の同型実行を吸収していない

## 方針

1. 画像生成は `libs/core/image-generation-bridge.ts` の provider routing に寄せる。
2. `codex` / `agy` / `host_agent` は同じ bridge 契約の別可用性として扱う。
3. avatar onboarding は `pipelines/fragments/avatar-onboarding.json` に切り出して、呼び出し側は入力だけ渡す。
4. 具体ファイル名や profile 値は pipeline context で差し替え可能にする。
5. 生成と登録の CLI は secure-io 前提で、引数駆動にする。

## 期待効果

- Codex 実行環境でも AGY 実行環境でも同じ avatar bridge 流れを使える
- `create-my-avatar` を別 profile 用に複製しやすい
- 生成 / 登録の責務が分離され、テストしやすくなる
- host bridge の選択が pipeline ではなく core の router 側に集約される

## 実装対象

- `libs/core/image-generation-bridge.ts`
- `scripts/generate_avatar.ts`
- `scripts/register_avatar.ts`
- `pipelines/fragments/avatar-onboarding.json`
- `pipelines/create-my-avatar.json`

## 受入条件

- `codex` CLI コンテキストで host bridge が選択できる
- `agy` CLI コンテキストで同じ bridge 契約を使える
- pipeline が fragment 経由で avatar onboarding を実行できる
- profile 名、言語、登録先パスが context で差し替えできる
- 生成・登録 CLI が secure-io を使い、固定パス依存を減らしている
