'use client';

import * as React from 'react';
import {
  Button,
  Callout,
  KeyValue,
  List,
  Section,
  Select,
  TextField,
  Textarea,
} from '@agent/shared-ui';
import { ChronosFieldScope } from '../ops/chronos-ui';
import { uxMessage, uxText } from '../../lib/ops/ux-vocabulary';
import {
  PlanFlowError,
  approvePlanAndStart,
  requestPlanPreview,
  type PlanTier,
} from '../../lib/ops/mission-planning';
import type { ClientPlanPreview } from '../../lib/ops/plan-preview-response';
import { buildPlanPreviewSignature, isPlanPreviewStale } from '../../app/ops/chronos-page-config';
import './mission-plan.css';

type Translate = (key: string, params?: Record<string, string | number>) => string;
type UxLocale = Parameters<typeof uxText>[1];

/** Plan-flow failure → the sentence shown to the operator (never a raw code). */
export function planErrorKey(error: unknown): string {
  if (!(error instanceof PlanFlowError)) return 'ia_shell_plan_failed';
  switch (error.code) {
    case 'request_required':
      return 'ia_shell_plan_request_required';
    case 'preview_required':
      return 'ia_shell_plan_preview_required';
    case 'preview_stale':
      return 'ia_shell_plan_preview_stale';
    case 'proposal_failed':
    case 'proposal_invalid':
    case 'approval_failed':
    case 'approval_invalid':
      return 'ia_shell_plan_start_failed';
    default:
      return 'ia_shell_plan_failed';
  }
}

/**
 * ミッションを計画 on `/work`: write the request, check the plan, approve to
 * start. The approve button stays disabled until a preview exists and matches
 * the current inputs (stale-preview guard), as in the former console section.
 */
