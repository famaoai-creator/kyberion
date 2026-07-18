# AR-10 macOS automation capability integration

## 概要

macOS の Automation / Accessibility を Kyberion の actuator から利用する際に、個別の AppleScript を直接増やすのではなく、既存の `apple-event-bridge` と `os-automation-bridge` を共通 capability として発見できるようにする。

| 項目   | 内容                           |
| ------ | ------------------------------ |
| ID     | AR-10                          |
| 優先度 | P1                             |
| 規模   | M                              |
| 依存   | AR-02, AR-03, AR-09            |
| 対象   | `libs/core`, `system-actuator` |

## 背景と判断

既存実装には Apple Event、Accessibility、画面・入力操作、Chrome/Finder/Terminal 向け adapter がすでに存在する。一方、利用側からは「このホストで macOS automation が利用できるか」「どの権限が確認できたか」「どのアプリ能力が公開されているか」を一つの契約で取得できず、pipeline が個別 primitive の存在を推測する必要があった。

この計画では、既存 bridge を置き換えず、その上に安全な facade を追加する。任意 AppleScript の実行や、権限確認のための画面キャプチャなど、意図しない副作用を伴う処理はこの wave の対象外とする。

## 実装 wave

### Wave 1: capability facade と非破壊 probe

- `macosAutomationBridge` を `libs/core` に追加する。
- macOS 以外では command を実行せず、`unsupported` を返す。
- macOS では短い `System Events` probe を `safeExecResult` 経由で実行し、Automation / Accessibility の確認結果を `granted` / `denied` として返す。
- Screen Recording はファイル生成を伴う非破壊判定がないため、`unknown` と理由を明示する。
- 既存の known application capability catalog をコピーせず、そのまま facade から公開する。
- 既知アプリの activate helper は allowlist を介したものだけを facade に置き、任意アプリ操作を新しい共通 API に持ち込まない。

### Wave 2: system actuator への公開

- `system:macos_automation_probe` capture op を追加する。
- probe 結果と known application capabilities を同じ context 値として返す。
- per-op input contract、op catalog、pipeline schema、manifest、能力ガイドの整合を保つ。

### Wave 3: 今後の候補

- macOS の TCC 状態を OS の許可された手段でより詳細に表示する。
- アプリごとの read-only adapter（Chrome tabs、Finder path、Terminal target）を capability contract と接続する。
- destructive action には confirmation / approval と監査イベントを必須化する。

## セキュリティ境界

- probe は読み取り専用で、画面キャプチャ、クリップボード読み取り、アプリ終了、ファイル変更を行わない。
- subprocess は `@agent/core/secure-io` の `safeExecResult` のみを使用する。
- 新しい facade は任意の AppleScript を受け取らない。任意 script は既存の明示的な `run_applescript` の統制下に残す。
- known application の allowlist は `os-app-adapters.ts` の正本を参照し、呼び出し側で文字列の自由入力を能力宣言とみなさない。
- 権限状態が不明な場合に `granted` と推測しない。

## 受入条件

- [x] `origin/main` 最新から分岐した別 PR で実装されている。
- [x] macOS 以外では副作用なく `unsupported` が返る。
- [x] macOS の probe 成功 / 失敗を決定論的な status と reason で表現できる。
- [x] Screen Recording の未判定を `unknown` として明示する。
- [x] `system:macos_automation_probe` が pipeline context から利用できる。
- [x] core / system actuator の unit test、typecheck、build、op registry 検証が通る。

## 実装結果

2026-07-18: Wave 1〜2 を実装。`macosAutomationBridge`、`system:macos_automation_probe`、per-op contract、manifest/catalog/schema の接続と非 macOS / 成功 / 権限拒否 / allowlist のテストを追加した。Wave 3 は追加の TCC 権限表示と destructive action の approval 統合として backlog に残す。
