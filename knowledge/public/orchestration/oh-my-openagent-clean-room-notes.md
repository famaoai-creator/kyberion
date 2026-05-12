# Oh My OpenAgent から抽出できる clean-room ノート

このメモは、`oh-my-openagent` の公開ドキュメントを読んで、Kyberion 側で再設計しやすい概念だけを要約したものです。固有の文章や実装を写さず、構造だけを抜き出しています。

## 取り込み価値が高い考え方

- エージェントごとに役割とモデル family を分ける
- フォールバックは単一の全体ルールではなく、エージェント単位で定義する
- 設定は user scope と project scope を分け、近い設定を優先する
- 並列チームはサイズ上限、メッセージ上限、待機上限を持つ
- 継続系のフックは、終了条件・クールダウン・失敗回数のしきい値を持つ
- 互換レイヤーは新旧設定名の両方を受け、移行期間は警告付きで処理する
- フックやサブシステムごとに局所的な `AGENTS.md` を置いて責務を固定する

## Kyberion に移しやすい具体パターン

- `team_mode` のような構成を、mission / worker / review の分離設計に置き換える
- モデル選択を `provider / family / category` の三層で扱う
- `fallback_models` のような配列設定を、manifest の `recovery_policy` と同じく段階的解決に使う
- フックの責務を「入力の整形」「実行前ガード」「実行後ガード」「継続判定」に分ける
- config migration は既存設定を壊さず、バックアップを残して段階的に進める

## 取り込み時の注意

- README の文章、表現、図表は写さない
- モデル名や製品名はそのまま使わず、Kyberion 側の命名に置き換える
- `team_*` の UI / CLI 名は直接借用せず、Kyberion の mission / actuator / agent 用語に合わせる
- ライセンス文や商標表記は持ち込まない

## Kyberion 側の再設計候補

- `knowledge/public/governance/` に、エージェント役割ごとの config ガイドを追加する
- `AGENTS.md` のディレクトリ階層運用を、mission 配下の runbook に寄せて整理する
- `recovery_policy` を、retry / fallback / cooldown / quota の共通契約として統一する
- マルチエージェントの並列実行に、明示的な上限と shutdown handoff を追加する

