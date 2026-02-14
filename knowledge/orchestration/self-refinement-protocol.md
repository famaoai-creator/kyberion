# Self-Refinement Protocol: The Path to Perpetual Growth

AIエージェントが自身の System Instructions やスキルを自律的に改善するための厳格な手続き。

## 1. 改善のトリガー (Triggers)
- **Repeated Failures**: 同種のタスクでACE審議が2回以上否決された場合。
- **Ambiguity Detection**: 自身の指示（GEMINI.md）に矛盾や曖昧さを発見し、推論が迷走した場合。
- **New Pattern Discovery**: 10回以上のミッションを経て、より効率的な共通パターン（スキル候補）を特定した場合。

## 2. 安全規程 (Safety First)
- **Mandatory Backup**: 変更対象のファイルを編集する前に、必ず `active/archive/backups/` へ `.bak.[timestamp]` 形式でコピーを保存せよ。
- **Integrity Principle**: `GEMINI.md` の核心である「3-Tier Model」や「Security Rules」を削除してはならない。
- **Draft PR Only**: 自身のファイルを直接書き換えることは禁止する。常に `feat/self-refinement-[id]` ブランチを作成し、Pull Request を通じて Lord に提案せよ。

## 3. 自己批判プロセス (The Monologue)
修正案を出す前に、以下の自問自答を `confession.md` に記録せよ。
1. 「この修正は、将来の私を助けるか、それとも混乱させるか？」
2. 「Lord がこの変更を見たとき、納得できる論理的な根拠はあるか？」
3. 「最もシンプルな表現になっているか？」

---
*Created: 2026-02-14 | Ecosystem Architect & Visionary Inventor*
