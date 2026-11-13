'use client';

import { opsApiPath } from '../../../lib/ops/ops-api-path';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  PageHeader,
  Section,
  Select,
  Skeleton,
  StatusPill,
  Switch,
  Table,
  Textarea,
  TextField,
} from '@agent/shared-ui';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import { ChronosFieldScope } from '../../../components/ops/chronos-ui';
import { useConciergeI18n } from '../../../lib/use-concierge-i18n';
import type { ConciergeMessageKey } from '../../../lib/i18n';
import { IA_AUTOMATION_TABS, resolveIaTab, type IaAutomationTab } from '../../../lib/ia-routes';
import { DestinationTabs } from '../../destination-tabs';
import {
  parsePipelinesResponse,
  parseRunDispatchResponse,
  parseSchedulesResponse,
  readApiError,
  type ClientPipeline,
  type ClientSchedule,
  type OpsAccessRole,
} from '../../../lib/ops/automation-response';

/**
 * `/ops/automation` — operator-facing automation management. Two tabs:
 * `schedules` (the governed pipeline-schedule registry: list / register /
 * edit / enable / delete / run-now) and `pipelines` (the ADF catalog with a
 * manual dispatch). Mutations are localadmin-only server-side; the same
 * accessRole comes back on the list GETs so the controls hide for viewers.
 */

type T = (key: ConciergeMessageKey, params?: Record<string, string | number>) => string;

function formatWhen(iso: string | undefined, locale: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(localeToBcp47(locale), { dateStyle: 'short', timeStyle: 'short' });
}

function triggerText(
  trigger: ClientSchedule['trigger'],
  every: (minutes: number) => string
): string {
  const tz = trigger.timezone ? ` (${trigger.timezone})` : '';
  return trigger.type === 'cron'
    ? `${trigger.cron}${tz}`
    : `${every(Math.round(trigger.intervalMs / 60_000))}${tz}`;
}

function lastStatusKind(status: ClientSchedule['lastStatus']): 'completed' | 'failed' | undefined {
  return status === 'succeeded' ? 'completed' : status === 'failed' ? 'failed' : undefined;
}

interface ScheduleFormState {
  mode: 'new' | 'edit';
  id: string;
  name: string;
  pipelinePath: string;
  triggerType: 'cron' | 'interval';
  cron: string;
  intervalMin: string | number;
  timezone: string;
  actuator: string;
  enabled: boolean;
}

const EMPTY_FORM: ScheduleFormState = {
  mode: 'new',
  id: '',
  name: '',
  pipelinePath: '',
  triggerType: 'interval',
  cron: '0 9 * * *',
  intervalMin: 60,
  timezone: '',
  actuator: 'system',
  enabled: true,
};

function formFromSchedule(schedule: ClientSchedule): ScheduleFormState {
  const trigger = schedule.trigger;
  return {
    mode: 'edit',
    id: schedule.id,
    name: schedule.name,
    pipelinePath: schedule.pipelinePath,
    triggerType: trigger.type,
    cron: trigger.type === 'cron' ? trigger.cron : '0 9 * * *',
    intervalMin: trigger.type === 'interval' ? Math.round(trigger.intervalMs / 60_000) : 60,
    timezone: trigger.timezone ?? '',
    actuator: schedule.actuator,
    enabled: schedule.enabled,
  };
}

