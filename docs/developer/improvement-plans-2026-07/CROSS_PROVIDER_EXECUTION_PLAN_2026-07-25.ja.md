# クロスプロバイダ実行計画 — 単一マシン上の複数 LLM プロバイダ CLI(claude / codex / agy 等)との安全な連携(XP-01〜07)

> **作成日**: 2026-07-25
> **優先度**: P1(XP-01〜04)/ P2(XP-05〜07)
> **位置づけ**: [CLI_SUBAGENT_TEAM_PLAN](./CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md)(CT: 単一プロバイダ CLI 内チーム)の兄弟計画。CT が「1つの CLI の中でチームを組む」なら、XP は「複数のプロバイダ CLI を1台のマシンで併走させる」ときの制約条件と動作ルールを定める。KD-05(能力ティア)・SA-04(egress 制御)・KP-01(配給単一入口)・HA-04(子プロセス env 最小化)・LC-08(縮退表面化)の合流点。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 0. 要旨

単一マシンに複数の LLM プロバイダ CLI(claude / codex / agy / gemini / copilot)が同居する構成は既に現実である(`provider-discovery.ts` が 5/5 検出、`reasoning-bootstrap.ts` が failover chain `claude-agent → codex-cli → agy-cli → copilot` を構成)。しかし「検出して失敗時に切り替える」以上の**併走規約がない**: 同一ディレクトリでの読み書き契約、プロバイダ別の権限・egress 差の吸収、縮退や生成元の表面化、並行資源の予算が未定義のまま各 backend が個別実装されている。本計画は、**ハード制約(不変条件)5点とソフト規則(既定)を、プロバイダ中立の宣言 + adapter 射影**として実装する。

```
        プロバイダ中立の正本(宣言)                     プロバイダ別 adapter(射影)
  能力プローブ registry(XP-01)──┐                ┌─ claude(tool 許可 / .claude/)
  権限プロファイル KD-05(XP-02)─┤→ マッピング表 ─┼─ codex(sandbox / .codex/)
  egress ラベル × tier(XP-03)──┤   (単一箇所)   ├─ agy
  読み書きマトリクス(XP-04)────┘                └─ gemini / copilot
            │
  縮退表面化 + provenance(XP-05)/ 並行・生存予算(XP-06)/ モデル分散 best-of-N(XP-07)
```

## 1. 診断(2026-07-25、実コード突合)

- **検出はあるが能力プローブがない**: `libs/core/provider-discovery.ts` はバイナリ存在ベース。headless モード可否・JSON 出力・認証状態・実行可能ツールは実行時に初めて判明し、「入っているが未認証の CLI」へルーティングして落ちる形が構造的に可能。
- **backend は個別実装でルール共有がない**: `codex-cli-query.ts` / `agy-cli-backend.ts` / `shell-claude-cli-backend.ts` / `claude-agent-reasoning-backend.ts` が各自のプロセス起動・env 受け渡し・出力パースを持つ。子プロセス env の allowlist 最小化(HA-04 が `core:ptc` で実証済みの型)は委譲経路には未適用で、**無関係プロバイダの API キーが子プロセス env に漏れうる**。
- **同一ディレクトリ併走の契約が未定義**: 各 CLI は cwd を暗黙コンテキストとして扱い、指示ファイル(`AGENTS.md` 正本 + `CLAUDE.md`/`CODEX.md`/`GEMINI.md` symlink — これは実装済みの正解)と `.claude/` 等のプロバイダ状態ディレクトリを読む。書き込み排他・git 操作の権限・プロバイダ状態ディレクトリの管理(gitignore / 生成)は規約化されていない。
- **tier × egress の突合がない**: プロバイダごとにデータの行き先(外部 API / ローカル推論)が違うが、`personal` / `confidential` tier のデータをどの provider に渡してよいかのゲートがない。SA-04 の egress 制御は network 面が対象で、**委譲面(プロンプトに載せて外部 LLM へ送る)は未カバー**。
- **縮退と生成元が黙る**: failover chain の切替はログには出るが、trace / ユーザー通知 / 成果物への provenance 刻印(どの provider・どのモデルが生成したか)が契約化されていない。LC-08 が stub 縮退で解決した問題と同型が provider 切替に残っている。
- **並行資源の予算がない**: 各 CLI はローカルで CPU・メモリ・トークンを消費するが、マシン全体の並行委譲数・プロバイダ別上限・子プロセスの wall-clock 予算とゾンビ回収は未定義(KD-02 の goal 予算はワーカー内の話で、プロセス面の予算ではない)。

