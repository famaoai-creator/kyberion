# Isolated public navigation after onboarding

A stored browser origin grant authorizes only the named `browser:goto` or
`browser:open_tab` operation in a trusted **public** execution context. The
installed, active NHI and accountable owner must match the reviewed onboarding
configuration. Existing profiles, CDP sessions, clicks, scripts and forms keep
their individual approval requirements.

For a normal Kyberion pipeline step, request the restricted browser mode:

```json
{
  "id": "read-approved-public-page",
  "op": "browser:goto",
  "params": {
    "url": "https://example.com/public",
    "onboarding_isolated_navigation": true
  }
}
```

The actuator creates a fresh scratch profile with service workers and page
JavaScript disabled, blocks downloads, and closes/deletes the profile when the
operation ends. A context-wide network fence starts with no allowed origin;
only successful shared admission opens HTTPS GET/HEAD requests to the approved
origin. Redirects, URL queries/fragments, other origins and request methods are
blocked. This mode intentionally does not support sign-in or interactive web
applications. It returns the visited URL and action receipt; it does not retain
a session for a later pipeline step.

The direct actuator envelope supports the same configuration through
`options.onboarding_isolated_navigation: true`. A direct envelope may include
local observation steps, such as a screenshot, after navigation. Profile/CDP,
session, launch argument and recording overrides are rejected. Neither form of
the option supplies authority: absent, expired, stopped or mismatched grants
still fail closed through the shared gate.

# Tenant approval-queue inspection

`approval_queue_inspect` signs in to one tenant business system and reads its
approval-pending list as a single external operation
(`browser:approval_queue_inspect`). It is the only signed-in browser work a
tenant charter can delegate, and only by exact origin plus the SHA-256 of the
signed profile, for a profile that declares that single origin. Design and rollout:
[autonomous-approval-queue](../../../knowledge/product/architecture/autonomous-approval-queue.md).

```json
{
  "id": "inspect-workflow-queue",
  "type": "capture",
  "op": "browser:approval_queue_inspect",
  "params": {
    "profile": "knowledge/confidential/acme/approval-queues/workflow.json",
    "origin": "https://workflow.example.com",
    "export_as": "workflow_queue"
  }
}
```

The step must be the only step of its browser envelope and must run
tenant-bound. `origin` must be one of the profile's origins; `headless`
defaults to `true`.

## Profile

The profile is a JSON file under the running tenant's
`knowledge/confidential/<tenant>/approval-queues/`:

```json
{
  "version": 1,
  "system": "workflow",
  "origins": ["https://workflow.example.com"],
  "credential": {
    "service": "workflow",
    "user_key": "login_user",
    "password_key": "login_password"
  },
  "login": {
    "url": "https://workflow.example.com/login",
    "user_selector": "#user",
    "password_selector": "#password",
    "submit_selector": "button[type=submit]",
    "success_selector": "nav.main-menu",
    "failure_selector": ".login-error"
  },
  "navigate": [{ "goto": "https://workflow.example.com/approvals/pending" }],
  "list": {
    "ready_selector": "main",
    "row_selector": "table.pending tbody tr",
    "empty_selector": ".no-pending",
    "total_selector": ".pending-total",
    "fields": { "title": "td.subject", "applicant": "td.applicant", "submitted": "td.date" },
    "max_items": 200
  }
}
```

