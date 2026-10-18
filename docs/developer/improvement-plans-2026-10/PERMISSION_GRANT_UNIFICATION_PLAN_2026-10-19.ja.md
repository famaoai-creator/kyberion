---
title: '事前許可(同意・承認・egress・OS 許可)の統一 改善計画 (PG-01〜09)'
tags: [improvement-plan, governance, consent, approval, egress, permission, meeting]
last_updated: 2026-10-19
status: partial
---

# 事前許可(同意・承認・egress・OS 許可)の統一 改善計画 (PG-01〜09)

- 状態: **PG-01〜02 実装済み(MSN-GRANT-UNIFY-20261019)。PG-02b〜09 は未着手**
- 発端: 会議の録画やコンソールでのマイク録音で、本番直前に「マイク許可」「会議ミッションの voice consent」を慌てて取ることになり、開始が遅れる。調べると、同意・承認・egress・OS 許可が別々の仕組みで実装されており、粒度・期限・取消・監査がそろっていない。
- 関連:
  - [HUMAN_APPROVAL_TRUST_PLAN](./HUMAN_APPROVAL_TRUST_PLAN_2026-10-05.ja.md)(承認者の本人性と assurance。本計画はその上に乗る)
  - [SCOPE_GOVERNANCE_UNIFICATION_PLAN](./SCOPE_GOVERNANCE_UNIFICATION_PLAN_2026-10-03.ja.md)(スコープ軸の統一)
  - [WORK_INVENTORY_PLAN](../improvement-plans-2026-09/WORK_INVENTORY_PLAN_2026-09-22.ja.md)(作業観察の同意。本計画の手本)
  - [entity-scope-hierarchy](../../../knowledge/product/architecture/entity-scope-hierarchy.md)

## 0. 問題

### 0.1 体験の問題

会議を録画する直前に、次の 2 つを同時に片付ける必要がある。

1. **OS の許可**: macOS のマイク許可(TCC)。
   - 許可は「マシン × 要求したアプリ」単位で、一度出せば続く。
   - ところが誰も事前に確認・要求しない。初回キャプチャの瞬間にダイアログが出る。
   - 要求元のアプリは経路で変わる(ffmpeg / swift はそれを起動したターミナル、Playwright 経路は Chromium、拡張経路は Chrome)。ターミナルを替えると再び初回扱いになる。
   - `meeting_preflight` は実状態を見ず、`KYBERION_AUDIO_PERMISSION_CONFIRMED=1` の自己申告で pass にしている。
2. **Kyberion への運用許可**: `voice-consent.json`(purpose = recording / voice)。
   - 会議ミッションごとに `pnpm meeting:consent grant --mission …` で作る。
   - ミッションは会議の直前に立つので、許可も直前になる。
   - 「この定例会議は録音してよい」という判断は毎回同じなのに、毎回やり直している。

### 0.2 仕組みの問題(棚卸し結果)

