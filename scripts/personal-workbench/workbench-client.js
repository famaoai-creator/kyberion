/*
 * workbench-client.js — browser module of the personal-workbench pad (PA-06),
 * inlined into the page by `page.ts` (`renderPadPage({ scriptModule })`).
 *
 * Hosts (renderA2UI replaces a whole container, so each group has its own):
 *   #pw-capture          ui:section  kind ui:select, title, body, JSON metadata, save ui:button
 *   #pw-capture-status   ui:callout  save result
 *   #pw-entries          ui:section  "read saved data" action + ui:list / ui:empty-state
 *   #pw-calendar         ui:section  propose → confirmation ui:checkbox → apply
 *   #pw-calendar-status  ui:callout  calendar flow state
 *   #pw-actions          ui:section  governed action ui:select + JSON payload + run
 *   #pw-action-result    ui:callout + ui:code  action result
 *
 * Field values live in the model (field.change); forms are re-rendered only
 * when the page replaces their values.
 *
 * Server contract (unchanged): POST /capture `{ kind, title, body, metadata }`,
 * POST /load `{}` → `{ entries, calendar_proposals }`, POST /action
 * `{ action, payload, confirmed? }`, all with header `X-PW-Token`.
 */
/* global document */
import { bootPad } from '/pad-ui/pad-client.js';

const KINDS = ['link', 'task', 'follow-up', 'decision', 'expense', 'daily-review'];
const ACTIONS = ['ocr', 'knowledge', 'email'];
const BODY_PREVIEW = 200;

const host = {
  capture: document.getElementById('pw-capture'),
  captureStatus: document.getElementById('pw-capture-status'),
  entries: document.getElementById('pw-entries'),
  calendar: document.getElementById('pw-calendar'),
  calendarStatus: document.getElementById('pw-calendar-status'),
  actions: document.getElementById('pw-actions'),
  actionResult: document.getElementById('pw-action-result'),
};

const pad = bootPad({ onAction: handleAction });
const { bootstrap, t } = pad;
const K = (key) => t(`personal_workbench:${key}`);

const model = {
  kind: 'link',
  title: '',
  body: '',
  meta: '',
  cal_summary: '',
  cal_start: '',
  cal_end: '',
  cal_desc: '',
  cal_confirm: false,
  cal_approval_id: '',
  action: 'ocr',
  action_payload: '',
};
let entries = null;

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function kindLabel(kind) {
  return KINDS.includes(kind) ? K(`kind_${kind.replace(/-/g, '_')}`) : String(kind || '');
}

async function post(path, body, withJsonType = true) {
  const headers = { 'X-PW-Token': bootstrap.token };
  if (withJsonType) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }
  if (!response.ok || !json || !json.ok) {
    throw new Error((json && json.error) || `HTTP ${response.status}`);
  }
  return json;
}

/** Write a field value into its rendered control (addressed by field name) without re-rendering it. */
function setControl(name, value) {
  const node = document.querySelector(`.kb-app-shell [name="${name}"]`);
  if (!node) return;
  if (node.type === 'checkbox') node.checked = value === true;
  else node.value = value;
}

function callout(container, id, tone, title, body) {
  pad.render(container, [
    { id, type: 'ui:callout', props: body ? { tone, title, body } : { tone, title } },
  ]);
}

// -- rendering -------------------------------------------------------------

