'use client';

import type { ReactNode } from 'react';
import { AvatarPicker, CameraCapture } from './camera.js';
import {
  Checkbox,
  RadioGroup,
  Segmented,
  Select,
  Slider,
  Switch,
  TextField,
  Textarea,
} from './fields.js';
import { FileDrop } from './files.js';
import { SecretField } from './secret.js';
import { IntegrationItem, SaveBar, SettingRow, SettingsGroup } from './settings.js';

/**
 * UI-01c settings & form components (SURFACE_UI_UNIFICATION_PLAN §3.3).
 * `renderFormComponent` is the A2UIRenderer hook: it returns `undefined` for
 * types outside this group so the base switch handles them.
 */

export const KB_FORM_COMPONENT_TYPES = [
  'ui:settings-group',
  'ui:setting-row',
  'ui:switch',
  'ui:checkbox',
  'ui:select',
  'ui:radio-group',
  'ui:segmented',
  'ui:text-field',
  'ui:textarea',
  'ui:slider',
  'ui:integration-item',
  'ui:save-bar',
  'ui:file-drop',
  'ui:camera-capture',
  'ui:avatar-picker',
  'ui:secret-field',
] as const;

export type KbFormComponentType = (typeof KB_FORM_COMPONENT_TYPES)[number];

const FORM_TYPES: ReadonlySet<string> = new Set(KB_FORM_COMPONENT_TYPES);

export function isKbFormComponentType(type: string): type is KbFormComponentType {
  return FORM_TYPES.has(type);
}

/** Render a form catalog type with its A2UI component id (for deterministic DOM ids). */
export function renderFormComponent(
  type: string,
  id: string,
  rawProps: Record<string, unknown>,
  children: ReactNode
): ReactNode | undefined {
  if (!isKbFormComponentType(type)) return undefined;
  // Props were schema-validated upstream (or are best-effort from a trusted host);
  // each component hardens what it reads.
  const p = <C extends (props: never) => unknown>(_component: C) =>
    ({ ...rawProps, id }) as unknown as Parameters<C>[0];
  switch (type) {
    case 'ui:settings-group':
      return <SettingsGroup {...p(SettingsGroup)}>{children}</SettingsGroup>;
    case 'ui:setting-row':
      return <SettingRow {...p(SettingRow)}>{children}</SettingRow>;
    case 'ui:switch':
      return <Switch {...p(Switch)} />;
    case 'ui:checkbox':
      return <Checkbox {...p(Checkbox)} />;
    case 'ui:select':
      return <Select {...p(Select)} />;
    case 'ui:radio-group':
      return <RadioGroup {...p(RadioGroup)} />;
    case 'ui:segmented':
      return <Segmented {...p(Segmented)} />;
    case 'ui:text-field':
      return <TextField {...p(TextField)} />;
    case 'ui:textarea':
      return <Textarea {...p(Textarea)} />;
    case 'ui:slider':
      return <Slider {...p(Slider)} />;
    case 'ui:integration-item':
      return <IntegrationItem {...p(IntegrationItem)} />;
    case 'ui:save-bar':
      return <SaveBar {...p(SaveBar)} />;
    case 'ui:file-drop':
      return <FileDrop {...p(FileDrop)} />;
    case 'ui:camera-capture':
      return <CameraCapture {...p(CameraCapture)} />;
    case 'ui:avatar-picker':
      return <AvatarPicker {...p(AvatarPicker)} />;
    case 'ui:secret-field':
      return <SecretField {...p(SecretField)} />;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export {
  AvatarPicker,
  CameraCapture,
  Checkbox,
  FileDrop,
  IntegrationItem,
  RadioGroup,
  SaveBar,
  SecretField,
  Segmented,
  Select,
  SettingRow,
  SettingsGroup,
  Slider,
  Switch,
  TextField,
  Textarea,
};
