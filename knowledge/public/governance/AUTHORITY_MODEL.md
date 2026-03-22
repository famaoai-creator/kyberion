# Authority, Role & Persona Model (v2.3)

## 1. 概要
Kyberion エコシステムにおける権限管理は、物理的なプロセス制限（Actuator レベル）から、論理的な人格（Persona）、機能上の担当（Authority Role）、明示的な特権（Authority）に基づく高度な統制モデルへと進化しました。

## 2. 構成要素

### A. Persona (人格)
「誰として振る舞うか」を定義する論理的な ID です。
- **sovereign**: システムの主権者。すべての境界を超越した権限を持ちます。
- **ecosystem_architect**: システムの設計者。コアライブラリ、Actuator、ガバナンスポリシーの変更権限を持ちます。
- **worker**: 実務実行者。特定のプロジェクトやミッションのサンドボックス内に制限されます。
- **analyst**: 分析担当。ナレッジ層の読み取りと、蒸留結果の書き込みに特化します。

### B. Authority Role (機能ロール)
「何の責務で動いているか」を定義する実行上のロールです。`MISSION_ROLE` として注入され、`security-policy.json` の `authority_role_permissions` と対応します。
- **mission_controller**: ミッション lifecycle、監査、shared coordination を担当します。
- **slack_bridge**: Slack の ingress、channel coordination、observability を担当します。
- **chronos_gateway**: Chronos control surface と terminal routing を担当します。
- **surface_runtime**: runtime surface の reconciliation を担当します。
- **software_developer**: 実装・試験用コードパスの変更を担当します。

### C. Authority (特権)
特定の物理操作に対して与えられる、時間制限付きの「鍵」です。
- **SUDO**: セキュリティガードを完全にバイパスする全能特権。
- **GIT_WRITE**: 履歴の改変およびブランチ操作。
- **SECRET_READ**: 秘匿情報の取得（GitHub トークン等）。
- **SYSTEM_EXEC**: 任意のシェルコマンド実行。
- **NETWORK_FETCH**: 外部 API との通信。

### D. Tier (知識階層)
物理的なディレクトリ構造に基づく情報の機密性です。
- **Personal**: 主権者専用の聖域。
- **Confidential**: 組織内の機密。
- **Public**: 一般公開および再利用可能な知恵。

## 3. 評価順序

権限判定は次の順で行われます。
1. `default_allow`
2. `Authority` による明示的な許可
3. `Authority Role` による実行スコープ許可
4. `Persona` による恒常的な許可
5. `Tier` 制約による deny
6. 明示的に許可されなかった経路の deny

## 4. ガバナンス・プロトコル

### Temporal Grant (時間制限付き付与)
特権（Authority）は、原則としてミッションに紐づけて発行されます。Authority Role は長寿命の責務、Authority は短寿命の鍵です。
- `mission_controller grant <MISSION_ID> <SERVICE_ID>` コマンドにより、必要なときだけ権限を委譲します。
- 付与された権限は `active/shared/auth-grants.json` に記録され、期限が切れると自動的に無効化されます。

### Sovereign Sudo (主権者による委譲)
緊急時や初期設定時、主権者は明示的に `SUDO` モードを起動できます。
- `mission_controller sudo <MISSION_ID> ON`
- この操作は `system-ledger` に永久に記録され、監査の対象となります。

---
*Status: Updated for v2.3 Persona / Authority Role separation (2026-03-22)*
