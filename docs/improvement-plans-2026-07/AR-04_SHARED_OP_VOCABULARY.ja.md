# AR-04: 共有 op 語彙 — 命名の乱れと per-actuator 再実装の統一

> 優先度: P1 / 規模: M / 依存: AR-01(1エンジン)、AR-02(op 単一源) / 関連: AC-06(能力境界)、IP-09(共通ユーティリティ)
> **検証(2026-07-03, Fable)**: op-registry の `shared_transform_ops` は宣言のみで各アクチュエータが local 再実装。画面キャプチャ・クリック・read/write が複数名で重複することを調査で確認。

## 背景と課題

### op 命名の乱れ(作者が呼び分けに迷う)

- **画面キャプチャ 5+名**: `screenshot`(browser/system)/ `snapshot`(browser)/ `capture` / `capture_screen`(media-generation)/ `record_screen` / `capture_focused_window` / `screen_capture` / `test_screen_stream`(system)。9アクチュエータで独立実装。
- **click/type/press 8名**: `click`/`click_ref`/`mouse_click`(system)/`tap`(mobile);`fill`/`fill_ref`;`press`/`press_ref`/`press_key`(system)。browser は coordinate 系と ref 系の2家族を並走。
- **read/write の粒度不統一**: `read`/`read_file`/`read_json`;`write`/`write_file`/`write_artifact`/`write_json`(file は write/write_file/write_artifact を silent alias)。
- **notify**: `notify` vs `system_notify` が同居。**speak**: `voice`/`native_tts_speak`(system)vs `speak_local`/`generate_voice`(voice)。
- **param 名の散在**: 出力先が `path`/`output_path`/`out`/`target_path`、内容が `content`/`data`/`from`。copy/move は from/to、read は path。
- **制御 op 名がエンジン別**(AR-01): `if` vs `core:if` vs `core:call`。

### 「shared」が名ばかり

`actuator-op-registry.json` の `shared_transform_ops`(set/json_query/regex_extract/path_join/json_parse)は宣言だけで、各アクチュエータが local 再実装(file の regex_replace/json_parse/path_join、system の regex_extract/json_query 等)。

### 横断重複(実測傾向)

- **file I/O を8アクチュエータが再実装**(read_file/write_file が file/code/modeling/system/wisdom/network/orchestrator/media に独立)。
- **画面キャプチャを9アクチュエータ**、**fetch を6アクチュエータ**(network が「secure fetch」担当なのに他も直接 fetch)。
- **log/notify** が per-actuator + 両エンジンで特別扱い。

## ゴール(受入条件)

1. **正準 op 語彙**を定義し AR-02 の op-registry に載せる: `io:{read,write,append,copy,move,delete,mkdir,stat,exists,glob}` / `capture:{screen,page,window}` / `net:{fetch}` / `transform:{regex,json_query,json_parse,template}` / `core:{if,foreach,while,include,wait,transform,set,log,notify}`。
2. **正準実装を1つ**にし(AR-01 のエンジンが解決する transform/core、共有 io/capture/net の handler)、per-actuator 再実装を deprecate。
3. **エイリアス整理**: screenshot/snapshot/capture → `capture:screen`(target 指定)、click/click_ref → ref 系に統一(coordinate を deprecate)、read/read_file → `io:read`、notify/system_notify → `core:notify`。旧名は1リリース警告付きエイリアス。
4. **param 名の正準化**: 出力先=`out`(or `path`)、内容=`content`、src/dest=`from`/`to` に統一(`logic-utils` の許容を正準に寄せる)。

## 実装タスク

### Task 1: 正準語彙の定義 — `claude-opus`(設計)

1. 現存 op の全名寄せ表(別名 → 正準)と param 名の正準表を作る(本文書末尾)。deprecate 対象(coordinate click、snapshot、system の file I/O 等)を明示。AC-06 の能力境界と整合(capture は system 正、生成は media-generation 等)。

### Task 2: 共有 handler の実装 — `claude-sonnet-4`

1. `io`/`capture`/`net`/`transform` の共有 handler を `@agent/core` に1実装ずつ(既存の safeReadFile/secureFetch/createScreenCaptureBridge をラップ)。AR-01 のエンジンが actuator routing より前にこれらを dispatch。
2. `transform` 系(regex/json_query/json_parse/template)を canonical `logic-utils` に集約し、per-actuator 再実装を削除。

### Task 3: エイリアス整理と横展開 — `claude-sonnet-4`(パターン)→ `claude-haiku`(横展開)

1. 各アクチュエータの重複 op を共有語彙へ委譲し、旧名は警告付きエイリアス(`check:contract-semver` に従う)。file I/O は file-actuator/`io:*` に集約、screen capture は `capture:screen` に。
2. param 名の正準化(旧名も1リリース受理)。1アクチュエータごとに該当テスト緑。

## リスクと注意

- **エイリアス削除は破壊的変更**。旧名を1リリース維持し `check:contract-semver` の判定に従う。99テンプレ + fragments が旧名を使うので、grep で全参照を移行。
- 命名統一はテンプレの大量書き換えを誘発。旧名エイリアスで**テンプレ側は段階移行**(即時全置換しない)。
- AR-01(1エンジン)・AR-02(op 単一源)が前提。AR-04 単独では語彙を定義しても実装先が3エンジンに散る。実施順: AR-01/02 → AR-04。
