# Diff-Based Security Scanning Strategy

全量スキャンの非効率性を排除し、変更差分（Diff）に基づいてリスクの高い箇所をピンポイントで診断するための戦略。

## 1. 差分解析ロジック (The Diff Analyzer)
`git diff --name-only` および `git diff -U0` を解析し、以下の基準でスキャン対象を絞り込む。

### A. 依存関係の変更 (`package.json`, `pom.xml`)
- **アクション**: `license-auditor` と `supply-chain-sentinel` を即時実行。
- **リスク**: 新規ライブラリの脆弱性、ライセンス汚染。

### B. 認証・認可ロジックの変更 (`auth/`, `login.js`, `rbac/`)
- **アクション**: `security-scanner` (SAST) を重点実行し、ACE Engine で S1/S2 リスクとして審議。
- **リスク**: 権限昇格、認証バイパス。

### C. 入力処理・APIエンドポイントの変更 (`api/`, `controllers/`)
- **アクション**: SQLインジェクション、XSS、バリデーション漏れをチェック。
- **リスク**: 外部からの攻撃起点。

### D. 設定ファイルの変更 (`config/`, `.env.example`, `Dockerfile`)
- **アクション**: 秘密情報の混入（Secret Scan）と、不適切な権限設定（Misconfiguration）をチェック。

## 2. 実行フロー (Pulse Integration)
1. `local-reviewer` スキルが `git diff` を取得。
2. 上記ロジックに基づき、必要なスキャン・スキル（SAST, SCA, Secret Scan）を動的に選択。
3. 選択されたスキルのみを並列実行し、最短時間で結果を出す。

---
*Created: 2026-02-14 | Security Reviewer & Focused Craftsman*