| #   | 仕組み                         | 実装                                                                       | スコープ単位          | 付与者                                     | 期限             | 取消           | 監査                    | 既定                           |
| --- | ------------------------------ | -------------------------------------------------------------------------- | --------------------- | ------------------------------------------ | ---------------- | -------------- | ----------------------- | ------------------------------ |
| 1   | 承認ストア                     | `governance/approval-store.ts`                                             | 依頼 1 件             | 人間(assurance A0〜A3)                     | 任意             | あり、1 回消費 | auditChain              | fail-closed                    |
| 2   | 会議 voice consent             | `voice/voice-consent.ts`、検査は coordinator と meeting-session に**重複** | ミッション            | `--operator` 自由文字列(既定 `'operator'`) | 任意             | 上書き         | MissionEvidenceDoc      | fail-closed(SUDO で迂回)       |
| 3a  | プロバイダ egress attestation  | `provider/provider-egress-gate.ts`、`tenant-registry.ts`                   | テナント × プロバイダ | operator(`attested_by`)                    | 既定 180 日      | **なし**       | auditChain              | fail-closed                    |
| 3b  | ドメイン egress                | `egress-policy.ts`                                                         | テナント × ドメイン   | リポジトリ編集                             | なし             | なし           | warn レポート           | **warn**                       |
| 3c  | リアルタイム音声の egress/録音 | `realtime-media-session.ts`                                                | セッション            | 呼び出し側の boolean                       | なし             | なし           | なし                    | 自己申告                       |
| 4   | 作業観察(業務棚卸し)           | `workforce/work-inventory-consent.ts`                                      | メンバー × 観察種別   | **本人のみ**                               | 必須、最大 90 日 | あり           | 記録前に audit          | fail-closed                    |
| 5   | 画像参照 egress                | `media/image-reference-consent.ts`                                         | 実行 1 回             | `granted_by` 文字列                        | 1 時間           | なし           | dispatch ごとの receipt | fail-closed                    |
| 6   | タスク委任 grant(NHI)          | `task/task-scoped-grants.ts`                                               | ミッション × タスク   | dispatcher                                 | 最大 24 時間     | タスク完了時   | auditChain              | fail-closed                    |
| 7   | env の自己申告                 | `KYBERION_SUDO`、`KYBERION_AUDIO_PERMISSION_CONFIRMED` など                | プロセス              | env を設定した者                           | なし             | なし           | **なし**                | 開放                           |
| 8   | OS 許可(TCC)                   | `macos-native-automation.swift` の probe                                   | マシン × アプリ       | OS ユーザー                                | OS 管理          | OS 管理        | なし                    | probe のみ、**マイクは未対応** |

ここから分かること:

- **付与者の本人性の強さがばらばら**。作業観察と承認ストアは認証済み、voice consent と画像 egress は自由文字列、env は誰でも。
- **期限・取消の扱いがばらばら**。必須 90 日、既定 180 日、1 時間、任意、なし、が混在する。
- **同じ「録音してよい」が 2 系統ある**。voice consent(ミッション単位)と作業観察同意(メンバー単位)が互いを知らない。
- **確認する入口が仕組みごとに違う**。事前に「何が足りないか」を一覧する手段がない。

## 1. 目標

1. 同意・承認・egress 許可・OS 許可を **1 つの語彙(Grant)と 1 つの判定 API** で扱う。保存先の物理統合は目標にしない。
2. **変わらない判断は事前に、毎回変わるものだけ当日に**。常設の許可(standing grant)を持てるようにし、ミッションには自動で紐づける。
3. **足りない許可を事前に一覧できる**。会議の前日・直前に readiness として出す。
4. OS 許可は **実状態を probe** し、明示コマンドでのみ事前要求(warm-up)する。自己申告 env は使わない。
5. 付与者の本人性・期限・取消・監査を **能力(capability)ごとのポリシー** で宣言し、判定時に検査する。

### 対象外

- **会議参加者の同意**(録音されることへの参加者の同意)。必要になった時点で、本モデルの capability として追加する。
- 承認ストア内部の本人性強化(HUMAN_APPROVAL_TRUST_PLAN の範囲)。
- クロステナント brokering の承認(別計画)。

## 2. 設計

### 2.1 Grant の種類(誰が決めるか)

| 種類             | 意味                                               | 例                                                     | 本計画での扱い                           |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `os_permission`  | OS がアプリに与えた権限。Kyberion は付与できない   | マイク、カメラ、画面収録、アクセシビリティ、Automation | probe で観測し、warm-up で要求を促すだけ |
| `standing_grant` | 範囲と期限つきの常設許可(同意・attestation を含む) | 会議録音、プロバイダ egress、作業観察、ドメイン egress | 新しい共通レコードと判定 API の中心      |
| `approval`       | 特定の内容に対する 1 回限りの人間の決定            | scope-approve、secret mutation、plugin install         | 既存の承認ストアをそのまま使う(参照のみ) |
| `delegation`     | システムが NHI に与える短期の委任                  | task-scoped grants                                     | 既存のまま(参照のみ)                     |

`standing_grant` の付与自体に人間の承認が要る capability は、承認ストアの approval を付与の根拠として参照する(`basis.approval_request_id`)。承認と同意は別物ではなく、「1 回限り」か「範囲つきで常設」かの違いとして扱う。

### 2.2 capability カタログ

`knowledge/product/governance/grant-capability-policy.json` に capability ごとの規則を宣言する。

