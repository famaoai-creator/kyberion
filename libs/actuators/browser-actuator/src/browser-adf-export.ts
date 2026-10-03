import { isRecord } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { normalizeBrowserPipelineOp } from '@agent/core/pipeline/op-vocabulary';
import { getOpInputContract, validateOpInput } from '@agent/core/pipeline/op-input-contracts';

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

export interface BrowserAction {
  action: 'pipeline';
  steps: PipelineStep[];
  session_id?: string;
}

export interface BrowserRecordedAction {
  kind: 'control' | 'capture' | 'apply';
  op: string;
  tab_id?: string;
  url?: string;
  title?: string;
  ref?: string;
  selector?: string;
  /** Structural path used by fill_secret_ref requireDomPathMatch corroboration. */
  dom_path?: string;
  text?: string;
  key?: string;
  fallback_strategy?: string;
  element_name?: string;
  element_role?: string | null;
  content_excerpt?: string;
  classification?: 'user_input' | 'secret_ref';
  secret_ref?: string;
  redacted?: boolean;
  approval_request_id?: string;
  resume_status?: 'pending' | 'approved' | 'rejected' | 'expired';
  ts: string;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

export function parseRecordedAction(value: unknown): BrowserRecordedAction | null {
  if (!isRecord(value)) return null;

  const kind = value.kind;
  const op = optionalString(value, 'op');
  const ts = optionalString(value, 'ts');
  if (
    (kind !== 'control' && kind !== 'capture' && kind !== 'apply') ||
    !op?.trim() ||
    !ts?.trim() ||
    !Number.isFinite(Date.parse(ts))
  ) {
    return null;
  }

  const classificationValue = value.classification;
  const classification: BrowserRecordedAction['classification'] | null =
    classificationValue === undefined
      ? undefined
      : classificationValue === 'user_input' || classificationValue === 'secret_ref'
        ? classificationValue
        : null;
  if (classification === null) return null;
  const resumeStatusValue = value.resume_status;
  const resumeStatus: BrowserRecordedAction['resume_status'] | null =
    resumeStatusValue === undefined
      ? undefined
      : resumeStatusValue === 'pending' ||
          resumeStatusValue === 'approved' ||
          resumeStatusValue === 'rejected' ||
          resumeStatusValue === 'expired'
        ? resumeStatusValue
        : null;
  if (resumeStatus === null) return null;

  const stringFields = [
    'tab_id',
    'url',
    'title',
    'ref',
    'selector',
    'dom_path',
    'text',
    'key',
    'element_name',
    'content_excerpt',
    'secret_ref',
    'approval_request_id',
    'fallback_strategy',
  ];
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return null;
  }
  if (
    value.element_role !== undefined &&
    value.element_role !== null &&
    typeof value.element_role !== 'string'
  ) {
    return null;
  }
  if (value.redacted !== undefined && typeof value.redacted !== 'boolean') return null;

  return {
    kind,
    op,
    ts,
    ...(optionalString(value, 'tab_id') !== undefined ? { tab_id: value.tab_id as string } : {}),
    ...(optionalString(value, 'url') !== undefined ? { url: value.url as string } : {}),
    ...(optionalString(value, 'title') !== undefined ? { title: value.title as string } : {}),
    ...(optionalString(value, 'ref') !== undefined ? { ref: value.ref as string } : {}),
    ...(optionalString(value, 'selector') !== undefined
      ? { selector: value.selector as string }
      : {}),
    ...(optionalString(value, 'dom_path') !== undefined
      ? { dom_path: value.dom_path as string }
      : {}),
    ...(optionalString(value, 'text') !== undefined ? { text: value.text as string } : {}),
    ...(optionalString(value, 'key') !== undefined ? { key: value.key as string } : {}),
    ...(optionalString(value, 'fallback_strategy') !== undefined
      ? { fallback_strategy: value.fallback_strategy as string }
      : {}),
    ...(optionalString(value, 'element_name') !== undefined
      ? { element_name: value.element_name as string }
      : {}),
    ...(value.element_role !== undefined
      ? { element_role: value.element_role as string | null }
      : {}),
    ...(optionalString(value, 'content_excerpt') !== undefined
      ? { content_excerpt: value.content_excerpt as string }
      : {}),
    ...(classification !== undefined ? { classification } : {}),
    ...(optionalString(value, 'secret_ref') !== undefined
      ? { secret_ref: value.secret_ref as string }
      : {}),
    ...(value.redacted !== undefined ? { redacted: value.redacted as boolean } : {}),
    ...(optionalString(value, 'approval_request_id') !== undefined
      ? { approval_request_id: value.approval_request_id as string }
      : {}),
    ...(resumeStatus !== undefined ? { resume_status: resumeStatus } : {}),
  };
}