## 2. ハード制約(不変条件化する 5 点)

1. **ディレクトリ契約**: 起動 cwd = リポジトリルート(またはミッション worktree ルート)。読み取りは全プロバイダ並列自由 / 書き込みは work-item claim 保持者のみ / `.git`・リポジトリ設定への書き込みは mission owner のみ(worker として起動した CLI に git write を許可しない)/ 一時ファイルは `active/shared/tmp/` のみ / プロバイダ状態ディレクトリは gitignore + 生成儀式で再現。
2. **指示は単一正本 + 射影**: プロバイダへの指示は AGENTS.md 正本 + symlink(実装済み)と、プロバイダ状態ディレクトリの SSoT 生成(CT-01 拡張)のみ。プロバイダ別の手書き指示ファイルを増やさない。
3. **子プロセス env は allowlist**: 委譲時に渡す環境変数は明示 allowlist(HA-04 の型)。資格情報は secret guard 経由でプロバイダ別に分離し、他プロバイダのキーを子プロセスに渡さない。
4. **tier × egress ゲート**: プロバイダ宣言に egress ラベル(`external-api` / `local-only` 等)を持たせ、配給入口(KP-01 の `provisionTaskKnowledge` / delegateTask 入口)で tier と突合。不一致は委譲前に拒否。
5. **出力契約はプロバイダ中立**: 発注 = タスク契約 + context pack、納品 = `task_result` 1ブロック(HN-02 の schema 強制)。書式差は adapter だけが吸収し、プロバイダ別パーサを増殖させない。非準拠は 1 回 reprompt → 失敗分類。

## 3. 実装タスク

### XP-01: プロバイダ能力プローブ registry と宣言ベースルーティング

> 優先度 P1 / 規模 M / 依存: なし(AC-01 の思想の委譲面への適用)

`provider-discovery.ts` を「バイナリ存在確認」から能力プローブへ拡張する: headless 実行可否・構造化出力(JSON)サポート・認証状態・利用可能モデル・ツール実行可否を各 adapter の安価なプローブ(`--version` / auth status 系コマンド)で取得し、`active/shared/runtime/` に TTL 付き registry として永続化。ルーティング(`agent-provisioning` / failover chain 構成)は registry を参照して**実行前に**不適格プロバイダを除外する。プローブ失敗は「不明」でなく「利用不可」として安全側に倒す。

**受入条件**

1. 未認証プロバイダが failover candidates から除外される hermetic テスト(fake CLI バイナリで契約テスト)。
2. registry のスキーマが `product/schemas/` に定義され、TTL 失効で再プローブされる。
3. プローブ結果(検出/除外と理由)が baseline-check 系の観測に載る。

— claude-sonnet-4

### XP-02: プロバイダ中立の権限プロファイル射影と env 最小化

> 優先度 P1 / 規模 M / 依存: KD-05(実装済み)、CT-01 と設計共有

KD-05 の能力プロファイル(implementer / explorer / planner)を正本に、プロバイダ別 permission 機構へのマッピング表(claude = tool 許可 / codex = sandbox 設定 / agy = 実行フラグ)を単一箇所に定義する。「explorer はどの CLI で動いても読み取り専用」を構造で保証。あわせて全委譲経路の子プロセス env を明示 allowlist に統一し(HA-04 の型の一般化)、プロバイダ資格情報のクロス漏洩を遮断する。