function SchedulesPanel({ t, locale }: { t: T; locale: string }) {
  const [schedules, setSchedules] = React.useState<ClientSchedule[] | null>(null);
  const [pipelines, setPipelines] = React.useState<ClientPipeline[]>([]);
  const [accessRole, setAccessRole] = React.useState<OpsAccessRole>('readonly');
  const [loading, setLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ resourceId: string; pipelinePath: string } | null>(
    null
  );
  const [mutationError, setMutationError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<ScheduleFormState | null>(null);
  const [formBusy, setFormBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const localAdmin = accessRole === 'localadmin';

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    const load = async (path: string) => {
      const res = await fetch(opsApiPath(path), { cache: 'no-store' });
      return res.ok ? res.json() : null;
    };
    Promise.all([load('/schedules'), load('/pipelines')])
      .then(([schedulesBody, pipelinesBody]) => {
        if (!live) return;
        const parsed = parseSchedulesResponse(schedulesBody);
        if (!parsed) {
          setLoadFailed(true);
          setLoading(false);
          return;
        }
        setSchedules(parsed.schedules);
        setAccessRole(parsed.accessRole);
        setPipelines(parsePipelinesResponse(pipelinesBody)?.pipelines ?? []);
        setLoadFailed(false);
        setLoading(false);
      })
      .catch(() => {
        if (live) {
          setLoadFailed(true);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [revision]);

  const refresh = () => setRevision((value) => value + 1);

  const mutation = async (
    path: string,
    init: RequestInit,
    id: string
  ): Promise<{ resourceId: string; pipelinePath: string } | false | null> => {
    setBusyId(id);
    setMutationError(null);
    setNotice(null);
    try {
      const res = await fetch(opsApiPath(path), init);
      const body = await res.json().catch(() => null);
      if (!res.ok || (body && body.ok === false)) {
        throw new Error(readApiError(body) ?? `HTTP ${res.status}`);
      }
      // Run dispatches carry {ok:true, run:{…}}; plain mutations return run: null.
      const run = parseRunDispatchResponse(body);
      return run ?? null;
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = (id: string) => {
    const schedule = schedules?.find((entry) => entry.id === id);
    if (!schedule) return;
    void mutation(
      `/schedules/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !schedule.enabled }),
      },
      id
    ).then(() => {
      // Always refetch — on failure the switch echoes the server value back.
      refresh();
    });
  };

  const runNow = (id: string) => {
    void mutation(`/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' }, id).then(
      (result) => {
        if (result) setNotice(result);
      }
    );
  };

  const removeSchedule = (id: string) => {
    if (!window.confirm(t('automation_schedule_delete_confirm', { id }))) return;
    void mutation(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }, id).then(
      (result) => {
        if (result !== false) refresh();
      }
    );
  };

  const fieldChange = (name: string, value: unknown) => {
    if (name.startsWith('toggle.')) {
      toggleEnabled(name.slice('toggle.'.length));
      return;
    }
    if (!name.startsWith('form.')) return;
    const key = name.slice('form.'.length);
    setForm((current) => {
      if (!current) return current;
      if (key === 'triggerType') {
        return { ...current, triggerType: value === 'cron' ? 'cron' : 'interval' };
      }
      if (key === 'enabled') return { ...current, enabled: value === true };
      return { ...current, [key]: value };
    });
  };

  const submitForm = async () => {
    if (!form) return;
    setFormBusy(true);
    setFormError(null);
    const timezone = form.timezone.trim();
    const trigger =
      form.triggerType === 'cron'
        ? { type: 'cron', cron: form.cron, ...(timezone ? { timezone } : {}) }
        : {
            type: 'interval',
            intervalMs: Number(form.intervalMin) * 60_000,
            ...(timezone ? { timezone } : {}),
          };
    const body = {
      id: form.id,
      name: form.name,
      pipelinePath: form.pipelinePath,
      actuator: form.actuator,
      trigger,
      enabled: form.enabled,
    };
    try {
      const res = await fetch(
        form.mode === 'edit'
          ? opsApiPath(`/schedules/${encodeURIComponent(form.id)}`)
          : opsApiPath('/schedules'),
        {
          method: form.mode === 'edit' ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const payload = await res.json().catch(() => null);
      if (!res.ok || (payload && payload.ok === false)) {
        throw new Error(readApiError(payload) ?? `HTTP ${res.status}`);
      }
      setForm(null);
      refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setFormBusy(false);
    }
  };

  const pipelineOptions = React.useMemo(() => {
    const runnable = pipelines
      .filter((pipeline) => !pipeline.notPipeline && !pipeline.parseError)
      .map((pipeline) => ({ value: pipeline.path, label: `${pipeline.name} — ${pipeline.path}` }));
    // Keep the current selection selectable even when its file left the
    // catalog (e.g. an edit form opened against a since-deleted pipeline).
    if (form?.pipelinePath && !runnable.some((option) => option.value === form.pipelinePath)) {
      runnable.push({ value: form.pipelinePath, label: form.pipelinePath });
    }
    return runnable;
  }, [pipelines, form?.pipelinePath]);

  return (
    <ChronosFieldScope onChange={fieldChange}>
      {loadFailed ? <Callout tone="danger" title={t('automation_load_error')} /> : null}
      {mutationError ? (
        <Callout tone="danger" title={t('automation_mutation_failed')} body={mutationError} />
      ) : null}
      {notice ? (
        <Callout
          tone="success"
          title={t('automation_pipeline_dispatched', { resourceId: notice.resourceId })}
          body={t('automation_pipeline_dispatched_note')}
        />
      ) : null}
      <Section
        title={t('ia_shell_automation_tab_schedules')}
        actions={
          localAdmin && !form
            ? [
                {
                  label: t('automation_schedule_register'),
                  variant: 'primary',
                  onClick: () => {
                    setFormError(null);
                    setForm({ ...EMPTY_FORM });
                  },
                },
              ]
            : []
        }
      >
        {loading ? (
          <Skeleton shape="table" />
        ) : !schedules?.length ? (
          <EmptyState title={t('automation_schedule_empty')} />
        ) : (
          <Table
            columns={[
              { key: 'schedule', label: t('automation_schedule_col_schedule') },
              {
                key: 'pipeline',
                label: t('automation_schedule_col_pipeline'),
                mono: true,
              },
              { key: 'trigger', label: t('automation_schedule_col_trigger') },
              {
                key: 'enabled',
                label: t('automation_schedule_col_enabled'),
                width: '6rem',
              },
              { key: 'lastRun', label: t('automation_schedule_col_last_run') },
              { key: 'actions', label: t('automation_schedule_col_actions') },
            ]}
            rows={schedules.map((schedule) => ({
              schedule: (
                <span className="kb-table__cell">
                  <span className="kb-table__title">{schedule.name}</span>
                  <span className="kb-table__id">{schedule.id}</span>
                  {schedule.dueNow ? (
                    <Badge label={t('automation_schedule_due')} tone="accent" />
                  ) : null}
                  {schedule.operatorExcluded ? (
                    <Badge label={t('automation_schedule_excluded')} tone="warning" />
                  ) : null}
                  {schedule.disabledReason ? (
                    <span className="kb-table__id">{schedule.disabledReason}</span>
                  ) : null}
                </span>
              ),
              pipeline: schedule.pipelinePath,
              trigger: triggerText(schedule.trigger, (minutes) =>
                t('automation_schedule_every_minutes', { minutes })
              ),
              enabled: localAdmin ? (
                <Switch
                  name={`toggle.${schedule.id}`}
                  label={schedule.name}
                  hide_label
                  value={schedule.enabled}
                  disabled={busyId === schedule.id}
                />
              ) : (
                <Badge
                  label={t(
                    schedule.enabled
                      ? 'automation_schedule_enabled'
                      : 'automation_schedule_disabled'
                  )}
                  tone={schedule.enabled ? 'success' : 'neutral'}
                />
              ),
              lastRun: (
                <span className="kb-table__cell">
                  <span className="kb-table__title">
                    {schedule.lastRun
                      ? formatWhen(schedule.lastRun, locale)
                      : t('automation_schedule_never_run')}
                  </span>
                  {lastStatusKind(schedule.lastStatus) ? (
                    <StatusPill status={lastStatusKind(schedule.lastStatus)!} />
                  ) : null}
                </span>
              ),
              actions: localAdmin ? (
                <span className="kb-section__actions">
                  <Button
                    label={t('automation_schedule_run_now')}
                    disabled={busyId === schedule.id}
                    onClick={() => runNow(schedule.id)}
                  />
                  <Button
                    label={t('automation_schedule_edit')}
                    disabled={busyId === schedule.id}
                    onClick={() => {
                      setFormError(null);
                      setForm(formFromSchedule(schedule));
                    }}
                  />
                  <Button
                    label={t('automation_schedule_delete')}
                    variant="danger"
                    disabled={busyId === schedule.id}
                    onClick={() => removeSchedule(schedule.id)}
                  />
                </span>
              ) : null,
            }))}
            empty={t('automation_schedule_empty')}
          />
        )}
      </Section>
      {form ? (
        <Section
          title={t(
            form.mode === 'edit' ? 'automation_schedule_edit_title' : 'automation_schedule_register'
          )}
        >
          {formError ? (
            <Callout tone="danger" title={t('automation_mutation_failed')} body={formError} />
          ) : null}
          <TextField
            id="schedule-form-id"
            name="form.id"
            label={t('automation_schedule_field_id')}
            value={form.id}
            disabled={form.mode === 'edit' || formBusy}
            required
          />
          <TextField
            id="schedule-form-name"
            name="form.name"
            label={t('automation_schedule_field_name')}
            value={form.name}
            disabled={formBusy}
            required
          />
          <Select
            id="schedule-form-pipeline"
            name="form.pipelinePath"
            label={t('automation_schedule_field_pipeline')}
            value={form.pipelinePath}
            options={pipelineOptions}
            placeholder={t('automation_pipeline_choose')}
            disabled={formBusy}
            required
          />
          <Select
            id="schedule-form-trigger"
            name="form.triggerType"
            label={t('automation_schedule_field_trigger_type')}
            value={form.triggerType}
            options={[
              { value: 'cron', label: t('automation_schedule_trigger_cron') },
              { value: 'interval', label: t('automation_schedule_trigger_interval') },
            ]}
            disabled={formBusy}
          />
          {form.triggerType === 'cron' ? (
            <TextField
              id="schedule-form-cron"
              name="form.cron"
              label={t('automation_schedule_field_cron')}
              value={form.cron}
              placeholder="0 9 * * 1-5"
              disabled={formBusy}
              required
            />
          ) : (
            <TextField
              id="schedule-form-interval"
              name="form.intervalMin"
              type="number"
              label={t('automation_schedule_field_interval')}
              value={form.intervalMin}
              min={1}
              disabled={formBusy}
              required
            />
          )}
          <TextField
            id="schedule-form-timezone"
            name="form.timezone"
            label={t('automation_schedule_field_timezone')}
            value={form.timezone}
            placeholder="Asia/Tokyo"
            disabled={formBusy}
          />
          <TextField
            id="schedule-form-actuator"
            name="form.actuator"
            label={t('automation_schedule_field_actuator')}
            value={form.actuator}
            disabled={formBusy}
          />
          <Switch
            id="schedule-form-enabled"
            name="form.enabled"
            label={t('automation_schedule_field_enabled')}
            value={form.enabled}
            disabled={formBusy}
          />
          <div className="kb-section__actions">
            <Button
              label={t('automation_schedule_save')}
              variant="primary"
              disabled={formBusy}
              onClick={() => void submitForm()}
            />
            <Button
              label={t('automation_schedule_cancel')}
              disabled={formBusy}
              onClick={() => setForm(null)}
            />
          </div>
        </Section>
      ) : null}
    </ChronosFieldScope>
  );
}

function PipelinesPanel({ t }: { t: T }) {
  const [pipelines, setPipelines] = React.useState<ClientPipeline[]>([]);
  const [accessRole, setAccessRole] = React.useState<OpsAccessRole>('readonly');
  const [loading, setLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [selected, setSelected] = React.useState('');
  const [contextText, setContextText] = React.useState('');
  const [contextInvalid, setContextInvalid] = React.useState(false);
  const [runBusy, setRunBusy] = React.useState(false);
  const [canRun, setCanRun] = React.useState(false);
  const [notice, setNotice] = React.useState<{ resourceId: string; pipelinePath: string } | null>(
    null
  );
  const [mutationError, setMutationError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    fetch(opsApiPath('/pipelines'), { cache: 'no-store' })
      .then(async (res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live) return;
        const parsed = parsePipelinesResponse(body);
        if (!parsed) {
          setLoadFailed(true);
          setLoading(false);
          return;
        }
        setPipelines(parsed.pipelines);
        setAccessRole(parsed.accessRole);
        setCanRun(parsed.canRun);
        setLoading(false);
      })
      .catch(() => {
        if (live) {
          setLoadFailed(true);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  // The run controls show only when the server says it would accept the run.
  const localAdmin = accessRole === 'localadmin' && canRun;
  const runnable = React.useMemo(
    () => pipelines.filter((pipeline) => !pipeline.notPipeline && !pipeline.parseError),
    [pipelines]
  );
  const selectedPipeline = runnable.find((pipeline) => pipeline.path === selected);

  const fieldChange = (name: string, value: unknown) => {
    if (name === 'pipeline.pick') {
      setSelected(typeof value === 'string' ? value : '');
      return;
    }
    if (name === 'pipeline.context') {
      setContextText(typeof value === 'string' ? value : '');
      setContextInvalid(false);
    }
  };

  const run = async () => {
    if (!selectedPipeline || runBusy) return;
    // The context is parsed before anything leaves the page: invalid JSON is
    // flagged inline and the request is never sent.
    let context: Record<string, unknown> | undefined;
    const raw = contextText.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        context = parsed as Record<string, unknown>;
      } catch {
        setContextInvalid(true);
        return;
      }
    }
    setRunBusy(true);
    setMutationError(null);
    setNotice(null);
    try {
      const res = await fetch(opsApiPath('/pipelines/run'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pipelinePath: selectedPipeline.path,
          ...(context ? { context } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      const dispatch = parseRunDispatchResponse(body);
      if (!res.ok || !dispatch) {
        throw new Error(readApiError(body) ?? `HTTP ${res.status}`);
      }
      setNotice(dispatch);
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunBusy(false);
    }
  };

  return (
    <ChronosFieldScope onChange={fieldChange}>
      {loadFailed ? <Callout tone="danger" title={t('automation_load_error')} /> : null}
      {mutationError ? (
        <Callout tone="danger" title={t('automation_mutation_failed')} body={mutationError} />
      ) : null}
      {notice ? (
        <Callout
          tone="success"
          title={t('automation_pipeline_dispatched', { resourceId: notice.resourceId })}
          body={t('automation_pipeline_dispatched_note')}
        />
      ) : null}
      <Section title={t('ia_shell_automation_tab_pipelines')}>
        {loading ? (
          <Skeleton shape="table" />
        ) : !pipelines.length ? (
          <EmptyState title={t('automation_pipeline_empty')} />
        ) : (
          <Table
            columns={[
              { key: 'pipeline', label: t('automation_pipeline_col_pipeline') },
              {
                key: 'steps',
                label: t('automation_pipeline_col_steps'),
                align: 'end',
                width: '6rem',
              },
              { key: 'state', label: t('automation_pipeline_col_state') },
            ]}
            rows={pipelines.map((pipeline) => ({
              pipeline: (
                <span className="kb-table__cell">
                  {localAdmin ? (
                    <button
                      type="button"
                      className="chronos-mission-cell__title"
                      aria-pressed={pipeline.path === selected}
                      onClick={() => setSelected(pipeline.path)}
                    >
                      {pipeline.name}
                    </button>
                  ) : (
                    <span className="kb-table__title">{pipeline.name}</span>
                  )}
                  <span className="kb-table__id">{pipeline.path}</span>
                  {pipeline.description ? (
                    <span className="kb-table__id">{pipeline.description}</span>
                  ) : null}
                </span>
              ),
              steps: pipeline.stepCount,
              state: (
                <span className="kb-table__cell">
                  {pipeline.version ? <Badge label={pipeline.version} tone="neutral" /> : null}
                  {pipeline.hasSchedule ? (
                    <Badge label={t('automation_pipeline_has_schedule')} tone="accent" />
                  ) : null}
                  {pipeline.notPipeline ? (
                    <Badge label={t('automation_pipeline_not_adf')} tone="warning" />
                  ) : null}
                  {pipeline.parseError ? (
                    <Badge label={t('automation_pipeline_broken')} tone="danger" />
                  ) : null}
                </span>
              ),
            }))}
            empty={t('automation_pipeline_empty')}
          />
        )}
      </Section>
      {localAdmin ? (
        <Section title={t('automation_pipeline_run')}>
          <Select
            id="pipeline-run-pick"
            name="pipeline.pick"
            label={t('automation_schedule_field_pipeline')}
            value={selected}
            options={runnable.map((pipeline) => ({
              value: pipeline.path,
              label: `${pipeline.name} — ${pipeline.path}`,
            }))}
            placeholder={t('automation_pipeline_choose')}
            disabled={runBusy}
          />
          {selectedPipeline ? (
            <p className="chronos-meta">
              {selectedPipeline.description || selectedPipeline.path}
              {selectedPipeline.ops.length ? ` · ${selectedPipeline.ops.join(', ')}` : ''}
            </p>
          ) : null}
          <Textarea
            id="pipeline-run-context"
            name="pipeline.context"
            label={t('automation_pipeline_context')}
            value={contextText}
            rows={4}
            placeholder='{"key": "value"}'
            disabled={runBusy}
            error={contextInvalid ? t('automation_pipeline_context_invalid') : undefined}
          />
          <div className="kb-section__actions">
            <Button
              label={t('automation_pipeline_run')}
              variant="primary"
              disabled={!selectedPipeline || runBusy}
              onClick={() => void run()}
            />
          </div>
        </Section>
      ) : null}
    </ChronosFieldScope>
  );
}

export function AutomationClient() {
  const { t, locale } = useConciergeI18n();
  const searchParams = useSearchParams();
  const tab = resolveIaTab<IaAutomationTab>(IA_AUTOMATION_TABS, searchParams?.get('tab') ?? null);
  return (
    <div className="kb-page" data-width="wide">
      <PageHeader
        title={t('ia_shell_automation_title')}
        subtitle={t('ia_shell_automation_subtitle')}
      />
      <DestinationTabs
        label={t('ia_shell_tabs_label')}
        active={tab}
        tabs={[
          { id: 'schedules', label: t('ia_shell_automation_tab_schedules') },
          { id: 'pipelines', label: t('ia_shell_automation_tab_pipelines') },
        ]}
      />
      {tab === 'pipelines' ? <PipelinesPanel t={t} /> : <SchedulesPanel t={t} locale={locale} />}
    </div>
  );
}