```jsonc
{
  "capabilities": {
    "meeting.recording": {
      "kind": "standing_grant",
      "scope_keys": ["tenant_slug", "meeting_series"], // 必須の束縛軸
      "granted_by": ["operator"], // operator | member_self | sovereign
      "min_assurance": "A1",
      "max_ttl_days": 90,
      "mission_binding": "auto", // auto | per_mission
      "sudo_bypass": false,
    },
    "meeting.voice": {
      "kind": "standing_grant",
      "scope_keys": ["tenant_slug", "mission_id"],
      "mission_binding": "per_mission", // 発話は常設にしない
      "max_ttl_days": 1,
    },
    "provider.egress": {
      "kind": "standing_grant",
      "scope_keys": ["tenant_slug", "provider"],
      "max_ttl_days": 180,
    },
    "os.microphone": {
      "kind": "os_permission",
      "host_apps": ["terminal_host", "chrome", "playwright_chromium"],
    },
    "os.screen_recording": { "kind": "os_permission" },
  },
}
```

### 2.3 Grant レコード(standing_grant)

```ts
interface GrantRecord {
  grant_id: string;
  capability: string; // grant-capability-policy のキー
  scope: Partial<{
    tenant_slug: string;
    organization_id: string;
    project_id: string;
    mission_id: string;
    member_id: string;
    meeting_series: string; // カレンダーのシリーズ ID や会議 URL の正規形
    provider: string;
    domain: string;
  }>;
  purpose: string;
  granted_by: {
    actor_id: string;
    role: 'operator' | 'member_self' | 'sovereign';
    assurance: 'A0' | 'A1' | 'A2' | 'A3';
  };
  basis?: { approval_request_id?: string };
  granted_at: string;
  expires_at: string; // 必須。policy の max_ttl_days で上限
  revoked?: { at: string; by: string; reason?: string };
  audit_event_id: string; // 記録より先に audit を書く(作業観察同意と同じ順序)
}
```

- 保存先: テナントのデータなので `active/shared/runtime/<tier>/<tenant>/grants/`(storage-layout のフロア)。メンバー本人の同意は従来どおり personal tier。
- 既存ストア(voice-consent、provider attestation、作業観察同意、画像 egress)は**移行しない**。判定 API の adapter として読む(PG-05)。

### 2.4 判定 API

```ts
resolveGrant({ capability, context }): {
  allowed: boolean;
  source?: 'standing' | 'mission' | 'approval' | 'os' | 'legacy';
  grant_id?: string;
  reason?: string;
  remedy?: string;                   // 何をすれば通るか(コマンド)
}
```

- fail-closed。壊れたレコード、期限切れ、ポリシー違反は「無い」とみなす。
- `KYBERION_SUDO` の迂回は capability ごとの `sudo_bypass` で宣言し、迂回したことを audit に残す。
- **ミッションへの紐づけ**: ミッション文脈で standing grant により許可されたら、`<mission>/evidence/grant-bindings.jsonl` に「どの grant で通ったか」を 1 行記録する。ミッションの証跡はこれまでどおり完結する。

### 2.5 OS 許可の probe と warm-up

- **probe**(副作用なし): `macos-native-automation.swift` の `probe` に `microphone` / `camera` を追加する。`AVCaptureDevice.authorizationStatus` は要求ダイアログを出さない。既存の不変条件(probe は許可を要求しない)を守る。
  - 結果は「この probe を実行したホストアプリ(ターミナル)」の状態である点を、出力に `host_app` として明示する。
- **warm-up**(明示コマンドのみ): `pnpm kyberion permissions warmup`。
  - 未決定(`notDetermined`)のときだけ、別の Swift(`macos-permission-warmup.swift`)が `AVCaptureDevice.requestAccess` を呼び、ダイアログを出させる。
  - 拒否済み(`denied`)は再要求できないので、システム設定の該当ペインを開く案内を返す。
  - Chrome / Playwright Chromium はブラウザで `getUserMedia` を一度呼ぶ。対象は後続(PG-02b)。
  - 画面収録は `CGRequestScreenCaptureAccess` を warm-up コマンドの中だけで呼ぶ。probe の不変条件はそのまま。
