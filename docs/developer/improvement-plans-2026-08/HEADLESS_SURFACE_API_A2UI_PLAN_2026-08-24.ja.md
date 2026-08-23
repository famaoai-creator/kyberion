---
title: Headless Surface API と A2UI adapter の段階導入計画
category: Improvement Plan
tags: [chronos, headless-api, a2ui, surface, api, viewer-scope]
last_updated: 2026-08-24
---

# Headless Surface API と A2UI adapter

## 判断

UI と API の分離は採用する。ただし、A2UI を業務 API の正本にはしない。

```text
headless query / operation contract
  -> surface-specific projection adapter
  -> A2UI renderer or another UI
```

Headless API は業務上のデータ、権限、操作、証跡を表現する。A2UI は同じ結果を
表示するための presentation projection であり、UI の catalog や component props を
権限判定に使わない。

## なぜ今の構成を分けるか

- `operator-home`、`workitems`、`collaboration` は既に core projection を持つため、
  UI から独立した query API にしやすい。
- `/api/intelligence` と `/api/agent` は現在、集約データ・会話・操作・A2UI を一つの
  surface route に集めている。新しい UI が増えるほど、UI 固有の response shape が
  API の正本になるリスクがある。
- ViewerContext と tenant/organization/project scope は HTTP route でサーバー側に解決
  されている。この境界は headless route でも共通化し、client の scope 値を認可に使わない。
- operator-surface は no-write surface なので、read projection と mutation operation の
  catalog を明確に分ける必要がある。

## Phase 1（今回）: 同一 Next.js 内の論理分離

### API

- `GET /api/headless/manifest`
- `GET /api/headless/operator-home`
- `GET /api/headless/work-items`
- `GET /api/headless/collaboration`
- `POST /api/headless/operations/work-items/status`

全レスポンスは `api_version`、resource、server-resolved scope、data、available
operations を持つ。write operation は `localadmin` に限定し、入力を route で検証する。

### A2UI

- `GET /api/headless/a2ui/operator-home`
- headless query の結果から標準 A2UI `updateComponents` message を生成する。
- UI は A2UI を描画するが、operation の可否は A2UI props ではなく headless manifest と
  server-side viewer context に従う。

### 非目標

- いきなり別プロセス・別認証基盤に分割しない。
- `/api/intelligence` と `/api/agent` を今回一括置換しない。
- A2UI component catalog を外部から自由に拡張可能にはしない。
- operator-surface に Chronos の write operation を移植しない。

## Phase 2: 既存 route の adapter 化

1. 既存 `/api/operator-home`、`/api/workitems`、`/api/collaboration` は互換 route として
   維持し、内部 query を headless reader に寄せる。
2. `/api/intelligence` の read projection と mutation operation を分離する。
3. A2UI の `display:*` catalog と protocol type を一つの検証可能な catalog に揃える。

## Phase 3: 他 surface / 外部 consumer

- Presence Studio、Terminal HUD、生成 surface は headless API を consumer とする。
- 別プロセス化が必要になった時点で、ViewerContext、tenant registry、audit、rate limit を
  broker 境界として切り出す。

## 受入条件

- headless API の全 route が ViewerContext を要求する。
- client supplied tenant は viewer scope を拡張できない。
- read-only viewer は write operation を discovery / invoke できない。
- operator-home の headless data と A2UI projection が同じ query 結果から生成される。
- unknown operation、invalid scope、invalid input が fail-closed になる。
- 既存 Chronos API viewer 契約、operator-surface no-write 契約、Chronos build が green。