**受入条件**

1. 3 プロファイル × 主要 3 プロバイダのマッピングが単一モジュールにあり、未定義の組は fail-closed(委譲拒否)。
2. explorer 指定の委譲で write 系操作が全プロバイダで拒否される契約テスト(fake CLI)。
3. 子プロセスに渡る env が allowlist のみであることのテスト(他プロバイダのキー混入で fail)。

— claude-sonnet-4

### XP-03: tier × egress ゲート(委譲面のデータ境界)

> 優先度 P1 / 規模 M / 依存: SA-04(実装済み)、KP-01 と入口共有

プロバイダ宣言(XP-01 registry)に egress ラベルを追加し、委譲入口で「渡そうとしているデータの最高 tier」と突合するゲートを実装する。既定ポリシー: `public` = 全プロバイダ可 / `confidential` = egress 承認済みプロバイダのみ(設定で宣言)/ `personal` = local-only または明示承認。ゲートは KP-01 の配給単一入口(なければ暫定で `delegateTask` 系の共通前段)に置き、拒否は理由付きで表面化する。

**受入条件**

1. confidential データを含む委譲が未承認プロバイダで拒否される hermetic テスト。
2. egress ポリシーが governance 配下の設定ファイルで宣言され、コードにハードコードされない。
3. 拒否イベントが trace と ops-alert 経路に記録される。

— claude-sonnet-4

### XP-04: 同一ディレクトリ併走契約(読み書きマトリクスと生成儀式)

> 優先度 P1 / 規模 S〜M / 依存: CT-01 と生成儀式を共有

§2-1 の読み書きマトリクス(read: 全員 / write: claim 保持者 / `.git`・設定: owner / tmp: `active/shared/tmp` / プロバイダ状態: gitignore + 生成)を 5 行の正準表として文書化し、**全プロバイダの指示ファイルへ射影**する(AGENTS.md 追記 + CT-01 生成儀式でプロバイダ状態ディレクトリへ埋め込み)。`.claude/` `.codex/` 等の gitignore 整備と、worker 起動時に git write 系を tool 許可から外す配線(XP-02 のマッピング表経由)を含む。

**受入条件**

1. マトリクスが AGENTS.md(§1 Invariants への 1 行追記)と生成されるプロバイダ指示の両方に現れる。
2. worker プロファイルでの委譲に git commit/push 権限がないことの契約テスト。
3. プロバイダ状態ディレクトリが gitignore され、生成コマンドで再現できる。

— 文書 claude-haiku / 配線 claude-sonnet-4

### XP-05: 縮退表面化と成果物 provenance

> 優先度 P2 / 規模 S / 依存: XP-01

failover chain の切替(例: claude-agent → codex-cli)を LC-08 と同型で契約化する: 切替発生を trace イベント + ユーザー向け表面化とし、無言の provider 縮退を禁止。あわせて委譲成果物・task_result に **provenance(provider / model / 切替履歴)を刻印**し、artifact メタデータと trace の両方から「誰が生成したか」を辿れるようにする。

**受入条件**

1. failover 切替が trace に構造化イベントとして記録され、baseline/doctor 系から観測できる。
2. task_result 経由の成果物に provider/model provenance が付与される hermetic テスト。
3. 旧形式(provenance なし)の後方互換が保たれる。

— claude-sonnet-4

### XP-06: 並行・生存予算(プロセス面の資源統制)

> 優先度 P2 / 規模 S / 依存: XP-01

マシン全体の並行委譲数に global semaphore、プロバイダ別に上限を設ける(registry 宣言)。委譲子プロセスに wall-clock 予算(KD-02 の型のプロセス面適用)と kill-switch 連動を必須化し、期限超過・孤児化した CLI プロセスの回収を storage janitor と同枠の保守ループに追加する。

**受入条件**