| Field                    | Meaning                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origins`                | Exact HTTPS origins the browser may reach. Only a single-origin profile can be delegated.                                                                                                                                                                                                             |
| `credential`             | Secret-guard keys: a lowercase service id and keys of letters, digits and `_`. `service` + key resolves to `<SERVICE>_<KEY>` (e.g. `WORKFLOW_LOGIN_USER`); register each with `pnpm kyberion secret introduce workflow LOGIN_USER` and list the service in the pipeline's `runtime.authorized_scope`. |
| `login.success_selector` | Required. Present only after a successful sign-in.                                                                                                                                                                                                                                                    |
| `login.failure_selector` | Optional. Shown when sign-in is rejected, so a wrong password fails at once instead of after the timeout.                                                                                                                                                                                             |
| `navigate`               | Up to 20 steps, each exactly one of `goto` (URL inside the origins), `click` (+ optional `has_text` substring filter) or `wait_for` (element attached).                                                                                                                                               |
| `list.ready_selector`    | Required. Present once the list area has rendered.                                                                                                                                                                                                                                                    |
| `list.row_selector`      | One element per pending item.                                                                                                                                                                                                                                                                         |
| `list.empty_selector`    | Required. The "nothing pending" message; it counts only while visible, so a hidden template does not. Match only the real empty-state message, never a loading placeholder. Hidden rows are not counted either. Zero rows without it fails instead of reporting 0.                                    |
| `list.total_selector`    | Optional. Element whose first number is the system's pending total; use it when the list is paginated. A total below the rendered rows fails, so point it at an element that holds only the total.                                                                                                    |
| `list.fields`            | Up to 16 `name → CSS selector` pairs, relative to a row. Names are lowercase `[a-z][a-z0-9_]*`. Without fields, items are empty and only the count is useful.                                                                                                                                         |
| `list.max_items`         | Rows returned (1–1000, default 200).                                                                                                                                                                                                                                                                  |

Each action waits up to 30 s and the whole run is bounded at 180 s. Reading
starts as soon as the first row is visible, and only visible rows count: when
a list streams rows in or keeps items in collapsed groups, set
`total_selector`, or point `ready_selector` at an element that appears only
after loading finishes.

## Confinement

The actuator launches a fresh in-memory context with service workers and
downloads blocked, confines every request, redirect hop and WebSocket to the
declared HTTPS origins (`authenticated-origin-set-v1`), makes other host names
unresolvable, removes WebRTC before page scripts run, and drops media and font
requests. Scripts and form posts run because sign-in needs them. Every request
is fetched through Node, so an outbound HTTP proxy is not supported. Clicks
(including `login.submit_selector`) whose text, value, `aria-label` or `title`
is a decisive verb (承認, 却下, 差し戻し, 確定, approve, reject, …) are refused.

## Result

The inspection lands in `context[export_as]` (default `approval_queue`):

| Field                                 | Meaning                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pending_count`                       | The system total when `total_selector` is set, otherwise the rendered rows.                                                          |
| `count_basis`                         | `total_indicator` or `rendered_rows`.                                                                                                |
| `rendered_rows`                       | Rows matched on the final page.                                                                                                      |
| `items`                               | Up to `max_items` rows of `fields`; values are whitespace-collapsed and clipped at 512 characters, and all items together at 256 KB. |
| `truncated`, `truncated_reason`       | `max_items`, `output_size`, or `not_rendered` (the total exceeds the rendered rows, e.g. pagination).                                |
| `extraction_misses`, `clipped_values` | Cells whose selector matched nothing, and values that were clipped.                                                                  |
| `observed_at`                         | ISO 8601 UTC.                                                                                                                        |
| `final_url`                           | Origin and path only; query, fragment and `;jsessionid` are removed.                                                                 |

Credentials never enter the result. A follow-up step can notify when
`{{workflow_queue.pending_count}}` is not 0.

## Failures

Errors use `[CODE] what — why | next | evidence` and name the phase, the
session-free URL and any blocked host names: `APPROVAL_QUEUE_PROFILE` and
`APPROVAL_QUEUE_INPUT` (fix the profile or step), `APPROVAL_QUEUE_CREDENTIAL`
(register the secret), `APPROVAL_QUEUE_LAUNCH` (install Chromium),
`APPROVAL_QUEUE_LOGIN` / `APPROVAL_QUEUE_LOGIN_REJECTED`,
`APPROVAL_QUEUE_NAVIGATE`, `APPROVAL_QUEUE_LIST` /
`APPROVAL_QUEUE_LIST_INDETERMINATE`, `APPROVAL_QUEUE_DECISIVE_CLICK` and
`APPROVAL_QUEUE_DEADLINE`. The operation only reads, so a failed run is
recorded as failed and the next scheduled run starts fresh; it does not wait
for a person to verify it. Do not set `on_error` retry on this step: a run
reserves its invocation, so a retry inside the same run stops as already
reserved. The next scheduled run is the retry.

## Delegating it

`pnpm kyberion browser approval-queue <profile.json>` prints the profile's
SHA-256 (the same value as `shasum -a 256 <profile.json>`), what it signs in
with and where it goes, and the grant to put in the tenant charter's
`envelope.external_operations`. Any byte change to the file, including
reformatting, changes the hash and needs a new signature.
