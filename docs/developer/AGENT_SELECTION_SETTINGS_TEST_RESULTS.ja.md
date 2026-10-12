# エージェント選択設定の検証記録

対象: MSN-AGENT-SELECTION-20261012。2026-10-12 時点の人工データによる検証。
実運用の設定、認証情報、外部モデルは使用していない。

## 検証した契約

- ミッション担当者と推論役割の選択を auto / preferred / fixed で分離する。
- fixed は指定された次元だけを固定する。権限・スコープ・必要能力・レビュー独立性を満たさなければ停止する。
- 保存済みの実効担当と、現在の適格性・プレビューを区別する。
- プレビュー決定トークンとリビジョンで競合を拒否する。
- A2A、事前起動、ライフサイクル、SDK/CLI アダプターまで固定モデルを保持する。対応不能なバックエンドと代替経路は明示的に拒否する。
- 管理者認証、CSRF、サーバー側スコープ、更新競合を保存境界で検証する。
- 専用 settings writer の追加権限は設定本体・直前バックアップ・履歴だけ。既存 worker/default 権限は維持する。

## 実測結果

- core、actuator/repository の再ビルド、root typecheck、root lint: 成功。
- Operator の production build と typecheck: 成功。
- Operator の API・コンポーネント等: 73 件成功。ローカル browser integration 1 件は明示的な未実行。
- ミッション/A2A/ライフサイクルの互換性修正後: 122 件成功。
- 推論選択の focused suite: 99 件成功。固定バインド抽出後の関連 suite: 65 件成功。
- 専用権限の実サブプロセス試験: 5 件成功。許可対象の保存、無関係な状態・資格情報・ポリシー・隣接パス・トラバーサル・シンボリックリンクの拒否を確認。
- 隔離した Operator runtime smoke: ミッションの preview/save、古いリビジョンとスコープの拒否、推論設定の save/reload、処理後の元ロール復元を確認。
- full gate manifest: Chromium の既知のホスト制約がある 1 gate を除く全 gate が成功。正確な対象は ci-gates.json の pr/full 全 ID から chronos-dom-contrast だけを除いた集合。

件数には重複がある。合算して総試験数とはしない。

## 集約試験で検出した問題と対処

最初の集約実行は 2,141 ファイル中 20 ファイル、19,058 件中 63 件が失敗した。成功とは扱っていない。

- 実行者の mission/persona/role と未登録環境変数、全体への stub 強制が子テストへ継承されていた。通常の無束縛環境に戻して該当 10 suite、176 件が成功した。
- 新規 import による既存 mock の破壊、未指定 metadata の不要な parse、直接ミッション検索の境界違反、破損 fixture の作り方を修正した。上記 122 件で再確認し、独立したソースレビューも完了した。
- 既存 agy setup-host 試験は実 HOME への書き込みを試みた。ソース変更なしで空の隔離 HOME を使用し、5 件成功。認証やアカウント作成は行っていない。
- Unix socket の listen EPERM は一度の通常の権限昇格試行でも継続した。このホストでの再試行は停止した。
- コミット内容を根拠とする work reconciliation 試験は未コミット差分の影響を受けるため、実コミットに揃えた後の確認対象とする。

### 無束縛環境での集約再実行

既知の socket 依存 4 suite、隔離 HOME で別途成功した agy suite、実コミットに依存する work reconciliation suite を明示的に除き、2,135 ファイルを再実行した。18,848 件成功、7 件失敗、21 件 skip。7 件は 3 suite の fixture 問題だった。

- 既存 orchestrator の全体 mock に新しい予約境界がなかった。予約境界の mock と正確な引数・起動順・重複防止の検証を追加し、元の起動検証を保持した。対象テスト一つへの一時権限は直後にバイト単位で復元した。
- provider constructor fixture は実際のキャッシュを参照していたため、既存 seam から空の snapshot を明示した。
- metrics fixture は認可された読み手を用意していなかったため、既存の限定的な metrics reader を使用した。実 tenant guard と拒否検証は変更していない。

修正後は独立レビューと関連 46 件の再実行が成功した。集約再実行自体を成功に書き換えず、最終的な全体検証は PR の CI で確認する。UI のエラーと操作対象の関連付けも補い、73 件・型検査・production build が成功した。手動の画面確認は未実施。

## 再実行方法と未完了の確認

通常の試験は mission/persona/role を渡さず、LANG=C.UTF-8、LC_ALL=C.UTF-8、CI=true で実行する。provider capability probe は無効にし、各試験自身の fixture/mocks を使用する。テスト全体に reasoning backend や wisdom profile を強制しない。

- pnpm exec vitest run libs/core/ scripts/ tests/ libs/actuators/
- pnpm --filter @agent/core build
- pnpm run build:actuators
- pnpm run typecheck
- pnpm run lint
- pnpm check -- --scope full

ローカル Chromium は IPC 制約により起動できず、手動の画面確認・スクリーンショット確認は未実施。既存 GitHub Actions の full gate 内で新しい browser integration が必須実行される。CI=true と GITHUB_ACTIONS=true の両方を要求し、ホストされた実行で browser の起動失敗を skip にしない。既存 chronos-dom-contrast も変更していない。

ホストされた browser、socket、全体 suite の結果は実際の PR チェックで確定する。pending は成功と数えない。この文書のローカル結果だけではマージ可能と判断しない。
