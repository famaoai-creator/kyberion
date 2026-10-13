---
title: Kyberion で Windows とローカル AI を活用する
kind: operator-guide
scope: repository
authority: product
tags: [windows, local-llm, ollama, accessibility, browser, voice]
importance: 7
author: Kyberion
last_updated: 2026-10-14
role_affinity: [operator, ecosystem_architect]
applies_to: [windows, local-llm]
status: active
---

# Kyberion で Windows とローカル AI を活用する

ローカルモデルを Kyberion の Windows ネイティブなコンピューター操作と組み合わせる方法です。モデルは提案と要約を担当し、Kyberion のアクチュエーターが接続先、操作、承認、データスコープのルールを適用します。

## 接続方法を選ぶ

Kyberion には用途の異なるローカルモデル接続が2つあります。

- **Reasoning backend** はコード作成、タスク計画、ブラウザーの `llm_assist` に使います。`KYBERION_REASONING_BACKEND=ollama`、`KYBERION_OLLAMA_URL`、`KYBERION_OLLAMA_MODEL` を設定します。
- **Windows local-assist bridge** は Windows に関する短い質問に使います。`KYBERION_WINDOWS_AI_ENDPOINT` と `KYBERION_WINDOWS_AI_MODEL` に Foundry Local または Ollama など OpenAI 互換 API の値を指定します。Reasoning backend のルート設定とは別です。

PowerShell の現在のセッションだけで有効にする例です。

```powershell
$env:KYBERION_REASONING_BACKEND = 'ollama'
$env:KYBERION_OLLAMA_URL = 'http://127.0.0.1:11434'
$env:KYBERION_OLLAMA_MODEL = 'qwen3.8:27b-q4_K_M'

# Windows local-assist bridge も Ollama に接続する場合:
$env:KYBERION_WINDOWS_AI_ENDPOINT = 'http://127.0.0.1:11434'
$env:KYBERION_WINDOWS_AI_MODEL = 'gemma4:e4b'

pnpm reasoning:config doctor --json
```

用途ごとにモデルを明示してください。同じマシン上の Ollama なら URL は loopback のままにし、別途保護できていない状態で LAN に公開しないでください。まず1モデルを読み込んで実際の作業で品質と応答時間を見てから比較します。

## Kyberion 経由で Windows 機能を使う

Windows OS アダプターは UI Automation (UIA) でフォーカス中のコントロールやウィンドウを調べ、Chrome タブ列挙、アプリ起動、ウィンドウのフォーカス・状態変更、アクセシビリティ情報に基づく操作を行います。共通 OS seam からキーボード、マウス、クリップボード、アプリの正常終了、スクリーンキャプチャ用バックエンドも利用できます。デスクトップ観測のベースラインは Windows の各観測元を個別に調べます。対象アプリやキャプチャバックエンドがない場合、その機能だけが利用不可になります。

実用上の使い方:

- 最初に、前面アプリ・ウィンドウ、Chrome タブ、フォーカス中のコントロール、スクリーンキャプチャなど、読み取り専用の小さな観測を依頼します。
- 探索的なブラウザー作業はタスクセッションの `llm_assist` を使います。`allowed_origins` を対象サイトに限定し、ページの証拠とモデルが提案した操作を確認してから候補を再生します。同じ手順を繰り返す場合はパイプラインに昇格し、毎回モデルの判断が必要な工程はタスクセッションに残します。
- UIA が対象を識別できる場合は、座標よりアプリ名・ウィンドウタイトルによる起動や操作を優先します。画面上の位置に依存する操作は、視覚的な根拠が必要な場合だけ使います。
- `toggleDictation` は Windows 音声入力の `Win+H` を送ります。利用できるかどうかは Windows の設定とフォーカス位置によります。
- Windows トースト通知には `KYBERION_WINDOWS_AUMID` が必要です。未設定時はベストエフォートのメッセージ通知に切り替わります。

関連資料: [ブラウザー探索タスクセッション](../orchestration/browser-exploration-task-session.md)、[Windows ローカルモデル評価](windows-local-model-evaluation.md)、[英語版: Local AI and Windows features in Kyberion](windows-local-ai-kyberion.md)、[コンピューター操作機能一覧](../../../CAPABILITIES_GUIDE.md)。

## モデル選定と結果の確認

このマシンは 64 GiB のユニファイドメモリを搭載し、Ollama は Radeon GPU を利用しています。過去の Qwen 3.8 27B Q4 と Ornith 9B のスモークテストでは、コードやドキュメントの応答、ブラウザー用ツール呼び出しの提案を確認しました。Chrome を使った実機テストでは、Qwen 3.8 27B Q4 が Microsoft Learn に移動して本文を取得しましたが、次のモデル応答が90秒の制限を超え、部分証拠を残してタスクセッションが一時停止しました。別の読み取り専用タスクでは Gemma 4 E4B がページを開き、タイトルを返し、候補を新しいセッションで再生してタスクセッションを完了できました。一方、Gemma を Windows local-assist bridge に直接接続した回答には未確認の Windows API に関する誤りが含まれました。モデルの一般的な説明は下書きとして扱い、機能カタログや Microsoft の資料と照合してください。

ブラウザー操作では、形式の正しいツール呼び出しが生成されたことだけで成功と判断しないでください。ブラウザートレース、タスクセッションの結果、再生した場合はパイプラインの結果を確認します。モデルが不正な形式または未対応の操作を提案した場合は、部分的な証拠を残してレビューし、完了したと見なさないようにします。

Windows 公式資料: [Windows AI の概要](https://learn.microsoft.com/en-us/windows/ai/overview)、[Foundry Local](https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-local/what-is-foundry-local)、[UI Automation](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview)、[Ollama for Windows](https://docs.ollama.com/windows)。
