# Web Session Handoff

Web アプリが debug-only hook を使って browser session を export し、Browser-Actuator がその state を import/export して後続試験へ引き継ぐための手順です。

## Goal

対象フロー:

1. Web app が認証済み状態になる
2. debug-only route または debug hook が session handoff の元データを出せる
3. Browser-Actuator が cookies/storage を export する
4. 後続セッションで Browser-Actuator が import する
5. guarded route の試験を再開する

## Contracts

- [`webview-session-handoff.schema.json`](../../schemas/webview-session-handoff.schema.json)
- [`web-app-profile.schema.json`](../../schemas/web-app-profile.schema.json)
- [`example-web-login-guarded.json`](../../orchestration/web-app-profiles/example-web-login-guarded.json)

## Shared Templates

- [`web-sample-apps/README.md`](../../templates/web-sample-apps/README.md)

## Browser Examples

- export template:
  [`web-runtime-session-handoff-export-template.json`](../../../../libs/actuators/browser-actuator/examples/web-runtime-session-handoff-export-template.json)
- import template:
  [`web-runtime-session-handoff-import.json`](../../../../libs/actuators/browser-actuator/examples/web-runtime-session-handoff-import.json)

## Orchestration

- [`web-session-handoff-runner.json`](../../../../pipelines/web-session-handoff-runner.json)

## Route And Test Modeling

- UI flow example:
  [`web-profile-to-ui-flow.json`](../../../../libs/actuators/modeling-actuator/examples/web-profile-to-ui-flow.json)
- execution plan example:
  [`web-profile-to-browser-plan.json`](../../../../libs/actuators/modeling-actuator/examples/web-profile-to-browser-plan.json)
- UI flow schema:
  [`ui-flow-adf.schema.json`](../../schemas/ui-flow-adf.schema.json)
- test inventory schema:
  [`test-case-adf.schema.json`](../../schemas/test-case-adf.schema.json)

## Notes

- release build に debug route を含めない
- export するのは cookies/storage/headers と current route に限定する
- SSR or API token dump にしない
