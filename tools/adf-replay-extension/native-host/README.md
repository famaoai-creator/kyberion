# Kyberion Browser Bridge — Native Messaging host

The host is the trust boundary between the Chrome extension and Kyberion. The
extension can observe and record, but it can only **execute** approved steps with
a lease that this host issues after schema validation, approval enforcement and
step-hash binding.

```
extension (sendNativeMessage)
   ↓ stdio frames (uint32-LE length + JSON)
launch.sh → node dist/scripts/browser_bridge_host.js
   ↓ @agent/core
preflight · approval gate · lease issuance · receipt validation
```

## Messages

| type                    | input                                                                         | output                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ping`                  | –                                                                             | `{ ok, pong, host_version }`                                                                                                         |
| `preflight`             | `recording`, `session`                                                        | `{ ok, status, approval_required, candidate }`                                                                                       |
| `request_execution`     | `recording`, `session`, `agentId?`                                            | `{ ok, status: 'authorized' \| 'approval_required', lease? }`                                                                        |
| `compile_pipeline`      | `recording`, `pipelineId?`                                                    | `{ ok, status: 'draft', draft }`                                                                                                     |
| `extend_lease`          | `lease`, `recording`, `session`                                               | `{ ok, status: 'extended', lease }`                                                                                                  |
| `submit_receipt`        | `receipt`                                                                     | `{ ok, status: 'recorded', receipt_id, evidence_path }`                                                                              |
| `resolve_intent`        | `intent`, `origin?`, `substrate?`                                             | `{ ok, resolution }`                                                                                                                 |
| `prepare_procedure`     | `procedure_id`                                                                | `{ ok, inputs, has_inputs }` (no side effects)                                                                                       |
| `dispatch_procedure`    | `procedure_id`, `origin`, `tab_id`                                            | `{ ok, status: 'dispatched' \| 'dispatched_segmented' \| 'approval_required', lease?/segments?, compiled_steps?, golden_scenario? }` |
| `save_recording`        | `recording`                                                                   | `{ ok, recording_ref, recording_id }`                                                                                                |
| `promote_procedure`     | `recording`, `procedure_id`, `intent_phrases[]`                               | `{ ok, status: 'registered', procedure_id, recording_ref, procedure }`                                                               |
| `save_procedure_delta`  | `procedure_id`, `anchor_step_index`, `error`, `step?`, `delta_recording_ref?` | `{ ok, status: 'classified' \| 'delta_saved', reason, delta_path? }`                                                                 |
| `apply_procedure_delta` | `procedure_id`, `delta_path`                                                  | `{ ok, status: 'merged', merged_recording_ref }`                                                                                     |

`request_execution` / `dispatch_procedure` return `approval_required` (with a
`request_id`) when the recording contains high-risk actions that have no granted
approval yet. Once the approval is granted in Kyberion, calling again returns an
`authorized`/`dispatched` lease.

`dispatch_procedure` is the Pattern B (resolve-and-execute) entry point: it loads
the reviewed recording referenced by the catalog entry's `adapter.recording_ref`
(which must resolve inside an allowlisted shared or personal recording store), routes through
the shared dispatcher (origin guard → approval gate → lease), and re-runs the
authoritative execute-mode preflight before returning the lease + compiled steps.
For multi-origin procedures it returns `dispatched_segmented` with one
origin-bound lease per segment. `prepare_procedure` (no side effects) reports the
user inputs to collect before dispatch. The returned `golden_scenario`'s success
conditions are verified against the live page after execution.
`apply_procedure_delta` merges a saved corrective delta into the base recording
(review.status=pending) for human-gated re-promotion via `promote_procedure`.

`submit_receipt` persists the validated receipt to
`active/shared/runtime/browser-receipts/` as durable evidence; `save_procedure_delta`
stores self-repair deltas under `active/shared/runtime/procedure-deltas/{procedure_id}/`.
Both directories are TTL-governed by `storage-janitor` (receipts ~90d, deltas ~14d).

## Install (macOS / Linux) — scripted

1. Build the host: `pnpm build` (or `npx tsc`) — emits `dist/scripts/browser_bridge_host.js`.
2. Load the unpacked extension and copy its ID from `chrome://extensions`.
3. Run the installer with that ID:
   ```
   tools/adf-replay-extension/native-host/install.sh <CHROME_EXTENSION_ID>
   ```
   It pins the current `node` path (Chrome launches native hosts with a minimal
   PATH), writes the manifest with the resolved launcher path + extension ID, and
   installs it into every Chrome/Chromium profile dir present.
4. **Fully quit and reopen Chrome** (native host manifests are read at startup),
   then retry execution from the Run tab.

### Manual install (if you prefer)

Edit `com.kyberion.browser_bridge.json` (`path` → absolute `native-host/launch.sh`,
extension ID in `allowed_origins`) and copy it to:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/`

The host name (`com.kyberion.browser_bridge`) and the extension ID allowlist are
the two pins that keep any other page or extension from reaching the host.
