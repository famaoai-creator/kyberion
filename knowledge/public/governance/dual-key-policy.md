---
title: Dual-Key Policy
category: Governance
tags: [ace, protocol, role-management, safety]
importance: 10
related_roles: [Ecosystem Architect, Engineering]
last_updated: 2026-03-06
---

# Dual-Key Policy: ロール管理と決定権限の標準規約

この規約は、AIエージェントが複数の専門性（ロール）を持ちつつ、ガバナンスと責任の所在を明確に維持するための物理的なルールを定義する。

## 1. 思考と決定の分離 (Separation of Reasoning and Decision)

エージェントは「大脳（思考）」と「脊髄（実行）」において異なる制御モデルを採用する。

1.  **ハイブリッド思考 (Hybrid Reasoning)**:
    - エージェントは、過去のロールでの記憶や複数の専門家視点を同時にコンテキストに保持し、深く洞察することを推奨される。
    - 複数のロールが対話する「ACE（合意形成プロトコル）」を内部的に実行し、多角的な判断を行う。
2.  **単一ロール決定 (Single-Role Decision)**:
    - 物理的な書き込み操作（`replace`, `write_file`, `run_shell_command` 等）および `contract.json` の更新を行う際は、必ず **「現在のアクティブなロール」** を1つに定めなければならない。
    - 決定は、そのロールに与えられた書き込み権限（`GEMINI.md` 参照）の範囲内に制限される。

## 2. ロール・スイッチング・プロトコル

ロールを切り替える際、以下の手順を遵守する。

1.  **インテントの宣言**: 「現在のタスクを完了するため、[Role Name] にスイッチする」と宣言する。
2.  **コンテキストの継承**:
    - 前のロールの思考プロセスは「短期記憶」として保持してもよいが、重要な事実は必ず `[SUMMARY]` 形式で抽出する。
3.  **証跡の記録**: ロールを跨ぐ重要な合意事項は、必ず **ACE Report (JSON)** として物理的に保存する。

## 3. ロールとナレッジの階層적マッピング

ロールごとに参照・遵守すべきナレッジの優先順位を以下に定める。

- **Primary**: アクティブなロールに直結するドメインナレッジ（例：エンジニアなら `standards/engineering/`）。
- **Design & UX Quality Gate**: デザイン、色彩、文言、およびユーザー体験に関する変更が含まれる場合、必ず **「Aesthetic Pragmatist」** または **「Empathetic CXO」** を ACE 審議に参加させ、感性および美的エレガンスの観点から承認を得なければならない。
- **Secondary**: 全ロール共通の標準（`standards/common/`, `governance/`）。
- **Sovereign (3-Tier)**: データの機密性に基づくアクセス制御。アクティブなロールの権限範囲内でのみアクセス可能。

## 4. コンテキスト消去とバイアス防止 (Context Purge & Bias Prevention)

特定の条件下において、エージェントは前のロールのコンテキストを明示的に消去（Purge）しなければならない。

1.  **権限境界の強制リセット (Privilege Boundary Reset)**:
    - 書き込み制限（Read-Only vs Write）の異なる領域を跨ぐロール変更時、エージェントは短期記憶（Chat History）をリセットし、物理的なエビデンス（ADF/JSON）のみから状況を再構築する。
2.  **バイアス防止モード (Unbiased Assessment)**:
    - `ACE` において「客観的な第三者評価」が求められる場合、エージェントは意図的に前のロールの思考プロセスを遮断（Masking）する。
3.  **ミッション完了時のクリーンアップ**:
    - ミッションフォルダ（`active/missions/`）に最終成果物を保存した直後、当該ミッションに関する全ての短期記憶を消去する。継承は物理的な「蒸留知（Distilled Knowledge）」を通じてのみ行われる。

---

_Approved by ACE | Ecosystem Architect | 2026-02-16_
