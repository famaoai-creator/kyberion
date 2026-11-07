'use client';

import * as React from 'react';
import { Button, SettingRow, SettingsGroup, StatusPill } from '@agent/shared-ui';
import type { SetupBudgetSummary } from '@agent/core/surface/setup-checklist-model';
import { frontDeskText, type ConciergeLocale, type FrontDeskMessageKey } from '../../../lib/i18n';
import type { SetupChecklistState } from '../../../lib/setup-checklist-client';
import { IdentityLinkSection } from '../../setup/identity-link-section';
import { SsoSettingsForm } from '../../setup/sso-settings-form';
import { CliSettingRow, SettingMeta, SettingsCommand } from './settings-ia-parts';
import { EngineConfigPanel } from './EngineConfigPanel';

/**
 * Settings IA cards that are new with MSN-SHELL-IA-20261105: the trial job,
 * company setup and projects entries, SSO, Studio engines, budget, and the
 * terminal-only settings (AUDIT §4-5); the engine card edits in place. Render-only; the page owns data.
 */

type Text = (key: FrontDeskMessageKey, params?: Record<string, string | number>) => string;
const textFor =
  (locale: ConciergeLocale): Text =>
  (key, params) =>
    frontDeskText(key, locale, params);

function Card({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-subsection" id={id}>
      <SettingsGroup id={`${id}-group`} title={title} description={description}>
        {children}
      </SettingsGroup>
    </div>
  );
}

export function TrialMissionCard({ locale }: { locale: ConciergeLocale }) {
  const text = textFor(locale);
  return (
    <Card
      id="settings-trial-mission"
      title={text('ia_settings_card_trial')}
      description={text('ia_settings_card_trial_desc')}
    >
      <div className="settings-row-actions settings-row-actions--start">
        <Button
          label={text('ia_settings_card_trial_action')}
          variant="primary"
          onClick={() => window.dispatchEvent(new CustomEvent('concierge:open-dock'))}
        />
        <Button label={text('ia_settings_card_trial_work')} variant="ghost" href="/work" />
      </div>
    </Card>
  );
}

export function CompanySetupCard({ locale, href }: { locale: ConciergeLocale; href: string }) {
  const text = textFor(locale);
  return (
    <Card
      id="settings-company"
      title={text('ia_settings_card_company')}
      description={text('ia_settings_card_company_desc')}
    >
      <div className="settings-row-block">
        <SettingMeta locale={locale} effect={text('ia_settings_card_company_effect')} />
      </div>
      <div className="settings-row-actions settings-row-actions--start">
        <Button label={text('ia_settings_card_company_action')} variant="secondary" href={href} />
      </div>
    </Card>
  );
}

export function ProjectsCard({
  locale,
  href,
  state,
}: {
  locale: ConciergeLocale;
  href: string;
  state: SetupChecklistState;
}) {
  const text = textFor(locale);
  const step =
    state.phase === 'ready'
      ? state.checklist.steps.find((entry) => entry.id === 'first_project')
      : undefined;
  return (
    <Card
      id="settings-projects"
      title={text('ia_settings_card_projects')}
      description={text('ia_settings_card_projects_desc')}
    >
      <div className="settings-row-block">
        <SettingMeta
          locale={locale}
          current={
            step
              ? text(
                  step.status === 'done'
                    ? 'ia_settings_checklist_status_done'
                    : step.status === 'todo'
                      ? 'ia_settings_checklist_status_todo'
                      : 'ia_settings_checklist_status_unknown'
                )
              : undefined
          }
          defaultValue={text('ia_settings_card_projects_default')}
          effect={text('ia_settings_step_first_project_why')}
        />
      </div>
      <div className="settings-row-actions settings-row-actions--start">
        <Button label={text('ia_settings_card_projects_action')} variant="secondary" href={href} />
      </div>
    </Card>
  );
}

export function TenantCliCard({ locale }: { locale: ConciergeLocale }) {
  const text = textFor(locale);
  return (
    <Card
      id="settings-tenant-cli"
      title={text('ia_settings_card_tenant_cli')}
      description={text('ia_settings_card_tenant_cli_desc')}
    >
      <div className="settings-row-block">
        <p className="kb-text kb-text--muted">{text('ia_settings_cli_lead')}</p>
        <SettingsCommand
          locale={locale}
          command={'pnpm tenant create <slug>\npnpm onboarding:context bind'}
        />
      </div>
    </Card>
  );
}

export function EngineConfigCard({ locale }: { locale: ConciergeLocale }) {
  const text = textFor(locale);
  return (
    <Card
      id="settings-engine"
      title={text('ia_settings_card_engine')}
      description={text('ia_settings_card_engine_desc')}
    >
      <div className="settings-row-block">
        <SettingMeta locale={locale} effect={text('ia_settings_card_engine_effect')} />
        <p className="kb-text kb-text--caption">{text('ia_settings_card_engine_local')}</p>
      </div>
      <EngineConfigPanel locale={locale} />
    </Card>
  );
}