export function MissionPlanPanel({
  t,
  locale,
  onStarted,
}: {
  t: Translate;
  locale: string;
  onStarted?: (missionId: string) => void;
}) {
  const ux = locale as UxLocale;
  const [requestText, setRequestText] = React.useState('');
  const [missionType, setMissionType] = React.useState('proposal-brief');
  const [persona, setPersona] = React.useState('operator');
  const [tier, setTier] = React.useState<PlanTier>('confidential');
  const [preview, setPreview] = React.useState<ClientPlanPreview | null>(null);
  const [previewSignature, setPreviewSignature] = React.useState<string | null>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = React.useState(false);
  const [startBusy, setStartBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [started, setStarted] = React.useState<string | null>(null);

  const draft = { requestText, missionType, orgRole: persona, tier };
  const signature = buildPlanPreviewSignature(draft);
  const stale = isPlanPreviewStale(previewSignature, signature);

  const runPreview = async () => {
    setPreviewBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await requestPlanPreview(draft, locale);
      setPreview(next);
      setPreviewSignature(signature);
      setSessionId(next.missionId);
      setStarted(null);
    } catch (caught) {
      setPreview(null);
      setPreviewSignature(null);
      setSessionId(null);
      setError(t(planErrorKey(caught)));
    } finally {
      setPreviewBusy(false);
    }
  };

  const start = async () => {
    setStartBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await approvePlanAndStart({ preview, stale, sessionId, requestText, locale });
      setStarted(result.missionId);
      onStarted?.(result.missionId);
    } catch (caught) {
      setError(t(planErrorKey(caught)));
    } finally {
      setStartBusy(false);
    }
  };

  return (
    <Section
      title={uxText('chronos_mission_plan_title', ux)}
      description={uxText('chronos_plan_description', ux)}
      actions={[
        {
          label: previewBusy ? uxText('chronos_previewing', ux) : uxText('chronos_preview', ux),
          disabled: previewBusy,
          onClick: () => void runPreview(),
        },
        {
          label: startBusy ? uxText('chronos_starting', ux) : uxText('chronos_approve_start', ux),
          variant: 'primary',
          disabled: startBusy || !preview || stale,
          onClick: () => void start(),
        },
      ]}
    >
      {preview && stale ? (
        <Callout tone="warning" title={uxText('chronos_preview_stale', ux)} />
      ) : null}
      <ChronosFieldScope
        onChange={(name, value) => {
          const text = typeof value === 'string' ? value : '';
          if (name === 'plan_request') setRequestText(text);
          else if (name === 'plan_mission_type') setMissionType(text);
          else if (name === 'plan_persona') setPersona(text);
          else if (
            name === 'plan_tier' &&
            (text === 'personal' || text === 'confidential' || text === 'public')
          )
            setTier(text);
        }}
      >
        <Textarea
          name="plan_request"
          label={uxText('chronos_plan_request_label', ux)}
          placeholder={uxText('chronos_plan_request_placeholder', ux)}
          rows={4}
          value={requestText}
        />
        <div className="mission-plan__row">
          <TextField
            name="plan_mission_type"
            label={uxText('chronos_mission_type_field', ux)}
            value={missionType}
          />
          <TextField
            name="plan_persona"
            label={uxText('chronos_persona_field', ux)}
            value={persona}
          />
          <Select
            name="plan_tier"
            label={uxText('chronos_data_level_field', ux)}
            value={tier}
            options={[
              { value: 'personal', label: uxText('chronos_tier_personal', ux) },
              { value: 'confidential', label: uxText('chronos_tier_confidential', ux) },
              { value: 'public', label: uxText('chronos_tier_public', ux) },
            ]}
          />
        </div>
      </ChronosFieldScope>
      {error ? <Callout tone="danger" title={error} /> : null}
      {notice ? <Callout tone="info" title={notice} /> : null}
      {started ? (
        <Callout
          tone="success"
          title={t('ia_shell_plan_started')}
          action={{
            label: t('ia_shell_plan_open_mission'),
            href: `/w/mission/${encodeURIComponent(started)}`,
          }}
        />
      ) : null}
      {preview ? (
        <>
          <Section
            headingLevel={3}
            title={preview.goal?.summary || uxText('chronos_mission_goal', ux)}
            description={preview.goal?.successCondition}
          >
            <KeyValue
              items={[
                {
                  label: uxText('chronos_plan_clarification', ux),
                  value: preview.delivery?.clarificationNeeded
                    ? uxText('chronos_plan_clarification_needed', ux)
                    : uxText('chronos_plan_clarification_clear', ux),
                },
                {
                  label: uxText('chronos_plan_confidence', ux),
                  value: `${Math.round((Number(preview.confidence) || 0) * 100)}%`,
                },
              ]}
            />
            {preview.execution?.clarificationQuestions?.length ? (
              <div className="mission-plan__questions">
                <p className="kb-text kb-text--muted">
                  {uxText('chronos_plan_clarification_reason', ux)}
                </p>
                {preview.execution.clarificationQuestions.map((question) => (
                  <Button
                    key={question.id}
                    label={question.question}
                    variant="secondary"
                    onClick={() => {
                      setRequestText(
                        (current) =>
                          `${current.trimEnd()}\n\n${uxText('chronos_plan_clarification_answer_prefix', ux)}${question.question}\n→ `
                      );
                      setNotice(uxText('chronos_plan_clarification_appended', ux));
                    }}
                  />
                ))}
              </div>
            ) : null}
          </Section>
          <Section
            headingLevel={3}
            title={uxText('chronos_plan_team_title', ux)}
            description={uxMessage(
              'chronos_plan_team_counts',
              {
                assignments: preview.team?.assignments?.length || 0,
                roles: preview.team?.team_governance?.composition?.required_roles?.length || 0,
              },
              '{assignments} assignments · {roles} required roles',
              ux
            )}
          >
            <List
              variant="timeline"
              items={(preview.workflow || []).slice(0, 5).map((step) => ({
                title: step.label,
                meta: step.description,
              }))}
            />
          </Section>
        </>
      ) : null}
    </Section>
  );
}