1. 上限超過の委譲が queue され、並行数が上限を超えない hermetic テスト。
2. wall-clock 超過で子プロセスが確実に終了し、trace に記録される。
3. ゾンビ回収が dry-run 付き保守ジョブとして観測できる。

— claude-sonnet-4

### XP-07: モデル分散 best-of-N(真のモデル多様性)

> 優先度 P2 / 規模 M / 依存: XP-01〜03、MO-07(実装済み)

同一タスク契約を複数プロバイダ(claude / codex / agy)へ並列発注し、MO-07 の judge 契約で集約する `best-of-providers` 委譲モードを追加する。CT-03 の lens 分散(同一モデル・視点分散)と相補: モデル間の系統的バイアスを打ち消せるため、レビュー・判定・リスク評価系タスクの既定に向く。egress ゲート(XP-03)を通過したプロバイダのみ参加。judge の判定記録に参加プロバイダと票を残す。

**受入条件**

1. 3 プロバイダ(fake)並列発注 → judge 集約 → 多数決結果が MO-07 互換形式で記録される hermetic E2E。
2. egress 不適格プロバイダが自動的に参加除外され、除外が表面化する。
3. 1 プロバイダのみ利用可能な環境では単独実行に自然縮退する(失敗しない)。

— claude-sonnet-4

## 4. 実施順序

```
XP-01(能力プローブ registry)← 土台
  ├─ XP-02(権限射影 + env 最小化)─┐
  ├─ XP-03(tier × egress ゲート)──┼─ XP-07(モデル分散 best-of-N)
  ├─ XP-05(縮退表面化 + provenance)┘
  └─ XP-06(並行・生存予算)
XP-04(併走契約)← XP-02 のマッピング表を使うが文書部分は先行可
```

CT(単一 CLI チーム)とは独立に着手可能。両方入ると「CLI 内チーム(CT)× プロバイダ横断(XP)」の直積が実行面の選択肢になるため、使い分けルーブリック(CT-04)に XP の軸を追記する。

## 5. 非目標

- 新しいプロバイダ CLI 対応の追加(gemini / copilot の深い対応は本計画の範囲外。registry と adapter の枠だけ用意する)。
- プロバイダ間のコンテキスト共有・会話の橋渡し(hub-and-spoke を維持。プロバイダ間連携は常に Kyberion のタスク契約を経由する)。
- 品質ベンチマーク基盤(どのプロバイダがどのタスクに強いかの計測は、XP-05 の provenance データが溜まってから別計画で扱う)。
- ハーネス側 sandbox 実装の代替(各 CLI の permission 機構はそのまま使い、Kyberion は宣言と射影のみ持つ)。

## 6. 関連計画

- [CLI_SUBAGENT_TEAM_PLAN(CT-01〜04)](./CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md) — 兄弟計画。CT-01 の生成儀式・CT-04 のルーブリックを共有・拡張。
- [KD-05(能力ティア)](./KIMI_CODE_ADOPTION_PLAN_2026-07-20.ja.md) — XP-02 の正本語彙(DONE)。
- [SA-04_EGRESS_CONTROL](./SA-04_EGRESS_CONTROL.ja.md) — network 面の egress。XP-03 は委譲面への拡張。
- [TASK_KNOWLEDGE_PROVISIONING_PLAN(KP-01)](./TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md) — 配給単一入口。XP-03 のゲート設置点。
- [HERMES_AGENT_ADOPTION_PLAN(HA-04)](./HERMES_AGENT_ADOPTION_PLAN_2026-07-18.ja.md) — 子プロセス env 最小化の実装参照(DONE)。
- [LOOP_CLOSURE_PLAN(LC-08)](./LOOP_CLOSURE_PLAN_2026-07-13.ja.md) — 縮退表面化の同型先例。
- [MO-07_QUALITY_MAXIMIZING_DELEGATION](./MO-07_QUALITY_MAXIMIZING_DELEGATION.ja.md) — XP-07 の judge 契約(DONE)。
