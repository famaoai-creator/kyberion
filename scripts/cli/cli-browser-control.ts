/**
 * `pnpm kyberion browser control` — interactive, session-leased browser
 * control over the Chrome extension bridge (Claude-for-Chrome style).
 *
 *   open <url> [--label <t>] [--ceiling low|observe] [--no-wait]
 *                       Ask the operator for a session on the URL's origin,
 *                       then open a bound tab (waits for the approval by default)
 *   sessions            List sessions and their status
 *   close <session>     Revoke a session
 *   tabs|tab <tab_id>|navigate <url>|snapshot|click <ref>|fill <ref> <value>|
 *   select <ref> (--text <t>|--checked)|press <ref> [--key <k>]|
 *   wait <ref>|extract <ref> [--secret <name>]
 *                       Run one step in the active (or --session) session
 *   resume <approval_id>
 *                       Run the step its per-step approval was granted for
 *
 *     common: [--session <BCS-…>] [--mission <id>] [--timeout-sec N] [--json]
 *
 * Consent model: the session approval IS the consent for low-risk steps;
 * high-risk ops escalate to a per-step approval (resume after
 * `pnpm kyberion approvals --approve <id>`). Steps never carry arbitrary
 * JavaScript — the op vocabulary is fixed by the mailbox schema.
 */
import {
  approvalStatus,
  awaitStepResult,
  completeStepApproval,
  drainStepSecrets,
  endBrowserControlSession,
  enqueueSessionStep,
  loadPendingStep,
  mintSessionIfApproved,
  requestBrowserControlSession,
} from '@agent/shared-vision/browser-control-service';
import { listBrowserControlSessions } from '@agent/shared-vision/browser-control-sessions';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { detectCliAgentPrincipal } from '@agent/core/governance/cli-operator-principal';
import type { BrowserBridgeControlStep } from '@agent/shared-vision/browser-bridge-mailbox';
import { ScriptExitError } from '../lib/harness.js';
import { resolveBrowserBridgeActor } from './cli-browser-bridge.js';

export const BROWSER_CONTROL_USAGE = `Usage: pnpm kyberion browser control <verb> [options]

  open <url> [--label <text>] [--ceiling low|observe] [--no-wait]
  sessions | close <session>
  tabs | tab <tab_id> | navigate <url> | snapshot
  click <ref> | fill <ref> <value> | select <ref> (--text <t>|--checked)
  press <ref> [--key <key>] | wait <ref> | extract <ref> [--secret <name>]
  resume <approval_id>
    common: [--session <BCS-…>] [--mission <id>] [--timeout-sec N] [--json]`;

const STEP_OPS = new Set([
  'snapshot',
  'screenshot',
  'extract_text_ref',
  'list_tabs',
  'open_tab',
  'select_tab',
  'navigate',
  'click_ref',
  'click_if_present',
  'fill_ref',
  'select_ref',
  'press_ref',
  'wait_for_ref',
  'submit_form',
  'upload_file',
  'download_file',
  'delete',
  'purchase',
  'credential_submit',
  'settings_change',
]);

function fail(message: string): never {
  throw new ScriptExitError(1, `${message}\n\n${BROWSER_CONTROL_USAGE}`);
}

let stepCounter = 0;
function nextStepId(): string {
  stepCounter += 1;
  return `cli-${Date.now()}-${stepCounter}`;
}

interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (['json', 'no-wait', 'checked', 'verbose'].includes(name)) {
      options[name] = true;
    } else {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
      options[name] = value;
      i += 1;
    }
  }
  return { positionals, options };
}

