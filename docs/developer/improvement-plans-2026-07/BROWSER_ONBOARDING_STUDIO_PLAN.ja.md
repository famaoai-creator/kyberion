# Browser Onboarding Studio 実装計画

作成日: 2026-07-12
対象ミッション: `MSN-BROWSER-ONBOARDING-STUDIO-20260712`

## 1. 目的

Kyberion の初期設定と拡張設定を、CLI の知識がなくてもブラウザから安全に完了できるようにする。

対象範囲:

- identity / vision / agent ID
- physical readiness の可視化
- browser microphone からの voice sample 登録と voice profile 作成
- 必要な service connection 候補の選択
- reasoning provider / model の優先順位
- tool runtime の優先順位と install approval 方針
- 変更内容の preview、明示的 apply、検証結果

## 2. 基本原則

ブラウザを新しい設定 authority にしない。既存の onboarding、voice registry、service connection、provider resolution、tool runtime policy を再利用する。

```text
Browser form
  -> draft
  -> schema validation
  -> preview / side-effect summary
  -> explicit operator apply
  -> governed personal/customer artifacts
  -> runtime verification
```

- secret や OAuth token を onboarding payload に保存しない。
- service は接続候補だけを作り、実認証は各 service の OAuth / secret flow に委譲する。
- voice sample は personal tier に保存し、public knowledge や broad observability へ複製しない。
- model / tool priority は operator overlay とし、product default を書き換えない。
- apply は loopback または認証済み Presence Studio request だけに許可する。
- preview と apply を分離し、apply 後は変更 artifact と検証結果を返す。

## 3. 画面構成

### Step 1: Welcome

- 利用目的を選ぶ: personal assistant / development / operations / creative work
- language と interaction style を選ぶ
- onboarding の全ステップと保存先を表示する

### Step 2: Identity

- operator name
- primary domain
- vision
- agent ID
- tenant / customer scope

### Step 3: Readiness

- identity
- reasoning providers
- voice hub / microphone
- service bindings
- browser runtime
- blocked / ready / optional の三状態表示

### Step 4: Voice

- microphone permission
- 3本までの短いsample録音
- 録音時間とfile size表示
- profile ID、display name、language、engine選択
- sampleの試聴と削除
- voice cloneはreference sample登録として扱い、fine-tuningとは分離する

### Step 5: Services

- GitHub、Google Workspace、Microsoft 365、Slack 等をcard表示
- required / optional、接続状態、auth方式を表示
- 選択したserviceはconnection proposalとして保存する
- credential入力は各service固有flowへ遷移させる

### Step 6: Models

- discovered providerをdraggable priority listで表示
- providerごとのdefault modelを選択
- fast / balanced / quality のpresetを提供
- unavailable providerを選択してもpreviewでwarningにする

### Step 7: Tools

- Python / Node / System runtimeの優先方式を選択
- `trial_first` / `installed_first` / `installed_only`
- install / pin のapproval要否を選択
- side-effect toolの自動許可は今回のscope外とする

### Step 8: Review & Apply

- 書き込むartifact
- external side effect
- warning / blocker
- voice sample数
- provider fallback順
- tool policy

を一画面で確認し、operatorがapplyする。

## 4. 保存契約

| 設定                | 保存先                                                                           | runtime consumer               |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------ |
| Identity            | active profile rootの`my-identity.json` / `my-vision.md` / `agent-identity.json` | onboarding / identity resolver |
| Onboarding state    | `onboarding/browser-onboarding-state.json`                                       | Browser Onboarding Studio      |
| Voice sample        | `voice/samples/<profile_id>/`                                                    | voice profile / TTS engine     |
| Voice profile       | `voice/profile-registry.json`                                                    | voice profile registry overlay |
| Service proposal    | `connections/<service_id>.json`                                                  | service setup / OAuth flow     |
| Provider preference | `onboarding/provider-preferences.json`                                           | agent provider resolution      |
| Tool preference     | `onboarding/tool-runtime-policy.json`                                            | tool runtime policy overlay    |

`resolveActiveProfileRoot()` を使用し、customerがactiveならcustomer root、未選択ならpersonal tierへ保存する。

## 5. API

- `GET /api/onboarding/browser-state`
  - current profile、readiness、provider defaults、voice profiles、service bindingsを返す
- `POST /api/onboarding/preview`
  - draftを検証し、effects / warnings / blockersを返す。書き込みなし
- `POST /api/onboarding/apply`
  - 同じschemaを再検証し、governed artifactを書き、resultを返す
- `POST /api/onboarding/voice-sample`
  - audio bodyをpersonal/customer voice sampleとして保存する

## 6. 実装フェーズ

### Phase A: Contract and preview

- browser onboarding draft schema
- preview / effect calculation
- current state aggregation
- unit tests

### Phase B: Governed apply

- identity artifacts
- service proposals
- provider preference overlay
- tool policy overlay
- voice profile registry overlay
- apply receipt

### Phase C: Browser UI

- responsive stepper
- readiness cards
- voice recorder
- priority ordering controls
- review screen
- success / recovery state

### Phase D: Runtime integration

- provider resolverがoperator priorityを読む
- tool runtime policyがoperator overlayを読む
- voice registryが登録profileを読む
- service setupがconnection proposalを読む

## 7. 受入条件

- previewはfilesystemを変更しない。
- invalid identity、重複provider、未許可service ID、invalid tool modeを拒否する。
- applyはproduct governance artifactを書き換えない。
- voice sampleがpersonal/customer profile root外へ出ない。
- provider priorityが次回provider resolutionへ反映される。
- tool preferenceが次回tool runtime policy loadへ反映される。
- service payloadにcredential、token、secretを受け付けない。
- desktopとmobileの両方で全stepを完了できる。
- unit test、Presence Studio build/typecheck、governance check、baselineが成功する。

## 8. 今回の非対象

- modelのfine-tuning
- voice modelのtraining job管理
- OAuth providerごとの認可画面実装
- secret valueのブラウザ保存
- toolの無承認side effect許可
- remote Internetからのonboarding公開

## 9. 2026-07-12 実装状況

- Phase A完了: draft schema、current state、preview、effects / warningsを実装。
- Phase B完了: identity、provider preference、tool policy、service proposal、voice profile、apply receiptをactive profile rootへ保存。
- Phase C完了: 8-step responsive wizard、readiness cards、browser microphone録音、service cards、provider priority、tool policy、review/applyを実装。
- Phase D完了: agent provider resolutionとtool runtime policyがoperator overlayを読むよう統合。
- Presence Studio first-run bannerから`Open Setup Studio`へ遷移可能。
- desktop 1440px / mobile 390pxで横overflowなし、console errorなし。
- headless ChromeでIdentity入力、service選択、model並べ替え、review previewまで完走。