export function parseRecordedActions(value: unknown): BrowserRecordedAction[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const parsed = parseRecordedAction(entry);
        return parsed ? [parsed] : [];
      })
    : [];
}

function trimmedRecordedField(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const next = value.trim();
  return next || undefined;
}

function durableHintParams(action: BrowserRecordedAction): Record<string, string> {
  const name = trimmedRecordedField(action.element_name);
  const role = trimmedRecordedField(action.element_role);
  return {
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
  };
}

/**
 * Prefer a CSS selector (plus recorded role/name) so a fresh session can
 * replay without the ephemeral `@eN` ref_map from the recording session.
 * `click({ref})` is still canonical and routes to click_ref; fill/press/wait
 * do not, so those fall back to their `*_ref` ops when only a ref remains.
 */
function renderDurableApplyStep(
  canonicalOp: 'click' | 'fill' | 'press' | 'wait',
  action: BrowserRecordedAction,
  extra: Record<string, unknown> = {}
): { step: PipelineStep; needsSnapshot: boolean } | null {
  const selector = trimmedRecordedField(action.selector);
  const hints = durableHintParams(action);
  if (selector) {
    return {
      step: { type: 'apply', op: canonicalOp, params: { selector, ...hints, ...extra } },
      needsSnapshot: false,
    };
  }
  const ref = trimmedRecordedField(action.ref);
  if (!ref) return null;
  const refOp = canonicalOp === 'click' ? 'click' : `${canonicalOp}_ref`;
  return {
    step: { type: 'apply', op: refOp, params: { ref, ...hints, ...extra } },
    // click_ref / *_ref can resolve {role,name} against the live page.
    needsSnapshot: !hints.name && !hints.role,
  };
}

function renderSecretFillStep(
  action: BrowserRecordedAction
): { step: PipelineStep; needsSnapshot: boolean } | null {
  const ref = trimmedRecordedField(action.ref);
  const secretRef = trimmedRecordedField(action.secret_ref);
  if (!ref || !secretRef) return null;
  const hints = durableHintParams(action);
  // Prefer an explicit trail `dom_path` (extension recordings / secret-fill
  // bookkeeping). Snapshot `selector` is the same nth-of-type ancestor path
  // and is the fallback when older trails only stored selector.
  const domPath = trimmedRecordedField(action.dom_path) ?? trimmedRecordedField(action.selector);
  // Fresh snapshot @eN is not a secret-field identity. Without a recorded
  // path, omit the step (fail closed) instead of snapshot + ref replay.
  if (!domPath) return null;
  return {
    step: {
      type: 'apply',
      op: 'fill_secret_ref',
      params: {
        ref,
        secret_ref: secretRef,
        ...hints,
        dom_path: domPath,
      },
    },
    needsSnapshot: false,
  };
}

