# ハイブリッド・ナレッジ・プロトコル (Knowledge Protocol)

本モノレポの全スキルが遵守すべき、公開/機密ナレッジの取り扱い基準。

## 1. ナレッジの階層構造
- **Public Tier (`knowledge/`)**: 汎用基準、公開ドキュメント。GitHub同期対象。
- **Confidential Tier (`knowledge/confidential/`)**: 外部リポジトリ（シンボリックリンク）。自社固有資産。**絶対非公開**。
    - **Skill-Specific Folder**: `knowledge/confidential/skills/<skill-name>/` に各スキル専用の機密データを格納する。

## 2. スキルの行動原則 (Core Logic)
- **自己フォルダの優先参照**: 各スキルは実行時、まず `knowledge/confidential/skills/<自分の名前>/` に設定ファイルやルールが存在するか確認し、存在する場合はそれを最優先で適用すること。
- **優先順位**: 同じトピックに関する定義がある場合、必ず **Confidential Tier** の情報を優先して適用すること。
- **透過的参照**: ユーザーが場所を指定しない場合、スキルは自動的に両方の階層を検索すること。
- **漏洩防止 (Leak Prevention)**:
    - `pr-architect` や `stakeholder-communicator` は、外部（GitHub等）に公開される文章を作成する際、Confidential Tier の情報を「具体的な値（URL、パスワード、特定プロジェクト名等）」として出力してはならない。
    - 必要な場合は、抽象化またはマスキングした状態で出力すること。

## 3. 環境のセットアップ
- 新しい環境で本モノレポを使用する際は、必ず機密リポジトリをクローンし、`knowledge/confidential` へのシンボリックリンクを貼ること。
