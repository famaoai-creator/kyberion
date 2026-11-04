'use client';

import * as React from 'react';
import { Button, SettingsGroup, Skeleton, StatusPill } from '@agent/shared-ui';
import type { SetupChecklistStepId } from '@agent/core/surface/setup-checklist-model';
import { frontDeskText, type ConciergeLocale, type FrontDeskMessageKey } from '../../../lib/i18n';
import type { SetupChecklistState } from '../../../lib/setup-checklist-client';
import {
  SETTINGS_CATEGORIES,
  SETTINGS_SECTION_ELEMENT_ID,
  orderSectionsForFirstRun,
  type SettingsReadinessItem,
} from '../../../lib/settings-view';

const STEP_TEXT: Record<SetupChecklistStepId, [FrontDeskMessageKey, FrontDeskMessageKey]> = {
  identity: ['ia_settings_step_identity', 'ia_settings_step_identity_why'],
  reasoning: ['ia_settings_step_reasoning', 'ia_settings_step_reasoning_why'],
  autonomy: ['ia_settings_step_autonomy', 'ia_settings_step_autonomy_why'],
  notifications: ['ia_settings_step_notifications', 'ia_settings_step_notifications_why'],
  first_project: ['ia_settings_step_first_project', 'ia_settings_step_first_project_why'],
  budget: ['ia_settings_step_budget', 'ia_settings_step_budget_why'],
  trial_mission: ['ia_settings_step_trial_mission', 'ia_settings_step_trial_mission_why'],
};

/**
 * はじめに › 初期設定チェックリスト (`#settings-checklist`): the seven steps
 * in the required order, each with why, an estimate and its auto-detected
 * state, plus the category to open next. Read-only; every step links to the
 * card that completes it.
 */
export function SetupChecklistCard({
  locale,
  state,
  diagnostics,
  onNavigate,
  children,
}: {
  locale: ConciergeLocale;
  state: SetupChecklistState;
  /** The other `/api/setup` readiness items (avatar, voice, …). */
  diagnostics: readonly SettingsReadinessItem[];
  onNavigate: (hash: string) => void;
  /** "Nice to have" readiness, rendered below the steps. */
  children?: React.ReactNode;
}) {
  const text = (key: FrontDeskMessageKey, params?: Record<string, string | number>) =>
    frontDeskText(key, locale, params);
  const checklist = state.phase === 'ready' ? state.checklist : null;
  const readiness: SettingsReadinessItem[] = [
    ...(checklist?.steps ?? []).map((step) => ({
      id: step.id,
      status: step.status === 'done' ? ('ok' as const) : ('incomplete' as const),
    })),
    ...diagnostics,
  ];
  const nextCategory = orderSectionsForFirstRun(readiness).find((id) => id !== 'start');
  const pending = readiness.some((item) => item.status !== 'ok');
  return (
    <div className="settings-subsection" id="settings-checklist">
      <SettingsGroup
        id="settings-checklist-group"
        title={text('ia_settings_checklist_title')}
        description={text('ia_settings_checklist_lead')}
      >
        {state.phase === 'loading' ? (
          <div className="settings-row-block">
            <Skeleton shape="text" lines={3} label={text('ia_settings_checklist_loading')} />
          </div>
        ) : state.phase === 'unavailable' ? (
          <div className="settings-row-block">
            <p className="kb-text kb-text--muted" role="status">
              {text('ia_settings_checklist_unavailable')}
            </p>
          </div>
        ) : checklist ? (
          <>
            <div className="settings-row-block settings-checklist__progress">
              <p className="kb-text kb-text--body">
                {checklist.complete
                  ? text('ia_settings_checklist_complete')
                  : text('ia_settings_checklist_progress', {
                      done: checklist.done,
                      total: checklist.total,
                    })}
              </p>
              <div
                className="settings-checklist__bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={checklist.total}
                aria-valuenow={checklist.done}
                aria-label={text('ia_settings_checklist_title')}
              >
                <span
                  className="settings-checklist__bar-fill"
                  style={{ width: `${(checklist.done / Math.max(1, checklist.total)) * 100}%` }}
                />
              </div>
            </div>
            <ol className="settings-checklist__steps">
              {checklist.steps.map((step, index) => {
                const [label, why] = STEP_TEXT[step.id];
                const isNext = checklist.next === step.id;
                return (
                  <li
                    key={step.id}
                    className="settings-checklist__step"
                    data-status={step.status}
                    data-next={isNext ? 'true' : undefined}
                  >
                    <span className="settings-checklist__index" aria-hidden>
                      {index + 1}
                    </span>
                    <div className="settings-checklist__text">
                      <p className="kb-text kb-text--body">
                        {text(label)}
                        {isNext ? (
                          <span className="settings-checklist__next">
                            {' '}
                            · {text('ia_settings_checklist_next')}
                          </span>
                        ) : null}
                      </p>
                      <p className="kb-text kb-text--muted">{text(why)}</p>
                      <p className="kb-text kb-text--caption">
                        {text('ia_settings_checklist_minutes', { minutes: step.estimate_minutes })}
                      </p>
                    </div>
                    <div className="settings-inline-actions">
                      <StatusPill
                        status={
                          step.status === 'done'
                            ? 'completed'
                            : step.status === 'todo'
                              ? 'needs_setup'
                              : 'unavailable'
                        }
                        label={text(
                          step.status === 'done'
                            ? 'ia_settings_checklist_status_done'
                            : step.status === 'todo'
                              ? 'ia_settings_checklist_status_todo'
                              : 'ia_settings_checklist_status_unknown'
                        )}
                      />
                      <Button
                        label={text(
                          step.status === 'done'
                            ? 'ia_settings_checklist_review'
                            : 'ia_settings_checklist_open'
                        )}
                        variant={isNext ? 'primary' : 'secondary'}
                        href={'#' + step.anchor}
                        onClick={(event) => {
                          event.preventDefault();
                          onNavigate('#' + step.anchor);
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        ) : null}
        {pending && nextCategory ? (
          <div className="settings-row-actions settings-row-actions--start">
            <Button
              label={text('ia_settings_next_category', {
                category: text(SETTINGS_CATEGORIES[nextCategory].label),
              })}
              variant="ghost"
              onClick={() => onNavigate('#' + SETTINGS_SECTION_ELEMENT_ID[nextCategory])}
            />
          </div>
        ) : null}
      </SettingsGroup>
      {children}
    </div>
  );
}