export function renderBrowserAdf(trail: BrowserRecordedAction[], sessionId: string): BrowserAction {
  const steps: PipelineStep[] = [];
  const skipped: string[] = [];
  let refsEstablished = false;

  const ensureSnapshot = () => {
    if (refsEstablished) return;
    steps.push({ type: 'capture', op: 'snapshot', params: {} });
    refsEstablished = true;
  };

  const pushApply = (rendered: { step: PipelineStep; needsSnapshot: boolean } | null) => {
    if (!rendered) return;
    if (rendered.needsSnapshot) ensureSnapshot();
    steps.push(rendered.step);
  };

  for (const action of parseRecordedActions(trail)) {
    const op = normalizeBrowserPipelineOp(action.op);
    const contract = getOpInputContract('browser', op);
    const properties = contract?.schema?.properties;
    const input =
      properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.fromEntries(
            Object.keys(action)
              .filter((key) => key in (properties as Record<string, unknown>))
              .map((key) => [key, (action as unknown as Record<string, unknown>)[key]])
          )
        : action;
    const validation = validateOpInput('browser', op, input);
    if (!validation.valid) {
      // Secret fills stay fail-fast: silently dropping an auth step would
      // produce a replay that fails at login with no obvious cause.
      const isSecret =
        op === 'fill_secret_ref' ||
        (action as BrowserRecordedAction).classification === 'secret_ref' ||
        Boolean((action as BrowserRecordedAction).secret_ref);
      if (isSecret) {
        throw new Error(
          `[INVALID_OP_INPUT] browser:${op}: ${'errors' in validation ? validation.errors.join('; ') : ''}`
        );
      }
      // Non-secret unreplayable entries are skipped so one bad entry does not
      // abort the whole export. Each skip is logged; the total is logged below.
      skipped.push(op);
      logger.warn(
        `[BROWSER] renderBrowserAdf skips invalid trail entry browser:${op}: ${'errors' in validation ? validation.errors.join('; ') : 'invalid input'}`
      );
      continue;
    }
    switch (op) {
      case 'goto':
      case 'open_tab':
        if (action.url) {
          steps.push({ type: 'capture', op: 'goto', params: { url: action.url } });
          refsEstablished = false;
        }
        break;
      case 'snapshot':
        steps.push({ type: 'capture', op: 'snapshot', params: {} });
        refsEstablished = true;
        break;
      case 'screenshot':
        // Keep the visual-evidence step so replay retains its shape. The trail
        // records no output path, so replay takes a fresh screenshot.
        steps.push({ type: 'capture', op: 'screenshot', params: {} });
        break;
      case 'scroll':
        // The scroll executor only honors wheel delta (params.x/y/delta), not a
        // selector, and the recorded trail stores only content_excerpt=delta(x,y).
        // Emitting a selector-based scroll would replay as a (0,0) no-op, so the
        // step is intentionally dropped (logged) instead of pretending replayability.
        skipped.push('scroll');
        logger.warn(
          '[BROWSER] renderBrowserAdf drops scroll: wheel-delta replay is timing-dependent; re-add a wait/snapshot anchor instead'
        );
        break;
      case 'select_tab':
        // tab_id (e.g. tab-1) is ephemeral and not durable across sessions.
        // The trail carries no url/title to synthesize select_tab_matching, so
        // drop with a hint instead of emitting a replay that mis-selects.
        skipped.push('select_tab');
        logger.warn(
          '[BROWSER] renderBrowserAdf drops select_tab: ephemeral tab_id is not replayable; record url/title and use select_tab_matching'
        );
        break;
      case 'select_tab_matching': {
        const rec = action as unknown as Record<string, string | undefined>;
        const urlIncludes = rec.url_includes ?? rec.url;
        const titleIncludes = rec.title_includes ?? rec.title;
        const params: Record<string, string> = {};
        if (typeof urlIncludes === 'string' && urlIncludes.trim())
          params.url_includes = urlIncludes.trim();
        if (typeof titleIncludes === 'string' && titleIncludes.trim())
          params.title_includes = titleIncludes.trim();
        if (Object.keys(params).length > 0)
          steps.push({ type: 'control', op: 'select_tab_matching', params });
        break;
      }
      case 'click':
        pushApply(renderDurableApplyStep('click', action));
        break;
      case 'fill':
        if (action.secret_ref || action.classification === 'secret_ref') {
          pushApply(renderSecretFillStep(action));
        } else {
          pushApply(renderDurableApplyStep('fill', action, { text: action.text || '' }));
        }
        break;
      case 'press':
        pushApply(renderDurableApplyStep('press', action, { key: action.key || 'Enter' }));
        break;
      case 'wait':
        pushApply(renderDurableApplyStep('wait', action));
        break;
      case 'fill_secret_ref':
        pushApply(renderSecretFillStep(action));
        break;
      default:
        break;
    }
  }

  if (skipped.length > 0) {
    logger.warn(
      `[BROWSER] renderBrowserAdf skipped ${skipped.length} unreplayable entr${skipped.length === 1 ? 'y' : 'ies'}: ${skipped.join(', ')}`
    );
  }

  return {
    action: 'pipeline',
    session_id: sessionId,
    steps,
  } as BrowserAction;
}
