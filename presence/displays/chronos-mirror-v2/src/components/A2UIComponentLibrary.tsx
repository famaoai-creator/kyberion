'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import {
  A2UIRenderer as SharedA2UIRenderer,
  Badge,
  Button,
  Callout,
  Section,
  Stack,
  Text,
  type A2UIFallbackRegistry,
  type A2UIRendererComponent,
} from '@agent/shared-ui';
import { uxTextOr } from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';
import { ChronosKbI18n } from './chronos-kb-i18n';
import {
  A2UI_FALLBACK_KEYS,
  CHRONOS_CODE_TYPE,
  KB_ARTIFACT_TILE_TYPE,
  KB_INTERVENTION_PANEL_TYPE,
  expandChronosComponents,
  type ChronosA2UIComponent,
  type ChronosA2UITranslate,
} from './chronos-a2ui-adapter';

/**
 * A2UI rendering for Chronos Mirror v2 (UI-07).
 *
 * Every component — `ui:*` catalog types, legacy aliases and the chronos
 * `display:*` / `kb-*` vocabulary — renders through the shared
 * `@agent/shared-ui` `A2UIRenderer`, so chronos emits only the `.kb-*` class
 * contract of `kyberion-ui.css`. `display:*` / `kb-*` are rewritten to `ui:*`
 * subtrees by `chronos-a2ui-adapter.ts`; the three chronos-only leaves that
 * need local behaviour (`kb-artifact-tile`, `kb-intervention-panel`,
 * `chronos:code`) are the renderer's `fallback` registry below, built from
 * shared components and `--kb-ui-*` tokens only.
 */

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

/** `tx(key, englishDefault)` — explicit key, else the known-default key, else the text. */
function useA2UIText(): ChronosA2UITranslate {
  const locale = useChronosLocale();
  return useCallback(
    (key: string | undefined, fallbackEn: string) => {
      const resolvedKey =
        key ||
        (Object.prototype.hasOwnProperty.call(A2UI_FALLBACK_KEYS, fallbackEn)
          ? A2UI_FALLBACK_KEYS[fallbackEn]
          : undefined);
      return resolvedKey ? uxTextOr(resolvedKey, fallbackEn, locale) : fallbackEn;
    },
    [locale]
  );
}

// ---------------------------------------------------------------------------
// Operator actions (SU-02)
// ---------------------------------------------------------------------------

type InterventionOption = {
  label: string;
  variant?: 'primary' | 'danger' | 'neutral';
  value?: string;
};

/** Action emitted when the operator interacts with an actionable A2UI component (SU-02). */
export interface A2UIComponentAction {
  componentType: string;
  action: 'select-option' | 'open' | 'preview';
  option?: InterventionOption;
  props: Record<string, any>;
}

const ChronosA2UIActionContext = createContext<((action: A2UIComponentAction) => void) | undefined>(
  undefined
);

// ---------------------------------------------------------------------------
// Chronos-only leaves (fallback registry)
// ---------------------------------------------------------------------------

/** `chronos:code` — `display:code` / `display:log` body: a scrollable mono block. */
function ChronosCodeBlock({ code, language }: { code: string; language?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {language ? <Text text={language} variant="caption" /> : null}
      <pre
        className="kb-text kb-text--mono m-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[var(--kb-ui-radius-md)] border border-[var(--kb-ui-border)] bg-[var(--kb-ui-surface-sunken)] p-3 text-[var(--kb-ui-text)]"
        data-language={language || undefined}
      >
        {code}
      </pre>
    </div>
  );
}

/** `kb-artifact-tile` — a produced file with preview / open actions. */
export const KbArtifactTile = ({
  type,
  path,
  previewContent,
  missionId,
  updatedAt,
  missing,
  onSelect,
  onOpen,
  onPreview,
}: {
  type: string;
  path: string;
  previewContent: string;
  missionId?: string;
  updatedAt?: string;
  missing?: boolean;
  onSelect?: () => void;
  onOpen?: () => void;
  onPreview?: () => void;
}) => {
  const tx = useA2UIText();
  const safePath = typeof path === 'string' ? path : '';
  const fileName = safePath.split('/').filter(Boolean).pop() || safePath;
  const meta = [missionId, typeof updatedAt === 'string' ? updatedAt.slice(0, 10) : undefined]
    .filter(Boolean)
    .join(' · ');
  const select = onSelect || onPreview || onOpen;
  const preview = previewContent ? <ChronosCodeBlock code={String(previewContent)} /> : null;
  return (
    <Section title={fileName} description={meta || undefined} headingLevel={3}>
      <Stack gap="xs" direction="horizontal" align="center" wrap>
        {type ? <Badge label={String(type)} tone="neutral" /> : null}
        {missing ? (
          <Badge label={tx('chronos_a2ui_file_missing', 'file missing')} tone="warning" />
        ) : null}
      </Stack>
      <Text text={safePath} variant="mono" />
      {preview && select ? (
        <button
          type="button"
          onClick={select}
          className="block w-full min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left"
        >
          {preview}
        </button>
      ) : (
        preview
      )}
      {missing ? (
        <Text
          text={tx(
            'chronos_a2ui_original_file_cleaned',
            'The original file was cleaned up; only the record remains.'
          )}
          variant="muted"
        />
      ) : onOpen || onPreview ? (
        <Stack gap="sm" direction="horizontal" wrap>
          {onPreview ? (
            <Button
              label={tx('chronos_a2ui_preview', 'Preview')}
              variant="secondary"
              onClick={onPreview}
            />
          ) : null}
          {onOpen ? (
            <Button label={tx('chronos_cb_open', 'Open')} variant="ghost" onClick={onOpen} />
          ) : null}
        </Stack>
      ) : null}
    </Section>
  );
};

