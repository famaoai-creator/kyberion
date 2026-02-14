# VoltMX to React Migration Strategy

VoltMX 資産を React ベースのモダンなスタックに書き換えるための段階的移行計画。

## 1. 基本方針：デカップリング優先
VoltMX はフロント（Iris）とバック（Foundry）が密結合になりがちです。まずは「通信層」を標準化し、フロントエンドを自由に差し替えられる状態を作ります。

## 2. 移行の5ステップ

### Step 1: 資産の棚卸しと優先順位付け (Inventory)
- **UIコンポーネント**: 共通パーツ（Buttons, Input）と、複雑な画面（Segment, Map）を分類。
- **ビジネスロジック**: VoltMX Modules (.js) 内の純粋なロジックと、Kony API (`kony.*`) 依存ロジックを分離。
- **Foundry API**: 現在使用している Integration/Object Services のエンドポイント一覧を作成。

### Step 2: Foundry API の「標準化」 (API Gateway Layer)
- React から Foundry API を直接呼ぶのではなく、薄い API Gateway (Node.js や AWS Lambda) を挟むか、Foundry の出力形式を純粋な JSON に整える。
- これにより、バックエンドを将来的に Node.js 等に移行する際もフロントエンド（React）への影響を最小限に抑える。

### Step 3: UIコンポーネントの React 化 (Component Mapping)
- VoltMX Widgets を React コンポーネント (MUI や Tailwind CSS) にマッピングする。
- **Atomic Design** を採用し、VoltMX の「Skins」を React の「Theme」に変換。

### Step 4: ロジックの移植 (Logic Migration)
- `kony.print` -> `console.log`
- `kony.store` -> `LocalStorage` / `IndexedDB`
- `kony.net.invokeServiceAsync` -> `Axios` / `TanStack Query`
- グローバル変数で管理されていた状態を `Redux` や `Zustand` に移行。

### Step 5: 段階的リリース (Strangler Fig)
- アプリ全体を一度に書き換えるのではなく、特定の機能（例：設定画面、プロフィール画面）から順に React で実装し、既存の VoltMX アプリ内に WebView で埋め込むか、リダイレクトさせる形で徐々に「侵食」させていく。

---
*Created: 2026-02-14 | Ecosystem Architect*
