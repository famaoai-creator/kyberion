# Kyberion を作る理由

「誰の」「何を」「なぜ Kyberion でなければ」解けないのかへの短い答え。

## 課題

ナレッジワーカー — 特に経営者、ファウンダー、FDE / SI エンジニア — は、毎日の仕事の大半を **構造的だが文脈に依存する反復作業** に費やしている:

- 5 つの SaaS をまたいだ承認レビュー。
- PDF を読んで要約し、適切な Notion / Slack / メールに入れる。
- 会議レポート、フォローアップ、ステークホルダー更新 — 毎週同じ形。
- ベンダー更新期限が近づくのを横目に、社内 3 チームを追いかける。

既存ツールは 2 つに大別される:

1. **汎用 LLM chat (ChatGPT, Claude.ai)** — 柔軟だがステートレス。文脈を覚えない、ガバナンスもない、実行もしない。毎回ゼロから説明する。
2. **RPA / ノーコード自動化 (Zapier, n8n, UiPath)** — 実行はできるが脆い。すべてのワークフローは「点 to 点」の硬直したルールで、*意図* を理解しない。

どちらも組織の実際の動き方とは合っていない。組織は本来こう動く:

```
Intent → Plan → Result
```

「トリガー → アクション → 出力」とは考えない。「X を片付けたい、あとは任せる」と考える。

## Kyberion とは

Kyberion は **組織の Work Loop エンジン** である: 意図を、ガバナンスされた実行・証跡・再利用可能な記憶へと変換する。

実際の使い方:

- 成果ベースで指示する（`今週の進捗レポートを作って`、`この PDF をパワポにして`、`経費承認を進めて`）。
- Kyberion が手順を立て、本質的に曖昧な点だけ確認し、実行する。
- 毎回の実行が、結果・成果物・後続が学習できる trace を残す。
- 複数の actuator（browser、voice、file、code 等）が手順を実行。承認ポリシー・tier 分離・監査チェーンに従う。

経験で例えると:

- `Computer Use` / ブラウザ操作エージェント → それを mission state・ガバナンス・再利用可能ナレッジで上から覆ったもの。
- `Cursor` / コーディングエージェント → より広い。code は actuator の 1 つにすぎず、作業単位は永続化された mission（チャット 1 回ではない）。
- RPA → 脆いルール連鎖を、意図駆動の plan に置き換える。サイトが変わっても survive する。

## ターゲット

優先順:

1. **ファウンダー / 経営者 / パワーユーザ** — 反復的な認知労働を delegate したい。証跡付きで *実際に* やってほしい人。
2. **FDE / SI エンジニア** — Kyberion ベースの自動化を顧客に届ける、fork なしのカスタマイズが必要な人。
3. **OSS コントリビュータ** — actuator / pipeline / vertical テンプレートを上に積み上げる人。

**ターゲットでない人**:

- 時々の質問にチャット UI が欲しい人（Claude.ai / ChatGPT で十分）。
- 今すぐ turnkey SaaS が欲しいチーム（Kyberion は OSS first、SaaS は需要が証明された後）。
- コーディング専門のアシスタントが欲しい人（Cursor）。

## 差別化

| 特徴 | なぜ重要か |
|---|---|
| **Mission を一級の state として扱う** | 1 つの仕事は固有の git repo・state・evidence を持つ。再起動・監査・24h+ 実行に耐える |
| **3 階層ナレッジ分離** | Personal / Confidential / Public、ファイル I/O 境界で強制。顧客の秘密が再利用ナレッジに漏れない |
| **semver 化された actuator カタログ** | browser/voice/file/code/network 等 23+ actuator。各々が semver 安定契約を持ち、3rd-party 拡張が腐らない |
| **ADF（ガバナンス済み pipeline 形式）** | バリデーション・サブパイプライン合成・宣言的 `on_error`。YAML スープではない |
| **顧客集約ポイント** | `customer/{slug}/` 1 ディレクトリで FDE カスタマイズを吸収。80%+ で fork 不要 |
| **Trace + ガバナンス** | 毎実行が構造化 trace + 監査チェーン。失敗は分類されて再利用可能な hint に蓄積 |
| **Voice-native UX** | 声で話しかけて、声で返ってくる。ブラウザから、API key 不要 |

## 戦略賭け

ナレッジワークは「LLM を使って手作業」から「delegate して検証」に移行している。勝者は最もチャットが流暢なモデルではなく、以下を満たすシステム:

1. **意図を確実に捕捉する** — delegate を安全にするため。
2. **証跡と監査がある** — 検証を高速にするため。
3. **組織記憶を蓄積する** — 同じ問題に二度コストを払わないため。

Kyberion は「**LLM ではなくエンジンが** 持続資産になる」という賭け。LLM は半年ごとに置き換わる。LLM をガバナンスされた組織労働に変換するエンジンが、それより長く生き残る。

## 現在地

Kyberion は **OSS、活発に開発中**。直近の焦点（`docs/PRODUCTIZATION_ROADMAP.md`）:

- Phase A: 任意の開発者にとって 5 分の first-win に。
- Phase B: 30 日の連続運用に耐えるように。
- Phase C': 1 週間以内に外部 contributor が貢献できる土壌に。
- Phase D': fork なしで FDE / 導入支援案件が回るように。

ここまで読んで興味を持ったなら、次は [Quickstart](./QUICKSTART.md)。先にアーキテクチャを理解したいなら [`knowledge/public/architecture/organization-work-loop.md`](../knowledge/public/architecture/organization-work-loop.md) から。
