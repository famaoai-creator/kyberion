# In-Session Subagent Architecture Design Proposal

## 1. 背景と目的 (Background and Purpose)
現在の Kyberion では、サブエージェントへタスクを委譲する際 (`delegateTask()`) に別のプロセス（CLIコマンドなど）を spawn するアプローチが主流となっています。しかし、この方式には以下の課題があります。
* **コンテキスト共有のオーバーヘッド**: 親エージェントが保持しているインメモリのコンテキストやファイル状態をファイルや標準入出力を経由して渡す必要があり、直感的な共有が難しい。
* **パフォーマンス・リソースの問題**: プロセス起動時のコールドスタートやコンテキスト再ロードによる遅延、メモリ消費量の増大。
* **非同期連携の複雑化**: プロセス間のライフサイクル管理やエラーハンドリングが複雑になる。

**In-Session アプローチの有効性**:
現在の実行セッション（In-Session）内でネイティブの Function Calling（例: Gemini CLIの `invoke_agent` ツールなど）を活用することで、プロセスオーバーヘッドを排除し、コンテキストの継承が容易になり、高速かつシームレスなタスク委譲が実現できます。

## 2. アーキテクチャ案 (Architecture Proposal)
新しく `InSessionReasoningBackend` (または `AgenticReasoningBackend`) を導入します。

### クラス構造イメージ
```typescript
class InSessionReasoningBackend implements ReasoningBackend {
  // 既存のメソッドの実装...

  async delegateTask(taskDef: TaskDefinition): Promise<TaskResult> {
    // タスク定義から invoke_agent 用のパラメータを構築
    const toolCallParams = {
      agent_name: taskDef.requiresDeepAnalysis ? 'codebase_investigator' : 'generalist',
      instruction: taskDef.prompt,
      // 必要なコンテキストやスコープを付与
    };

    // LLMネイティブの Function Calling (invoke_agent) を実行
    const result = await this.executeFunctionCall('invoke_agent', toolCallParams);

    return this.parseToolResult(result);
  }

  private async executeFunctionCall(toolName: string, params: any): Promise<any> {
    // Kyberionランタイムへのツールコール要求と結果待機を行うレイヤー
  }
}
```
`delegateTask()` メソッド内部で別プロセスを spawn するのではなく、LLM プロバイダが提供するツールコール（Function Calling）を直接発行し、サブエージェント（`generalist` や `codebase_investigator`）を In-Session で起動して結果を受け取ります。

## 3. 必要なKyberionコアの改修 (Required Core Modifications)
In-Session での委譲を成立させるため、Kyberion の標準ランタイム (`scripts/run_pipeline.ts` またはミッションコントローラ) に以下の改修が必要です。

* **ツールコールの中継・待機機構**:
  ランタイムはエージェントからの `invoke_agent` ツールコール要求をインターセプトし、親セッションをブロックさせつつサブエージェントを実行し、その結果（サマリ）をツールコールのレスポンスとして親セッションに返す仕組みが必要です。
* **状態・ヒストリの最適化 (Rollup)**:
  サブエージェントの実行過程（大量のログやコンテキスト消費）が親のヒストリを汚染しないよう、サブエージェントのやり取りを親エージェントのコンテキスト（セッションヒストリ）には「単一のサマリ結果」として効率的に記録・隠蔽する仕組みの導入。
* **セキュアI/Oとの統合**:
  In-Session サブエージェントがファイル操作を行う際も、例外なく `@agent/core/secure-io` を経由するようにランタイム側でコンテキストや権限を透過的に引き継ぐ実装。

## 4. 実装のハードル (Implementation Hurdles)
このアーキテクチャを実現する上で、以下の技術的な課題が予想されます。

* **プロバイダ間の Function Calling 抽象化**:
  Anthropic (Claude), Google (Gemini), OpenAI (Codex/GPT) などで Function Calling の API インターフェースや挙動が異なります。Kyberion として統一の `invoke_agent` インターフェースをどう定義し、各バックエンド SDK にマッピングするかの設計が困難です。
* **状態（Context Window）の消費とコンカレンシー管理**:
  同じプロセス内で複数のサブエージェントをパラレルに呼び出す場合、同じファイルリソースへの競合（Race Condition）を防ぐ制御機構や、共有メモリモデルの設計が必要です。
* **再帰的委譲の無限ループ対策**:
  In-Session サブエージェントがさらにサブエージェントを呼ぶ（ネストする）場合のリソース枯渇や無限ループを防ぐための、厳密な Depth 制約（呼び出し深さの制限）やガバナンス機構の実装が不可欠です。

## 5. ビジネス的価値（生成AI導入コンサルティングにおける強み）
この「In-Session Subagent」アーキテクチャは、Kyberion を活用した生成AI導入コンサルティング・ビジネスにおいて、他社（単なるプロンプトエンジニアリングやRAG構築企業）を圧倒するための決定的な強み（Moat）となります。

* **1. 「超高速・低遅延」な自律組織の提供**:
  CLIプロセスを毎回立ち上げる数十秒のコールドスタート・ペナルティが消失します。これにより、クライアントの環境で「数十人の専門AIエージェントが瞬時にブレインストーミングを行い、数秒で結論を出す」という、魔法のような超高速なタスク解決デモが可能になります。
* **2. 究極の「コンテキスト（暗黙知）の共有」**:
  同じプロセス（メモリ）内でエージェントを切り替えるため、親エージェントが読み込んだ膨大な社内資料や過去の対話履歴を、サブエージェント（例：コード監査役や法務確認役）がそのまま共有できます。これは人間の組織における「ツーカーの仲（阿吽の呼吸）」をAI組織で再現するものであり、極めて高い業務品質を保証します。
* **3. 「トークンコストの劇的削減」と「ROIの最大化」**:
  プロセスの分断による不要なコンテキストの再読み込み（毎回のシステムプロンプトや巨大なJSONの再送信）が不要になるため、APIのトークン消費量を劇的に抑えられます。「他社のAIソリューションより賢いのに、ランニングコストは半分以下」という、強力な営業上のバリュープロポジションを提示できます。
* **4. ベンダーロックインの回避と「最強の脳」への即時換装**:
  このIn-Sessionの仕組みがKyberion側で抽象化されていれば、クライアントは「今日はGemini 2.0、明日はClaude 3.5」といったように、その日の最先端モデルに、システムのインフラを一切変更せずに切り替えることができます。「常に世界最高のAIを、最速かつ最安で使い続けられるOS」として、永続的なコンサルティング契約の基盤となります。