function renderCapture() {
  pad.render(host.capture, [
    {
      id: 'pw-capture-section',
      type: 'ui:section',
      props: { title: K('capture_title') },
      children: ['pw-capture-stack'],
    },
    {
      id: 'pw-capture-stack',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['pw-kind', 'pw-title', 'pw-body', 'pw-meta', 'pw-save', 'pw-out'],
    },
    {
      id: 'pw-kind',
      type: 'ui:select',
      props: {
        name: 'kind',
        label: K('kind'),
        value: model.kind,
        options: KINDS.map((value) => ({ value, label: kindLabel(value) })),
      },
    },
    {
      id: 'pw-title',
      type: 'ui:text-field',
      props: { name: 'title', label: K('entry_title'), maxlength: 200, value: model.title },
    },
    {
      id: 'pw-body',
      type: 'ui:textarea',
      props: { name: 'body', label: K('entry_body'), rows: 6, value: model.body },
    },
    {
      id: 'pw-meta',
      type: 'ui:textarea',
      props: {
        name: 'meta',
        label: K('metadata'),
        placeholder: K('metadata_placeholder'),
        rows: 2,
        value: model.meta,
      },
    },
    {
      id: 'pw-save',
      type: 'ui:button',
      props: { label: K('save'), variant: 'primary', action: { id: 'pw.save' } },
    },
    {
      id: 'pw-out',
      type: 'ui:text',
      props: {
        text: t('personal_workbench:out_path', { path: bootstrap.outLabel }),
        variant: 'caption',
      },
    },
  ]);
}

function renderEntries() {
  const children = ['pw-entries-body'];
  let body;
  if (entries === null) {
    body = {
      id: 'pw-entries-body',
      type: 'ui:empty-state',
      props: { title: K('entries_not_loaded'), body: K('entries_not_loaded_body') },
    };
  } else if (entries.length === 0) {
    body = { id: 'pw-entries-body', type: 'ui:empty-state', props: { title: K('entries_empty') } };
  } else {
    body = {
      id: 'pw-entries-body',
      type: 'ui:list',
      props: {
        items: entries
          .slice()
          .reverse()
          .map((entry) => {
            const text = String(entry.body || '');
            const snippet = text.length > BODY_PREVIEW ? `${text.slice(0, BODY_PREVIEW)}…` : text;
            const meta = t('personal_workbench:entry_meta', {
              kind: kindLabel(entry.kind),
              status:
                entry.status === 'proposed' ? K('status_proposed') : String(entry.status || ''),
              created_at: String(entry.created_at || ''),
            });
            return {
              title: String(entry.title || ''),
              meta: `${meta}${snippet ? ` — ${snippet}` : ''}`.slice(0, 400),
            };
          }),
      },
    };
  }
  pad.render(host.entries, [
    {
      id: 'pw-entries-section',
      type: 'ui:section',
      props: {
        title: K('saved_title'),
        actions: [{ label: K('load'), variant: 'secondary', action: { id: 'pw.load' } }],
      },
      children,
    },
    body,
  ]);
}

function renderCalendar() {
  pad.render(host.calendar, [
    {
      id: 'pw-cal-section',
      type: 'ui:section',
      props: { title: K('calendar_title') },
      children: ['pw-cal-grid', 'pw-cal-desc', 'pw-cal-steps'],
    },
    {
      id: 'pw-cal-grid',
      type: 'ui:grid',
      props: { gap: 'md', min_column_width: 'md' },
      children: ['pw-cal-summary', 'pw-cal-start', 'pw-cal-end'],
    },
    {
      id: 'pw-cal-summary',
      type: 'ui:text-field',
      props: {
        name: 'cal_summary',
        label: K('cal_summary'),
        placeholder: K('cal_summary_placeholder'),
        value: model.cal_summary,
      },
    },
    {
      id: 'pw-cal-start',
      type: 'ui:text-field',
      props: {
        name: 'cal_start',
        label: K('cal_start'),
        placeholder: K('cal_start_placeholder'),
        value: model.cal_start,
      },
    },
    {
      id: 'pw-cal-end',
      type: 'ui:text-field',
      props: {
        name: 'cal_end',
        label: K('cal_end'),
        placeholder: K('cal_end_placeholder'),
        value: model.cal_end,
      },
    },
    {
      id: 'pw-cal-desc',
      type: 'ui:textarea',
      props: { name: 'cal_desc', label: K('cal_description'), rows: 2, value: model.cal_desc },
    },
    {
      id: 'pw-cal-steps',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['pw-cal-propose', 'pw-cal-confirm', 'pw-cal-approval', 'pw-cal-apply'],
    },
    {
      id: 'pw-cal-propose',
      type: 'ui:button',
      props: { label: K('cal_propose'), variant: 'primary', action: { id: 'pw.cal.propose' } },
    },
    {
      id: 'pw-cal-confirm',
      type: 'ui:checkbox',
      props: { name: 'cal_confirm', label: K('cal_confirm'), value: model.cal_confirm },
    },
    {
      id: 'pw-cal-approval',
      type: 'ui:text-field',
      props: {
        name: 'cal_approval_id',
        label: K('cal_approval_id'),
        placeholder: K('cal_approval_placeholder'),
        value: model.cal_approval_id,
      },
    },
    {
      id: 'pw-cal-apply',
      type: 'ui:button',
      props: { label: K('cal_apply'), variant: 'secondary', action: { id: 'pw.cal.apply' } },
    },
  ]);
}

