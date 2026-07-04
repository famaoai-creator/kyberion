# ONB-01: 実働バックエンドのオンボード統合 — 「スタブ脳で成功する」問題の解消

> 優先度: **P0**(初回体験で最も致命的) / 規模: M / 依存: なし / 関連: UX-06(オンボードバグ)、OP-03(インストール)とは別問題
>
> **なぜ致命的か**: 新規ユーザーが README どおりに進めるとオンボードは「Welcome aboard」と表示し `vital` は緑になるが、**実際には推論バックエンドが未設定でスタブ(offline placeholder)脳のまま**。その状態で UI もウィザードも「エージェントを起動しよう/ミッションを作ろう」と誘導する。ユーザーは「動いている」と信じて実作業を頼み、`[STUB]` プレースホルダが返る。製品が使えるかどうかの make-or-break がオンボードで一切扱われていない。

## 背景と課題

- **オンボードが reasoning backend に一切触れない**: `scripts/onboarding_wizard.ts` は identity/services/tenants/tutorial を捕捉するが、バックエンドの検出・案内・設定がゼロ。無条件に "Welcome aboard"(`:646`)。
- **無言でスタブに落ちる**: `getReasoningBackend()` は `registered ?? stubReasoningBackend`(`libs/core/reasoning-backend.ts:358-360`)。スタブは placeholder を返し `logger.warn` を出すだけ(`:373-541`)。API キーも CLI も無い新規ユーザーはここに着地。
- **doctor は検出するが `should` 誤分類**: `probeReasoningBackend` は `available:false` + 良い actionable reason を返す(`environment-capability-probes.ts:79-83`)が、`reasoning-backend.any-real` の `required_for` が `MUST_REQUIRED_FOR`(`environment-doctor.ts:23-30`)に含まれず `classifyDoctorSeverity` が `'should'` に落とす(`:42`)。唯一の必須能力が「streaming TTS」と同じ severity。ユーザーは "should" を「後回し可」と読む。
- **修正コマンドが行き止まり**: doctor は失敗時に `pnpm env:bootstrap --manifest reasoning-backend --apply` を勧める(`run_doctor.ts:96,104`)が、`reasoning-backend.any-real` は `install.operator_confirmed: true` で `command` 無し(ベンダー資格情報)。`--apply` は operator-confirmed をスキップ(`bootstrap_environment.ts:145`)、`--force` でも実行対象が無い。**推奨された remediation では直せない**。
- CLAUDE.md/AGENTS.md の推奨は `claude-cli`(ローカル claude CLI、API キー不要)→ `anthropic`(`ANTHROPIC_API_KEY`)→ `stub`。この優先順位が新規ユーザーに提示されない。

## ゴール(受入条件)

1. オンボード(対話 + Path B)が **reasoning backend を検出し、未設定なら明示的に案内**する: 使える選択肢(ローカル `claude` CLI 検出 → 案内、`ANTHROPIC_API_KEY` 設定手順、その他 CLI)を提示し、少なくとも 1 つが動くまで「セットアップ未完了」を明確に伝える。
2. `reasoning-backend.any-real` が **`must` に再分類**され、doctor/vital がバックエンド不在を**赤(致命)** として表示する。
3. doctor の修正案内が**実際に実行可能な手順**(claude CLI のインストール/ログイン、または API キーの設定場所)を指し、行き止まりの `env:bootstrap --apply` を勧めない。
4. スタブに着地した状態で実作業を依頼すると、`[STUB]` 出力の前に「推論バックエンド未設定です。`pnpm reasoning:setup` を実行してください」という明確な警告がユーザーに出る(黙ってプレースホルダを返さない)。
5. `pnpm reasoning:setup`(既存 or 新設)が対話的にバックエンドを設定・疎通確認できる。

## 実装タスク

### Task 1: severity 再分類と doctor 案内修正 — `claude-sonnet-4`

1. `environment-doctor.ts:23-42` の `MUST_REQUIRED_FOR` に reasoning backend の必須用途を追加、または `reasoning-backend.any-real` を直接 `must` に分類する。vital/doctor でバックエンド不在が赤表示になることを確認。
2. `run_doctor.ts:96,104` の失敗時案内を、operator-confirmed 資格情報向けの**実効的手順**(「`claude` CLI をインストールしログイン」/「`ANTHROPIC_API_KEY` を .env に設定」/「`KYBERION_REASONING_BACKEND=claude-cli`」)に置換。`env:bootstrap --apply` は provision できるものだけに勧める。
3. テスト: バックエンド不在で doctor が must/赤 + 実効手順を返すこと。

### Task 2: オンボードへのバックエンド検出ステップ追加 — `claude-sonnet-4`

1. `onboarding_wizard.ts` に reasoning フェーズ(identity の後、services の前あたり)を追加: `probeReasoningBackend` で現状を検出し、未設定なら選択肢を提示(ローカル `claude` CLI があれば「これを使う」を既定に、無ければ API キー手順)。設定を試み、疎通確認(小さな real 呼び出し)まで行う。
2. 疎通できない場合は「スタブで続行(実作業不可・後で設定)」を明示選択させ、`state` に `reasoning_backend: stub` を記録。**"Welcome aboard" の前に現状を正直に伝える**(UX-01 の正直さ原則)。
3. Path B(`onboard:apply`)にもバックエンド状態の検証・報告を追加。
4. UX-03 の ja/en テンプレートに新プロンプトを載せる。
5. テスト: 一時環境で backend あり/なしのオンボード分岐。

### Task 3: スタブ実行時のユーザー警告 — `claude-sonnet-4`

1. スタブバックエンドが実際の推論要求(delegateTask / compile 等の実作業経路)で使われるとき、`logger.warn` だけでなく**ユーザー可視の警告**を応答に付ける(「⚠ 推論バックエンド未設定のため簡易応答です。`pnpm reasoning:setup` で有効化してください」)。UX-01 のエラー封筒機構を流用。
2. スタブが許容される文脈(オフラインの決定論テスト、`KYBERION_REASONING_BACKEND=stub` の明示指定)では警告を出さない(意図的スタブと未設定スタブを区別)。
3. テスト: 未設定スタブでの実作業 → ユーザー警告、明示スタブ → 警告なし。

### Task 4: reasoning:setup コマンド — `claude-sonnet-4`

1. `pnpm reasoning:setup`(既存の `sync:*`/`*:setup` 系の作法に倣う)を実装/整備: バックエンド候補を検出し、対話で選択・設定・疎通確認。CLAUDE.md の優先順位(claude-cli → anthropic → stub)を反映。
2. Task 2 のオンボードフェーズはこのコマンドを内部呼び出しする(重複実装を避ける)。
3. `docs/INITIALIZATION.md` / README の起動手順(ONB-02 で単一正本化)にこのステップを組み込む。

## リスクと注意

- バックエンド疎通確認は実 API 呼び出し(少額のトークン消費)を伴う。最小のプロンプトで行い、失敗時も明確に案内する。
- `must` 昇格は既存の doctor/vital を赤にするため、**現状スタブで運用しているユーザー(市村さんの現環境含む)にいきなり赤を出す**。移行として「未設定は赤だが、明示的に `KYBERION_REASONING_BACKEND=stub` を選んだ場合は黄 + 注記」にし、意図的スタブ運用を尊重する。
- claude CLI の検出・ログイン状態確認は環境依存。検出失敗時は API キー経路に案内し、行き止まりを作らない。
