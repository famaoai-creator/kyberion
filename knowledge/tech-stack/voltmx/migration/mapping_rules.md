# VoltMX to React Technical Mapping Rules

開発者が実装レベルで参照する変換ガイド。

## 1. UI Widget Mapping

| VoltMX Widget | React (MUI/Standard) | 備考 |
| :--- | :--- | :--- |
| **FlexContainer** | `Box` (MUI) or `div` (Flexbox) | レイアウトの基本。 |
| **Label** | `Typography` (MUI) or `span` | スタイルは `Skins` から移行。 |
| **Button** | `Button` (MUI) | `onClick` イベントへマッピング。 |
| **Segment** | `List` or `DataGrid` | `onRowDisplay` は `map()` 内でのレンダリングへ。 |
| **TextBox** | `TextField` (MUI) | `value` と `onChange` で状態管理。 |

## 2. Logic & API Mapping

| VoltMX API (Kony) | React / JS Standard | 備考 |
| :--- | :--- | :--- |
| `kony.ui.Alert` | `window.alert` or MUI `Dialog` | |
| `kony.store.setItem` | `localStorage.setItem` | 永続化ストレージ。 |
| `kony.net.invokeService` | `axios.post` / `fetch` | Foundry API 呼び出しの置換。 |
| `kony.application.showLoadingScreen` | `CircularProgress` (MUI) | グローバルなローディング状態。 |
| `kony.application.setCurrentForm` | `useNavigate` (React Router) | 画面遷移。 |

## 3. スタイル移行の注意点
- **Skins**: VoltMX の Skin は JSON 形式でプロパティが定義されています。これを CSS Modules や `styled-components`、あるいは MUI の `theme.palette` に変換するスクリプトを作成すると効率的です。
- **Layout**: VoltMX の百分率 (%) 指定は、CSS の `vw`/`vh` や `flex-basis` で再現します。

---
*Created: 2026-02-14 | Focused Craftsman*