function renderActions() {
  pad.render(host.actions, [
    {
      id: 'pw-actions-section',
      type: 'ui:section',
      props: { title: K('actions_title'), description: K('actions_hint') },
      children: ['pw-actions-stack'],
    },
    {
      id: 'pw-actions-stack',
      type: 'ui:stack',
      props: { gap: 'md' },
      children: ['pw-action', 'pw-action-payload', 'pw-action-run'],
    },
    {
      id: 'pw-action',
      type: 'ui:select',
      props: {
        name: 'action',
        label: K('action'),
        value: model.action,
        options: ACTIONS.map((value) => ({ value, label: K(`action_${value}`) })),
      },
    },
    {
      id: 'pw-action-payload',
      type: 'ui:textarea',
      props: {
        name: 'action_payload',
        label: K('action_payload'),
        placeholder: K('action_payload_placeholder'),
        rows: 4,
        value: model.action_payload,
      },
    },
    {
      id: 'pw-action-run',
      type: 'ui:button',
      props: { label: K('run_action'), variant: 'primary', action: { id: 'pw.action.run' } },
    },
  ]);
}

function renderActionResult(tone, title, result) {
  const components = [
    {
      id: 'pw-action-result-stack',
      type: 'ui:stack',
      props: { gap: 'sm' },
      children:
        result === undefined ? ['pw-action-callout'] : ['pw-action-callout', 'pw-action-code'],
    },
    { id: 'pw-action-callout', type: 'ui:callout', props: { tone, title } },
  ];
  if (result !== undefined) {
    components.push({
      id: 'pw-action-code',
      type: 'ui:code',
      props: {
        title: K('result_title'),
        language: 'json',
        code: JSON.stringify(result, null, 2).slice(0, 20000),
      },
    });
  }
  pad.render(host.actionResult, components);
}

// -- actions ---------------------------------------------------------------

async function loadEntries(announce) {
  if (announce) callout(host.captureStatus, 'pw-capture-callout', 'info', K('loading'));
  try {
    const body = await post('/load', {}, false);
    entries = Array.isArray(body.entries) ? body.entries : [];
    renderEntries();
    const proposals = Array.isArray(body.calendar_proposals) ? body.calendar_proposals : [];
    if (proposals.length > 0) {
      const latest = proposals[0];
      model.cal_approval_id = latest.approval_request_id || '';
      setControl('cal_approval_id', model.cal_approval_id);
      callout(
        host.calendarStatus,
        'pw-cal-callout',
        'info',
        t('personal_workbench:cal_latest', {
          status: String(latest.status || ''),
          summary: String((latest.event && latest.event.summary) || ''),
          id: String(latest.approval_request_id || ''),
        })
      );
    }
    if (announce) callout(host.captureStatus, 'pw-capture-callout', 'success', K('loaded'));
  } catch (error) {
    callout(host.captureStatus, 'pw-capture-callout', 'danger', K('load_failed'), errorText(error));
  }
}

