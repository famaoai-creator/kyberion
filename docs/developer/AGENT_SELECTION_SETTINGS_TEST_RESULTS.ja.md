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
- full gate manifest: Chromium の既知のホスト制約がある 1 gate を除く全 gate コマンドが成功。新しい browser integration の実ブラウザー assertion はローカルでは skip。正確な対象は ci-gates.json の pr/full 全 ID から chronos-dom-contrast だけを除いた集合。

件数には重複がある。合算して総試験数とはしない。

## 集約試験で検出した問題と対処

最初の集約実行は 2,141 ファイル中 20 ファイル、19,058 件中 63 件が失敗した。成功とは扱っていない。

- 実行者の mission/persona/role と未登録環境変数、全体への stub 強制が子テストへ継承されていた。通常の無束縛環境に戻して該当 10 suite、176 件が成功した。
- 新規 import による既存 mock の破壊、未指定 metadata の不要な parse、直接ミッション検索の境界違反、破損 fixture の作り方を修正した。上記 122 件で再確認し、独立したソースレビューも完了した。
- 既存 agy setup-host 試験は実 HOME への書き込みを試みた。ソース変更なしで空の隔離 HOME を使用し、5 件成功。認証やアカウント作成は行っていない。
- Unix socket の listen EPERM は一度の通常の権限昇格試行でも継続した。このホストでの再試行は停止した。
- コミット内容を根拠とする work reconciliation 試験は未コミット差分の影響を受けた。実コミット f02b10aa5f8aa06ef303ec77afebbc8c48ace703 に揃えた後、25 件成功した。

### 無束縛環境での集約再実行

既知の socket 依存 4 suite、隔離 HOME で別途成功した agy suite、実コミットに依存する work reconciliation suite を明示的に除き、2,135 ファイルを再実行した。18,848 件成功、7 件失敗、21 件 skip。7 件は 3 suite の fixture 問題だった。

- 既存 orchestrator の全体 mock に新しい予約境界がなかった。予約境界の mock と正確な引数・起動順・重複防止の検証を追加し、元の起動検証を保持した。対象テスト一つへの一時権限は直後にバイト単位で復元した。
- provider constructor fixture は実際のキャッシュを参照していたため、既存 seam から空の snapshot を明示した。
- metrics fixture は認可された読み手を用意していなかったため、既存の限定的な metrics reader を使用した。実 tenant guard と拒否検証は変更していない。

修正後は独立レビューと関連 46 件の再実行が成功した。集約再実行自体を成功に書き換えず、最終的な全体検証は PR の CI で確認する。UI のエラーと操作対象の関連付けも補い、73 件・型検査・production build が成功した。手動の画面確認は未実施。

## 最終ビルドと基準チェック

最終整形後にソースとビルド済み成果物のハッシュ差分が生じ、L2 が再試行上限で停止した。コマンド終了値だけを見て構造化された needs_recovery を見落とした実行手順の問題も確認した。人による復旧承認後、通常の全体ビルドを一度、公式の基準チェックを一度実行した。結果は all_clear、circuit_broken=false、L0–L11 全て passed、attempt_count=0。状態ファイルを直接変更して解除していない。外部 provider probe は無効。

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

## 最初のホスト CI と修正

PR #1070 の最初の head 1ef8ea0 では、PR readiness、actuator/boundary/security、core 6 shard が成功した。一方、CodeQL はエラー分類の非固定正規表現に多項式時間の後戻りを検出し、full gate は 81 件中 mos-no-write-api が失敗した。これらを成功として扱っていない。

- エラー分類を、行ごとに順序を保つ線形の文字列検索へ変更し、長い反復入力・大文字小文字・逆順・改行・情報非開示を回帰対象とした。
- ホスト browser assertion は skip されず起動を試みたが、Ubuntu 24.04 の AppArmor によりダウンロード版 Chromium の sandbox を利用できなかった。既存 chronos-dom-contrast は成功した。
- 対象ランナーの [公式ソフトウェア一覧](https://github.com/actions/runner-images/blob/ubuntu24/20261004.327/images/ubuntu/Ubuntu2404-Readme.md) は Google Chrome 154.0.8037.97 を掲載する。[Chromium の公式説明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md) に従い、既存 Ubuntu ポリシーの対象となるインストール済み stable Chrome を [Playwright の標準 channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge) で選ぶ。chromiumSandbox:true を維持し、起動失敗は失敗のままとする。OS・AppArmor 設定、インストール、sandbox 無効化、別ブラウザーへの自動代替は追加しない。実際の browser version と assertion 結果は修正後 CI のログで確認する。

修正後のローカル Operator 試験は 80 件成功、実ブラウザー 1 件は明示的な skip。型検査と production build も成功した。独立したソースレビューで線形分類・sandbox 維持・代替経路なしを確認した。修正後の CodeQL と実ブラウザー assertion は次の CI で確認する。

次の head 3d09c888 で CodeQL は成功し、sandbox を有効にした stable Chrome は実際の画面操作へ進んだ。しかし、select を囲む label に option 全文が含まれ、正確な Selection mode ラベルが一致せず失敗した。ラベルと control を兄弟要素にして htmlFor/id を維持し、英語・日本語の SSR 回帰と実ブラウザーの native label 検証を追加した。セレクターやタイムアウトは緩和していない。修正後のローカル試験 84 件、型検査、production build、対象 lint は成功した。失敗時には人工画面の限定的な状態だけを診断へ出力し、元の失敗を再送出する。最終 hosted assertion は引き続き未確定。
