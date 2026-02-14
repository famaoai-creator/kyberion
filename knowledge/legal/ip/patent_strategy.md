# Legal & Intellectual Property Strategy

ソフトウェア開発における知的財産権（IP）の保護と活用戦略。

## 1. 攻めの知財 (Patenting Strategy)
- **発明発掘 (Harvesting)**: 独自性の高いアルゴリズムや、新規性のあるUI/UX（例: Chronos Mirrorの時間軸UI）を検知し、特許出願候補としてマークする。
- **Defensive Publishing**: 特許化しない技術は、技術ブログ等で公開し、他社による特許取得を防ぐ（公知化）。

## 2. 守りの知財 (Risk Mitigation)
- **OSS License Compliance**: `license-auditor` を使い、GPL汚染（Copyleft）による自社コードの強制公開リスクを防ぐ。
- **Contributor License Agreement (CLA)**: 外部からのPRを受け入れる際、著作権の帰属を明確にする。

## 3. シークレット管理 (Trade Secrets)
- 競争優位性の源泉となる「営業秘密（アルゴリズムのパラメータ、学習データ）」は、Gitには含めず `knowledge/confidential/` などの厳格な隔離領域でのみ扱う。

---
*Created: 2026-02-14 | Guardian of Ethics & IP*