const OPTION_VARIANTS = { primary: 'primary', danger: 'danger', neutral: 'secondary' } as const;

function optionVariant(variant: unknown): 'primary' | 'danger' | 'secondary' {
  return typeof variant === 'string' &&
    Object.prototype.hasOwnProperty.call(OPTION_VARIANTS, variant)
    ? OPTION_VARIANTS[variant as keyof typeof OPTION_VARIANTS]
    : 'secondary';
}

/** `kb-intervention-panel` — operator decision prompt (callout + option buttons). */
export const KbInterventionPanel = ({
  reason,
  reasonKey,
  title,
  titleKey,
  options,
  isBlocking,
  onSelectOption,
}: {
  reason: string;
  reasonKey?: string;
  title?: string;
  titleKey?: string;
  options: InterventionOption[];
  isBlocking: boolean;
  onSelectOption?: (option: InterventionOption) => void;
}) => {
  const tx = useA2UIText();
  const list = Array.isArray(options) ? options : [];
  return (
    <Callout
      tone={isBlocking ? 'warning' : 'info'}
      title={tx(titleKey, title || 'Intervention Required')}
      body={reason ? tx(reasonKey, reason) : undefined}
    >
      {list.length ? (
        <div className="kb-callout__action">
          <Stack gap="sm" direction="horizontal" wrap>
            {list.map((option, index) => (
              <Button
                key={`${option.label}-${index}`}
                label={String(option.label ?? '')}
                variant={optionVariant(option.variant)}
                disabled={!onSelectOption}
                onClick={() => onSelectOption?.(option)}
              />
            ))}
          </Stack>
        </div>
      ) : null}
    </Callout>
  );
};

function ArtifactTileEntry({ props }: { props: Record<string, any> }) {
  const onAction = useContext(ChronosA2UIActionContext);
  return (
    <KbArtifactTile
      {...(props as any)}
      onOpen={
        onAction
          ? () => onAction({ componentType: KB_ARTIFACT_TILE_TYPE, action: 'open', props })
          : undefined
      }
      onPreview={
        onAction
          ? () => onAction({ componentType: KB_ARTIFACT_TILE_TYPE, action: 'preview', props })
          : undefined
      }
    />
  );
}

function InterventionPanelEntry({ props }: { props: Record<string, any> }) {
  const onAction = useContext(ChronosA2UIActionContext);
  return (
    <KbInterventionPanel
      {...(props as any)}
      onSelectOption={
        onAction
          ? (option) =>
              onAction({
                componentType: KB_INTERVENTION_PANEL_TYPE,
                action: 'select-option',
                option,
                props,
              })
          : undefined
      }
    />
  );
}

/** Chronos-only types for the shared renderer's `fallback` registry. */
export const CHRONOS_A2UI_FALLBACK: A2UIFallbackRegistry = Object.freeze({
  [CHRONOS_CODE_TYPE]: ({ props }) => (
    <ChronosCodeBlock
      code={typeof props.code === 'string' ? props.code : ''}
      language={typeof props.language === 'string' ? props.language : undefined}
    />
  ),
  [KB_ARTIFACT_TILE_TYPE]: ({ props }) => <ArtifactTileEntry props={props} />,
  [KB_INTERVENTION_PANEL_TYPE]: ({ props }) => <InterventionPanelEntry props={props} />,
});

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export interface ChronosA2UIRendererProps {
  /** A2UI `updateComponents.components` (any mix of `ui:*`, aliases, `display:*`, `kb-*`). */
  components: readonly ChronosA2UIComponent[];
  onAction?: (action: A2UIComponentAction) => void;
}

/**
 * Render a chronos A2UI component list with the shared renderer (compact
 * density, chronos locale). Children ids are honoured; unknown types degrade
 * to the shared renderer's unknown-type notice (dev) or nothing (production).
 */
export function ChronosA2UIRenderer({ components, onAction }: ChronosA2UIRendererProps) {
  const tx = useA2UIText();
  const expanded = useMemo(
    () => expandChronosComponents(components, tx) as A2UIRendererComponent[],
    [components, tx]
  );
  return (
    <ChronosKbI18n>
      <ChronosA2UIActionContext.Provider value={onAction}>
        <div className="kb-stack" data-gap="md" data-density="compact">
          <SharedA2UIRenderer components={expanded} fallback={CHRONOS_A2UI_FALLBACK} />
        </div>
      </ChronosA2UIActionContext.Provider>
    </ChronosKbI18n>
  );
}

/**
 * Single-component entry point kept for existing callers
 * (`<A2UIRenderer type props onAction />`); renders through
 * `ChronosA2UIRenderer` (props are sanitized by the adapter).
 */
export const A2UIRenderer = ({
  type,
  props,
  onAction,
}: {
  type: string;
  props: Record<string, any>;
  onAction?: (action: A2UIComponentAction) => void;
}) => {
  const components = useMemo<ChronosA2UIComponent[]>(
    () => [{ id: 'a2ui-root', type: String(type), props: props || {} }],
    [type, props]
  );
  return <ChronosA2UIRenderer components={components} onAction={onAction} />;
};
