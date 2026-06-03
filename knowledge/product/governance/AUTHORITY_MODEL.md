# Authority, Role & Persona Model (v3.0)

## 1. 概要

Kyberion の権限モデルは **ExecutionMode** を中心に再設計されました。プロセスがどの領域で動いているかを `system / mission / sovereign` の 3 モードで明文化し、モードごとに書き込み可能なパスを厳格に分離します。

### 命名の注意

| 用語 | 定義 | 値の数 | 場所 |
|---|---|---|---|
| **Persona** | 実行コンテキスト ID | 6 種 | `libs/core/types.ts` |
| **Perspective** | AI 思考スタイル | 27 種 | `knowledge/product/personalities/matrix.md` |
| **Authority** | 物理操作の特権 | 6 種 | `libs/core/types.ts` |
| **docAuthority** | ドキュメント信頼レベル | 5 段階 | knowledge frontmatter |

以前は "Persona" が実行 ID と思考スタイルの両方に使われていました。v3.0 からは思考スタイルを **Perspective** と呼びます。

---

## 2. ExecutionMode (実行モード)

プロセスの動作領域を 3 つに分類します。Persona から自動導出されます。

```
persona === 'sovereign'           → executionMode = 'sovereign'
persona === 'ecosystem_architect' → executionMode = 'system'
それ以外                           → executionMode = 'mission'
```

### SYSTEM モード (`ecosystem_architect`)
Kyberion 自体のメンテナンス。

| | 対象パス |
|---|---|
| 書き込み可 | `knowledge/product/`, `libs/`, `scripts/`, `pipelines/`, `schemas/`, `presence/`, `satellites/`, `plugins/`, root ドキュメント群, `active/audit/`, `active/shared/logs/` |
| 書き込み不可 | `knowledge/personal/`, `knowledge/confidential/`, `active/missions/`, `active/projects/`, `customer/` |

### MISSION モード (`worker`, `analyst`, `mission_owner`)
ミッション・タスクの実行。

| | 対象パス |
|---|---|
| 書き込み可 | `active/missions/${MISSION_ID}/`, `active/projects/`, `customer/`, `knowledge/product/evolution/`（蒸留のみ）, `active/audit/`, `active/shared/logs/` |
| 書き込み不可 | `knowledge/product/`（evolution 以外）, `libs/`, `scripts/`, `knowledge/personal/`, `knowledge/confidential/` |

### SOVEREIGN モード (`sovereign`)
緊急・全権。すべての操作が audit に記録されます。

---

## 3. 構成要素

### A. Persona (実行 ID)
`KYBERION_PERSONA` 環境変数または `resolveIdentityContext()` で解決されます。
- **sovereign**: 全境界を超越。すべてが audit 記録対象。
- **ecosystem_architect**: SYSTEM モード。Kyberion コアの維持管理専用。
- **mission_owner**: MISSION モード上位。ミッション全体を統制。
- **worker**: MISSION モード。プロジェクト・ミッションのサンドボックス内に制限。
- **analyst**: MISSION モード。ナレッジ読み取りと蒸留書き込みに特化。
- **unknown**: 未解決。ほとんどの書き込みが拒否される。

### B. Authority Role (機能ロール)
`MISSION_ROLE` として注入され、`security-policy.json` の `authority_role_permissions` と対応します。

28 の知識ロールと Authority Role の対応は `knowledge/product/governance/role-authority-map.json` を参照してください。

- **system_roles** (6): `ecosystem_architect`, `knowledge_steward`, `solution_architect`, `integration_steward`, `reliability_engineer`, `infrastructure_sentinel`
- **mission_roles** (5): `mission_controller`, `software_developer`, `sovereign_concierge`, `incident_commander`, `performance_engineer`
- **context_roles** (16): `ceo`, `business_owner`, `product_manager` など。Authority Role はなく、ナレッジ上の責務定義のみ。

Authority role definitions: `knowledge/product/governance/authority-roles/*.json`

### C. Authority (特権)
特定の物理操作に対して与えられる、時間制限付きの「鍵」です。
- **SUDO**: セキュリティガードを完全にバイパスする全能特権。
- **GIT_WRITE**: リポジトリの変更・ブランチ操作。
- **SECRET_READ**: 秘匿情報の取得（スコープ制限あり）。
- **SYSTEM_EXEC**: 任意のシェルコマンド実行。
- **NETWORK_FETCH**: 外部 API との通信。
- **KNOWLEDGE_WRITE**: ナレッジ層の直接変更。

### D. Tier (知識階層)

| Tier | パス | 書き込み可能な Persona |
|---|---|---|
| **product** | `knowledge/product/` | `sovereign`, `ecosystem_architect` |
| **confidential** | `knowledge/confidential/` | `sovereign`（ecosystem_architect 不可） |
| **personal** | `knowledge/personal/` | `sovereign` のみ |
| **public** | `knowledge/public/` | `sovereign`, `ecosystem_architect` |

> v3.0 変更点: `confidential` から `ecosystem_architect` の write を削除（SYSTEM モードは confidential に書かない）。

---

## 4. 評価順序

権限判定は次の順で行われます。
1. `default_allow`（`active/audit/`, `active/shared/logs/` を含む）
2. `Authority` による明示的な許可
3. `Authority Role` による実行スコープ許可
4. `Persona` による恒常的な許可
5. `Tier` 制約による deny
6. 明示的に許可されなかった経路の deny

---

## 5. ガバナンス・プロトコル

### Temporal Grant (時間制限付き付与)
Authority は原則としてミッションに紐づけて発行されます。Authority Role は長寿命の責務、Authority は短寿命の鍵です。
- `mission_controller grant <MISSION_ID> <SERVICE_ID>` により、必要なときだけ権限を委譲します。
- 付与された権限は `active/shared/auth-grants.json` に記録され、期限が切れると自動的に無効化されます。

### Sovereign Sudo (主権者による委譲)
緊急時や初期設定時、主権者は明示的に `SUDO` モードを起動できます。
- `mission_controller sudo <MISSION_ID> ON`
- この操作は system-ledger に永久に記録され、監査の対象となります。

---

## 6. 起動時の環境変数

サーフェスやバックグラウンドサービスを起動する際、`KYBERION_PERSONA` と `MISSION_ROLE` を正しく渡す必要があります。設定は `knowledge/product/governance/surfaces/<surface-id>.json` の `"env"` プロパティに定義します。

```json
"env": {
  "KYBERION_PERSONA": "worker",
  "MISSION_ROLE": "surface_runtime"
}
```

Persona が `unknown` のままだとほとんどの書き込みが拒否されます。`resolveIdentityContext()` の返す `executionMode` で現在のモードを確認できます。

---

*Status: v3.0 — ExecutionMode / 4-tier / 28-role mapping (2026-06-02)*
