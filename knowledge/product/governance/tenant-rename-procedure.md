---
title: テナントslugの改称手順（商号変更への追従）
tags: [governance, tenant, rename, migration, procedure]
last_updated: 2026-10-29
role_affinity: [mission_controller, sovereign, operator]
phase_affinity: [execution]
---

# テナントslugの改称手順

会社の商号が変わったとき、テナントslugを新しい名前へ移す手順。

**slugは表示名ではない。** `knowledge/confidential/{slug}/` のパスそのものであり、
`active/organizations/{tier}/` 配下のディレクトリ名であり、プロジェクトレコードと
ミッション状態が保持する所属の証明でもある。したがって改称は**文字列の編集ではなく移行**になる。

---

## 1. 判断 — 改称か、統合か

| 会社に起きたこと                     | エンティティの扱い                                           |
| ------------------------------------ | ------------------------------------------------------------ |
| 商号変更のみ（法人は存続）           | **改称**。この手順を使う                                     |
| 他社に吸収され法人が消滅             | 統合。吸収先テナントへナレッジを移し、元テナントは `archive` |
| 事業だけ移管され法人は商号変更で存続 | **改称**。事業の移管とは別の作業として扱う                   |

3つ目を統合と誤ると、存続する法人の入れ物を消してしまう。

## 2. コマンド

```bash
# 計画を見る（既定。何も変更しない）
pnpm tenant rename <旧slug> --to <新slug> --display-name '<新商号>'

# 実行する
pnpm tenant rename <旧slug> --to <新slug> --display-name '<新商号>' --apply
```

| オプション               | 用途                                                     |
| ------------------------ | -------------------------------------------------------- |
| `--to <slug>`            | 必須。移行先のslug                                       |
| `--display-name <text>`  | 新商号。省略すると既存の表示名を引き継ぐ                 |
| `--keep-organization-id` | 組織IDがslug由来でないとき、組織IDを変えない             |
| `--no-scan`              | 残存参照のスキャンを省く（全ツリーを読むため数秒かかる） |
| `--apply`                | 実行。付けなければ dry-run                               |

`active/organizations/` への書き込みは権限で守られているため `KYBERION_PERSONA=sovereign` が要る。

## 3. コマンドがやること

**移動するもの**

| 種別                 | 対象                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `knowledge_root`     | `knowledge/confidential/{slug}/`                                              |
| `organization_state` | `active/organizations/{tier}/{slug}/`、および組織IDがslugと同じならその配下も |
| `customer_overlay`   | `customer/{slug}/`                                                            |
| `profile`            | `knowledge/personal/tenants/{slug}.json`                                      |

**書き換えるもの** — 組織レコード・プロジェクトレコード・ミッション状態の
`tenant_slug` / `tenant_id` / `organization_id` フィールド。

**書き換えないもの** — 上記以外で旧slugに言及しているファイルは
`residual_references` として**報告するだけ**である。散文・ファイル名・デザイン資産は
機械的に置換すると文書が壊れるため、人が判断する。

## 4. 順序に意味がある

コマンドは次の順で動く。**途中で失敗しても、レジストリが実体のない場所を指さないため**である。

1. ナレッジルートを移す
2. 組織状態を移し、フィールドを書き換える
3. プロジェクト・ミッションのフィールドを書き換える
4. 顧客スタンスのオーバーレイを移す
5. **最後にテナントプロファイルを書く**（旧プロファイルは `.renamed` を付けて残す）