function str(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveSessionId(parsed: ParsedArgs): string {
  const explicit = str(parsed.options, 'session');
  if (explicit) return explicit;
  const active = listBrowserControlSessions()
    .filter((session) => session.status === 'active')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (active.length === 0) {
    fail('no active browser-control session — run `browser control open <url>` first');
  }
  return active[0].session_id;
}

function actorOf(parsed: ParsedArgs): { actor_id: string; mission_id?: string } {
  void detectCliAgentPrincipal;
  return {
    actor_id: resolveBrowserBridgeActor(),
    ...(str(parsed.options, 'mission') ? { mission_id: str(parsed.options, 'mission') } : {}),
  };
}

function timeoutMs(parsed: ParsedArgs): number {
  const seconds = Number(str(parsed.options, 'timeout-sec') ?? '120');
  return Math.max(5_000, Math.min(300_000, Math.round(seconds * 1000)));
}

function buildStep(parsed: ParsedArgs): BrowserBridgeControlStep {
  const [verb, ...rest] = parsed.positionals;
  const step: BrowserBridgeControlStep = { step_id: nextStepId(), op: 'snapshot' };
  const need = (index: number, what: string): string => {
    const value = rest[index];
    if (!value) fail(`${verb} needs ${what}`);
    return value;
  };
  switch (verb) {
    case 'tabs':
      step.op = 'list_tabs';
      break;
    case 'tab':
      step.op = 'select_tab';
      step.tab_id = Number(need(0, '<tab_id>'));
      if (!Number.isInteger(step.tab_id)) fail('tab_id must be an integer (see `tabs`)');
      break;
    case 'navigate':
      step.op = 'navigate';
      step.url = need(0, '<url>');
      break;
    case 'snapshot':
      step.op = 'snapshot';
      break;
    case 'screenshot':
      step.op = 'screenshot';
      break;
    case 'click':
      step.op = 'click_ref';
      step.ref = need(0, '<ref>');
      break;
    case 'click-if-present':
      step.op = 'click_if_present';
      step.ref = need(0, '<ref>');
      break;
    case 'fill':
      step.op = 'fill_ref';
      step.ref = need(0, '<ref>');
      step.value = need(1, '<value>');
      break;
    case 'select':
      step.op = 'select_ref';
      step.ref = need(0, '<ref>');
      if (parsed.options.checked === true) step.checked = true;
      else step.text = str(parsed.options, 'text') ?? need(1, '--text <label> or --checked');
      break;
    case 'press':
      step.op = 'press_ref';
      step.ref = need(0, '<ref>');
      step.key = str(parsed.options, 'key') ?? 'Enter';
      break;
    case 'wait':
      step.op = 'wait_for_ref';
      step.ref = need(0, '<ref>');
      break;
    case 'extract':
      step.op = 'extract_text_ref';
      step.ref = need(0, '<ref>');
      step.secret_name = str(parsed.options, 'secret');
      break;
    case 'submit':
      step.op = 'submit_form';
      step.ref = need(0, '<ref>');
      break;
    case 'settings-change':
      step.op = 'settings_change';
      step.ref = need(0, '<ref>');
      break;
    case 'credential-submit':
      step.op = 'credential_submit';
      step.ref = need(0, '<ref>');
      break;
    default:
      fail(`unknown verb: ${verb}`);
  }
  if (!STEP_OPS.has(step.op)) fail(`unsupported op: ${step.op}`);
  const label = str(parsed.options, 'label');
  if (label) step.label = label;
  const role = str(parsed.options, 'role');
  if (role) step.role = role;
  const name = str(parsed.options, 'name');
  if (name) step.name = name;
  return step;
}

function printResult(out: unknown, json: boolean, print: (line: string) => void): void {
  if (json) {
    print(JSON.stringify(out, null, 2));
  } else {
    print(typeof out === 'string' ? out : JSON.stringify(out));
  }
}

async function waitForApproval(approvalRequestId: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { status } = approvalStatus(approvalRequestId);
    if (status === 'approved') return;
    if (status !== 'pending') {
      fail(`approval ${approvalRequestId} is ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail(`timed out waiting for approval ${approvalRequestId}`);
}

async function deliverResult(
  sessionId: string,
  requestId: string,
  parsed: ParsedArgs,
  print: (line: string) => void
): Promise<void> {
  const record = await withExecutionContextAsync(
    'sovereign_concierge',
    () => awaitStepResult(sessionId, requestId, { timeoutMs: timeoutMs(parsed) }),
    'sovereign'
  );
  const json = parsed.options.json === true;
  if (record.status !== 'completed') {
    printResult({ status: record.status, error: record.response?.error }, json, print);
    throw new ScriptExitError(1, `step ${record.status}: ${record.response?.error ?? ''}`);
  }
  const secrets = drainStepSecrets(requestId);
  printResult(
    {
      status: 'completed',
      request_id: requestId,
      result: record.response?.result,
      ...(secrets ? { secrets } : {}),
    },
    json,
    print
  );
}

export async function runBrowserControlCommand(
  args: string[],
  print: (line: string) => void
): Promise<void> {
  const parsed = parseArgs(args);
  const [verb] = parsed.positionals;
  if (!verb || parsed.options.help === true) fail('missing verb');
  const json = parsed.options.json === true;

  if (verb === 'open') {
    const url = parsed.positionals[1];
    if (!url) fail('open needs <url>');
    const actor = actorOf(parsed);
    const { approval_request_id, origin } = requestBrowserControlSession({
      origin: url,
      risk_ceiling: (str(parsed.options, 'ceiling') as 'low' | 'observe') ?? 'low',
      label: str(parsed.options, 'label'),
      actor,
    });
    if (parsed.options['no-wait'] === true) {
      printResult(
        {
          status: 'approval_pending',
          approval_request_id,
          origin,
          approve: `pnpm kyberion approvals --approve ${approval_request_id}`,
          then: `pnpm kyberion browser control open ${url} --approval ${approval_request_id}`,
        },
        json,
        print
      );
      return;
    }
    print(
      `waiting for operator approval: pnpm kyberion approvals --approve ${approval_request_id}`
    );
    await waitForApproval(approval_request_id, timeoutMs(parsed));
    const minted = mintSessionIfApproved(approval_request_id, {
      origin,
      risk_ceiling: (str(parsed.options, 'ceiling') as 'low' | 'observe') ?? 'low',
      label: str(parsed.options, 'label'),
      actor,
    });
    if (!minted.session) fail(`session not minted (approval ${minted.status})`);
    print(`session ${minted.session.session_id} active on ${minted.session.origin}`);
    const queued = withExecutionContext(
      'sovereign_concierge',
      () =>
        enqueueSessionStep({
          session_id: minted.session.session_id,
          step: { step_id: nextStepId(), op: 'open_tab', url },
          actor,
        }),
      'sovereign'
    );
    if (queued.status !== 'queued') fail(`open_tab denied: ${JSON.stringify(queued)}`);
    await deliverResult(minted.session.session_id, queued.request_id, parsed, print);
    return;
  }

  if (verb === 'sessions') {
    printResult(
      listBrowserControlSessions().map(({ approved_step_hashes: _h, ...session }) => session),
      true,
      print
    );
    return;
  }

  if (verb === 'close') {
    const sessionId = parsed.positionals[1] ?? str(parsed.options, 'session');
    if (!sessionId) fail('close needs <session>');
    const session = endBrowserControlSession(sessionId);
    if (!session) fail(`session ${sessionId} not found`);
    printResult({ status: 'revoked', session_id: session.session_id }, json, print);
    return;
  }

  if (verb === 'resume') {
    const approvalId = parsed.positionals[1];
    if (!approvalId) fail('resume needs <approval_id>');
    const pending = loadPendingStep(approvalId);
    if (!pending) fail(`no pending step for approval ${approvalId}`);
    const actor = actorOf(parsed);
    const queued = withExecutionContext(
      'sovereign_concierge',
      () =>
        completeStepApproval({
          session_id: pending.session_id,
          step: pending.step as BrowserBridgeControlStep,
          approval_request_id: approvalId,
          actor,
        }),
      'sovereign'
    );
    if (queued.status !== 'queued') fail(`resume denied: ${JSON.stringify(queued)}`);
    await deliverResult(pending.session_id, queued.request_id, parsed, print);
    return;
  }

  // Step verbs — need a live session.
  const sessionId = resolveSessionId(parsed);
  const step = buildStep(parsed);
  const actor = actorOf(parsed);
  const outcome = withExecutionContext(
    'sovereign_concierge',
    () => enqueueSessionStep({ session_id: sessionId, step, actor }),
    'sovereign'
  );
  if (outcome.status === 'approval_required') {
    printResult(
      {
        status: 'approval_required',
        approval_request_id: outcome.approval_request_id,
        approve: `pnpm kyberion approvals --approve ${outcome.approval_request_id}`,
        then: `pnpm kyberion browser control resume ${outcome.approval_request_id}`,
      },
      json,
      print
    );
    return;
  }
  if (outcome.status === 'denied') {
    fail(`step denied: ${outcome.reason}`);
  }
  await deliverResult(sessionId, outcome.request_id, parsed, print);
}
