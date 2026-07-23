---
title: Select a reasoning provider and model
category: system
tags: [onboarding, reasoning, provider, model, adapter, security, operations]
audience: [operator, developer]
---

# Reasoning プロバイダとモデルの選択手順

Kyberion の推論経路は、特定の SDK やベンダーをアプリケーションコードへ直接埋め込まず、登録済みの runtime adapter と governed profile の組み合わせで解決する。Presence Studio の初期設定でプロバイダとモデルを選択すると、active profile 単位で保存され、default role の推論経路に適用される。

## 選択手順

1. Presence Studio の onboarding を開き、`Models` ステップへ進む。
2. `Reasoning provider` で利用可能なプロバイダを確認する。
   - `Ready` の候補はそのまま選択できる。
   - `Needs setup` は資格情報、URL、またはローカルランタイムを整備してから選択する。
   - `Unsupported` は policy に governed profile がないため選択しない。
3. `Model` で選択プロバイダの registry 登録済みモデルを選ぶ。未指定の場合はプロバイダの既定モデルを使用する。
4. `Review` で保存内容を確認し、onboarding を適用する。
5. 保存後は `Reasoning provider` と `Model` が意図どおり表示されることを確認する。

同じ `Models` ステップには、登録済みの adapter-backed runtime の既定値も表示される。画像、動画、音楽、service runtime、tool runtime、VAD の選択は [Adapter-backed runtime default selection procedure](./select-adapter-backed-runtime-defaults.md) に従う。TTS/STT は音声専用の選択手順を使用する。

保存先は active profile の `onboarding/llm-selection.json` である。プロファイルを切り替えると選択状態も切り替わる。選択候補は `knowledge/product/governance/reasoning-route-policy.json` の adapter metadata、`reasoning-model-registry.json`、provider discovery の結果から生成される。

## 選択基準

| 優先する条件 | 選択の考え方                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| 機密性       | 外部送信を避ける場合は、ローカルランタイムを選び、endpoint とネットワーク境界を確認する。                        |
| 品質         | タスクに必要なコンテキスト長、ツール呼び出し、構造化出力を満たす approved model を選ぶ。                         |
| レイテンシ   | 常時利用する処理は、レート制限とコールドスタートを含めて測定した provider を選ぶ。                               |
| コスト       | 外部 provider は spend cap、請求先、fallback 時の送信先を確認する。                                              |
| 可用性       | `Ready` かつ health check 済みの候補を選ぶ。モデルが registry から deprecated/blocked になった場合は再選択する。 |

## 適用順序と上書き

選択は default role に対する既定値である。明示的な role binding、profile、request の指定がある場合はそちらが優先される。`KYBERION_REASONING_BACKEND` またはコードから明示した `mode` も onboarding 選択より優先されるため、運用時の一時切り替えに使える。

```bash
pnpm reasoning:config doctor --json
pnpm reasoning:config list
pnpm reasoning:config explain --role default
```

確認時は、実際に解決された adapter、model、fallback chain、provenance を記録する。環境変数や接続ファイルへ秘密情報を直接保存せず、既存の secret guard と provider discovery の仕組みに任せる。

## 運用・保守

- 新しい provider または model を追加する場合は、runtime adapter metadata、governed profile、model registry、availability/discovery、テストを追加する。default routing や Presence Studio のコードに provider 名の分岐を追加しない。
- provider の表示名、必要な環境変数、model provider の対応は policy metadata に集約する。
- 選択不能な候補を UI で隠さず、理由を表示する。これにより setup 不足と policy 未登録を切り分けられる。
- provider を削除・非推奨化する場合は、既存 profile の fallback と active profile の選択を確認してから registry/policy を更新する。
- 選択変更後は build、core tests、`pnpm pipeline --input pipelines/baseline-check.json` を実行し、default role の実解決結果を確認する。