- `meeting_preflight` の `audio.permission` は probe の実状態で判定する。`KYBERION_AUDIO_PERMISSION_CONFIRMED` は probe が使えないとき(非 darwin、Swift 不在)だけの退避に格下げし、deprecated とする。

### 2.6 readiness(事前一覧)

- `pnpm kyberion grants status [--for meeting:<id>|mission:<id>] [--json]`
  - 会議やミッションに必要な capability をポリシーから引き、`resolveGrant` で 1 件ずつ判定して不足と remedy を並べる。
- `meeting_preflight` は readiness を内部で呼び、OS 許可と運用許可を同じ表で出す。
- カレンダーの会議の前(前日と 1 時間前)に readiness を走らせ、不足があれば通知する(PG-07)。

## 3. タスク

| ID     | 内容                                                                                                | 依存         | 状態     |
| ------ | --------------------------------------------------------------------------------------------------- | ------------ | -------- |
| PG-01  | OS 許可 probe にマイク・カメラを追加し、`meeting_preflight` を実状態で判定する(env は退避に格下げ)  | —            | 実装済み |
| PG-02  | `pnpm kyberion permissions warmup`(ターミナルホストのマイク・カメラ・画面収録)                      | PG-01        | 実装済み |
| PG-02b | warm-up を Chrome / Playwright Chromium に広げる                                                    | PG-02        | 未着手   |
| PG-03  | Grant の型・`grant-capability-policy.json`・ストア・`resolveGrant`(standing_grant と os_permission) | —            | 未着手   |
| PG-04  | `meeting.recording` の常設許可とミッション自動紐づけ。voice consent の重複検査を 1 本化             | PG-03        | 未着手   |
| PG-05  | 既存ストアの adapter 化(provider attestation、作業観察同意、画像 egress、承認ストアの参照)          | PG-03        | 未着手   |
| PG-06  | `pnpm kyberion grants status` と `meeting_preflight` への統合                                       | PG-03〜05    | 未着手   |
| PG-07  | カレンダー会議の前の readiness 通知                                                                 | PG-06        | 未着手   |
| PG-08  | Concierge 設定の「録音への同意」を Grant 一覧に広げる(付与・取消、i18n 必須)                        | PG-03        | 未着手   |
| PG-09  | env 自己申告の整理(`KYBERION_AUDIO_PERMISSION_CONFIRMED` 廃止、`KYBERION_SUDO` 迂回の audit 化)     | PG-01、PG-03 | 未着手   |

### PG-01〜02 のレビュー指摘への対応

- `.restricted`(MDM やスクリーンタイムでの制限)は `restricted` という別の状態にした。運用者はシステム設定で直せないので、案内は「管理者に依頼」にしている(`MICROPHONE_PERMISSION_RESTRICTED`)。
- warm-up はホストアプリ(ターミナル)を特定できないときは何も要求しない(`host_app_unknown`)。用途説明を持たないデーモンが `requestAccess` で落ちるのを防ぐため。
- warm-up は kind ごとに別プロセスで実行するので、1 つが失敗してもほかの結果は残る。
- 残課題: `meeting_preflight` の pass は、probe を実行したホストアプリの許可。実際の録音を別プロセス(Playwright の Chromium など)が行う場合は PG-02b で経路ごとに判定する。

## 4. 移行と互換

- 既存の `voice-consent.json` はそのまま有効。PG-04 以降は「standing grant で通った場合も、従来の手動 grant で通った場合も」同じ判定結果になる。
- `KYBERION_AUDIO_PERMISSION_CONFIRMED=1` は PG-01 以降、probe が使えない環境での退避としてだけ効く。PG-09 で削除する。
- 発話(`meeting.voice`)はミッションごとの明示許可のまま。常設許可では通らない。

## 5. 未決事項

1. `meeting.recording` の束縛軸 `meeting_series` の正規形(カレンダーのシリーズ ID か、会議 URL か、両方か)。
2. standing grant の付与に承認ストアの approval を必須にする capability の範囲(provider egress は必須、会議録音は operator 本人の付与で足りる、が初期案)。
3. ドメイン egress(warn 運用)を Grant に含めるか、egress-policy のまま adapter だけ用意するか。