/** SSO, formerly `/setup/sso` (which now redirects here). */
export function SsoCard({ locale }: { locale: ConciergeLocale }) {
  const text = textFor(locale);
  return (
    <Card
      id="settings-sso"
      title={text('ia_settings_card_sso')}
      description={text('ia_settings_card_sso_desc')}
    >
      <div className="settings-row-block">
        <SettingMeta
          locale={locale}
          defaultValue={text('ia_settings_card_sso_default')}
          effect={text('ia_settings_card_sso_effect')}
        />
      </div>
      <div className="settings-row-block settings-sso">
        <IdentityLinkSection />
        <SsoSettingsForm />
      </div>
    </Card>
  );
}

export function SecretsCard({ locale }: { locale: ConciergeLocale }) {
  const text = textFor(locale);
  return (
    <Card
      id="settings-secrets"
      title={text('ia_settings_card_secrets')}
      description={text('ia_settings_card_secrets_desc')}
    >
      <div className="settings-row-block">
        <p className="kb-text kb-text--muted">{text('ia_settings_cli_lead')}</p>
        <SettingsCommand
          locale={locale}
          command={'pnpm kyberion secret introduce\npnpm secrets:encrypt'}
        />
      </div>
    </Card>
  );
}

const usd = (value: number) => `$${value}`;

export function BudgetCard({
  locale,
  state,
}: {
  locale: ConciergeLocale;
  state: SetupChecklistState;
}) {
  const text = textFor(locale);
  const budget: SetupBudgetSummary | undefined =
    state.phase === 'ready' ? state.checklist.budget : undefined;
  return (
    <Card
      id="settings-budget"
      title={text('ia_settings_card_budget')}
      description={text('ia_settings_card_budget_desc')}
    >
      {budget ? (
        <>
          <SettingRow label={text('ia_settings_budget_daily')}>
            <span className="kb-text kb-text--body">{usd(budget.daily_cap_usd)}</span>
          </SettingRow>
          <SettingRow label={text('ia_settings_budget_mission')}>
            <span className="kb-text kb-text--body">{usd(budget.mission_cap_usd)}</span>
          </SettingRow>
          <SettingRow label={text('ia_settings_budget_posture')}>
            <span className="kb-text kb-text--body">
              {text(
                budget.posture === 'block'
                  ? 'ia_settings_budget_posture_block'
                  : 'ia_settings_budget_posture_warn'
              )}
            </span>
          </SettingRow>
          <div className="settings-row-block">
            <div className="settings-inline-actions settings-row-actions--start">
              <StatusPill
                status={budget.uses_default ? 'pending' : 'ready'}
                label={text(
                  budget.uses_default
                    ? 'ia_settings_budget_uses_default'
                    : 'ia_settings_budget_custom'
                )}
              />
            </div>
            <SettingMeta
              locale={locale}
              defaultValue={text('ia_settings_budget_default_value')}
              effect={text('ia_settings_step_budget_why')}
            />
          </div>
        </>
      ) : (
        <div className="settings-row-block">
          <p className="kb-text kb-text--muted" role="status">
            {state.phase === 'loading'
              ? text('ia_settings_checklist_loading')
              : text('ia_settings_budget_unavailable')}
          </p>
        </div>
      )}
      <div className="settings-row-block">
        <p className="kb-text kb-text--muted">{text('ia_settings_budget_change')}</p>
        <SettingsCommand
          locale={locale}
          label={text('ia_settings_budget_file')}
          command="knowledge/product/governance/spend-policy.json"
        />
      </div>
    </Card>
  );
}

const CLI_OPERATIONS: Array<[FrontDeskMessageKey, string]> = [
  ['ia_settings_cli_first_run', 'pnpm organization first-run code'],
  ['ia_settings_cli_scheduler', 'pnpm kyberion scheduler reconcile --apply'],
  ['ia_settings_cli_doctor', 'pnpm kyberion doctor'],
  ['ia_settings_cli_surfaces', 'pnpm surfaces reconcile'],
  ['ia_settings_cli_stance', 'pnpm stance:switch <customer>'],
  ['ia_settings_cli_customer_decision', 'pnpm kyberion customer-decision draft'],
];

export function CliOperationsCard({ locale }: { locale: ConciergeLocale }) {
  const text = textFor(locale);
  return (
    <Card
      id="settings-cli"
      title={text('ia_settings_card_cli')}
      description={text('ia_settings_card_cli_desc')}
    >
      {CLI_OPERATIONS.map(([label, command]) => (
        <CliSettingRow key={label} locale={locale} label={text(label)} command={command} />
      ))}
    </Card>
  );
}