async function save() {
  let metadata = {};
  try {
    metadata = JSON.parse(model.meta || '{}');
  } catch {
    callout(host.captureStatus, 'pw-capture-callout', 'danger', K('metadata_invalid'));
    return;
  }
  callout(host.captureStatus, 'pw-capture-callout', 'info', K('saving'));
  try {
    await post('/capture', {
      kind: model.kind,
      title: model.title,
      body: model.body,
      metadata,
    });
    callout(host.captureStatus, 'pw-capture-callout', 'success', K('saved'));
    model.title = '';
    model.body = '';
    setControl('title', '');
    setControl('body', '');
    await loadEntries(false);
  } catch (error) {
    callout(host.captureStatus, 'pw-capture-callout', 'danger', K('save_failed'), errorText(error));
  }
}

async function proposeCalendar() {
  callout(host.calendarStatus, 'pw-cal-callout', 'info', K('cal_proposing'));
  try {
    const body = await post('/action', {
      action: 'calendar',
      payload: {
        stage: 'propose',
        summary: model.cal_summary,
        start: model.cal_start,
        end: model.cal_end,
        description: model.cal_desc,
      },
    });
    const result = body.result || {};
    model.cal_approval_id = result.approval_request_id || '';
    model.cal_confirm = false;
    setControl('cal_approval_id', model.cal_approval_id);
    setControl('cal_confirm', false);
    callout(
      host.calendarStatus,
      'pw-cal-callout',
      'success',
      t('personal_workbench:cal_proposed', { id: String(result.approval_request_id || '') })
    );
  } catch (error) {
    callout(
      host.calendarStatus,
      'pw-cal-callout',
      'danger',
      K('cal_propose_failed'),
      errorText(error)
    );
  }
}

async function applyCalendar() {
  const id = model.cal_approval_id.trim();
  if (!id) {
    callout(host.calendarStatus, 'pw-cal-callout', 'warning', K('cal_need_id'));
    return;
  }
  if (!model.cal_confirm) {
    callout(host.calendarStatus, 'pw-cal-callout', 'warning', K('cal_need_confirm'));
    return;
  }
  callout(host.calendarStatus, 'pw-cal-callout', 'info', K('cal_applying'));
  try {
    const body = await post('/action', {
      action: 'calendar',
      confirmed: true,
      payload: { stage: 'apply', approval_request_id: id },
    });
    model.cal_confirm = false;
    setControl('cal_confirm', false);
    callout(
      host.calendarStatus,
      'pw-cal-callout',
      'success',
      K('cal_applied'),
      JSON.stringify(body.result).slice(0, 2000)
    );
  } catch (error) {
    callout(
      host.calendarStatus,
      'pw-cal-callout',
      'danger',
      K('cal_apply_failed'),
      errorText(error)
    );
  }
}

async function runAction() {
  let payload = {};
  try {
    payload = JSON.parse(model.action_payload || '{}');
  } catch {
    renderActionResult('danger', K('payload_invalid'));
    return;
  }
  renderActionResult('info', K('running'));
  try {
    const body = await post('/action', { action: model.action, payload });
    renderActionResult('success', K('action_done'), body.result);
  } catch (error) {
    renderActionResult('danger', `${K('action_failed')}: ${errorText(error)}`);
  }
}

function handleAction(action) {
  const id = action && action.id;
  const payload = (action && action.payload) || {};
  switch (id) {
    case 'pw.save':
      void save();
      return;
    case 'pw.load':
      void loadEntries(true);
      return;
    case 'pw.cal.propose':
      void proposeCalendar();
      return;
    case 'pw.cal.apply':
      void applyCalendar();
      return;
    case 'pw.action.run':
      void runAction();
      return;
    case 'field.change':
      if (payload.name === 'cal_confirm') model.cal_confirm = payload.value === true;
      else if (payload.name in model && typeof payload.value === 'string')
        model[payload.name] = payload.value;
      return;
    default:
  }
}

renderCapture();
renderEntries();
renderCalendar();
callout(
  host.calendarStatus,
  'pw-cal-callout',
  'info',
  t('personal_workbench:cal_initial', { command: bootstrap.approveCommand })
);
renderActions();