オーバーレイ（手順4）には監査チェーンのテナント複製 `customer/{slug}/logs/audit/` が入っている。
そのため移動は監査チェーンのロックを取って行い、同じロックの中で
`tenant.audit_mirror_moved` エントリ（`metadata.previous_slug` に旧slug）をチェーンに記録する。
監査の追記は移動の前か後のどちらかにしか入らない。`audit mirror-reconcile` はこの印より前の
旧slugのエントリを新slugの複製のものとして数えるので、改称だけで不整合とは報告されない。
改称は記録した印の監査IDをプロファイルの `metadata.audit_mirror_move_ids` に残す。
印を信じるのは、そのIDがプロファイルに残っていて、かつ改称履歴にその改称
（旧slug → 新slug の連続した一歩）があるときだけである。改称以外が記録した印は、
履歴にある改称を名乗っていても使われない。旧slugを後から別のテナントが使っても、
そのエントリが改称後の複製に混ざることはない。また、新slugを以前に使っていたテナントのエントリも
改称後の複製には数えない。
プロファイルの `metadata.previous_slugs` には、改称のたびに旧slugが追記されていく
（この欄ができる前に改称したプロファイルは `tenant_id` と `metadata.previous_slug` から履歴を読む）。

改称の前に、記録する監査エントリが拒否されないこと（現在のテナント文脈との衝突、チェーン鍵の欠落）を
確かめてから動かし始める。途中で拒否されて半分だけ改称された状態にはならない。

この印ができる前に行った改称には印がないため、`audit mirror-reconcile` は改称後の複製を不整合として
報告する。承認して適用すると、旧slugのエントリは複製から外されて退避先（archive）に移る。
マスターのチェーンからは消えない。

プロファイルを先に書き換えると、移動に失敗したときレジストリだけが新slugを指し、
実体は旧slugのまま、という状態になる。

## 5. `tenant_id` は変えない

**slugはデータの置き場所、`tenant_id`はテナントの同一性。**
改称しても `tenant_id` は引き継ぎ、`metadata.previous_slug` に旧slugを残す。
これにより、改称前に書かれた監査記録が改称後も同じテナントとして辿れる。

## 6. 実行後にやること

1. `pnpm tenant show <新slug>` で `knowledge_root` と `metadata.previous_slug` を確認する
2. `pnpm organization reconcile --organization-id <新slug> --tier confidential --tenant-slug <新slug> --apply`
   （`--tier` と `--tenant-slug` を省くと、状態が見えないまま `clean` が返る）
3. `pnpm check -- --scope full --only tenant-registry` と
   `pnpm check -- --scope full --only entity-governance`
   （個別ゲートの起動口は `knowledge/product/governance/ci-gates.json` に集約されている。
   `check:*` のエイリアスは廃止済みで、`--scope` は各ゲートの登録スコープと一致させる）
4. `residual_references` を上から処理する。とくに次を見る
   - **ファイル名に旧slugが入っているもの**（デザイン資産に多い）
   - **パイプラインテンプレートからの参照**（ファイル名を変えると壊れる）
   - 他テナントの資料からの言及（歴史的記述として残すべきものもある）
5. `pnpm generate:knowledge-index`
6. 旧プロファイル `knowledge/personal/tenants/{旧slug}.json.renamed` を、
   問題がないことを確認してから削除する

## 7. 制約

- **移行先slugが既に存在する場合は実行できない。** テナント・ナレッジルート・
  組織ディレクトリのいずれかが既にあれば中断する
- **アーカイブ済みテナントは改称できない。** 先に `resume` する
- **予約語は移行先にできない**（`public` / `confidential` / `personal` / `shared`）
- **ミッションのgitリポジトリは追従しない。** ミッション配下の `.git` が旧slugを
  参照している場合は個別に対応する

## 8. 実装

| 場所                              | 内容                                             |
| --------------------------------- | ------------------------------------------------ |
| `libs/core/tenant-governance.ts`  | `renameTenant()` — 計画の作成と実行              |
| `scripts/tenant.ts`               | `rename` verb                                    |
| `libs/core/tenant-rename.test.ts` | dry-runの無害性、移動、`tenant_id`保持、拒否条件 |

## 9. 関連

- [tenant-onboarding-procedure](./tenant-onboarding-procedure.md) — 新規登録
- [multi-tenant-operations](../architecture/multi-tenant-operations.md) — テナント分離の考え方
- [entity-scope-hierarchy](../architecture/entity-scope-hierarchy.md) — slugが所属チェーンで果たす役割
