# Web Session Handoff Skeleton

最小構成の Web sample app skeleton です。login route、guarded route、debug-only session export route を含みます。

## Files

- [`package.json`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/web-sample-apps/web-session-handoff-skeleton/package.json)
- [`vite.config.ts`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/web-sample-apps/web-session-handoff-skeleton/vite.config.ts)
- [`index.html`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/web-sample-apps/web-session-handoff-skeleton/index.html)
- [`src/main.ts`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/web-sample-apps/web-session-handoff-skeleton/src/main.ts)
- [`src/router.ts`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/web-sample-apps/web-session-handoff-skeleton/src/router.ts)
- [`src/auth/sessionStore.ts`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/web-sample-apps/web-session-handoff-skeleton/src/auth/sessionStore.ts)
- [`src/debug/sessionExport.ts`](/Users/famaoai/k/a/kyberion/knowledge/public/templates/web-sample-apps/web-session-handoff-skeleton/src/debug/sessionExport.ts)

## Local Routes

- `/login`
- `/app/home`
- `/app/settings`
- `/logout`
- `/__kyberion/session-export`

## Expected Behavior

- login 後に localStorage / sessionStorage / cookie を設定する
- guarded route は `auth_state` が無ければ `/login` へ戻す
- `/__kyberion/session-export` は debug 時だけ handoff JSON を返す

profile は [`example-web-login-guarded.json`](/Users/famaoai/k/a/kyberion/knowledge/public/orchestration/web-app-profiles/example-web-login-guarded.json) と揃っています。
