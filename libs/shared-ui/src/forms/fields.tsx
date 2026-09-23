'use client';

import type {
  KbCheckboxProps,
  KbFieldOption,
  KbRadioGroupProps,
  KbSegmentedProps,
  KbSelectProps,
  KbSliderProps,
  KbSwitchProps,
  KbTextFieldProps,
  KbTextareaProps,
} from '@agent/core/a2ui-catalog';
import { useKbI18n } from '../i18n.js';
import {
  KB_FORM_MESSAGE_KEYS,
  describedBy,
  sliderRange,
  sliderValueText,
  textFieldValue,
} from '../../vanilla/forms.js';
import {
  FieldLabel,
  HelpAndError,
  RequiredMark,
  controlProps,
  fieldRootProps,
  useEcho,
  useFieldChange,
  useFieldIds,
  type KbFormComponentId,
} from './shared.js';

function optionsOf(options: unknown): KbFieldOption[] {
  return Array.isArray(options)
    ? options.filter(
        (option): option is KbFieldOption =>
          Boolean(option) && typeof option === 'object' && !Array.isArray(option)
      )
    : [];
}

// -- switch / checkbox -------------------------------------------------------

function Toggle(props: KbSwitchProps & KbFormComponentId & { control: 'switch' | 'checkbox' }) {
  const { control, ...p } = props;
  const ids = useFieldIds(p.id, p.name);
  const change = useFieldChange(p.name);
  const [checked, setChecked] = useEcho(p.value === true);
  const block = control === 'switch' ? 'kb-switch' : 'kb-check';
  return (
    <div className="kb-field" {...fieldRootProps(p, control)}>
      <label className={block}>
        <input
          className={`${block}__input`}
          type="checkbox"
          role={control === 'switch' ? 'switch' : undefined}
          {...controlProps(p, ids)}
          checked={checked}
          onChange={(event) => {
            setChecked(event.target.checked);
            change(event.target.checked);
          }}
        />
        {control === 'switch' ? (
          <span className="kb-switch__track" aria-hidden="true">
            <span className="kb-switch__thumb" />
          </span>
        ) : null}
        <span
          className={
            p.hide_label === true ? `${block}__label kb-visually-hidden` : `${block}__label`
          }
        >
          {String(p.label ?? '')}
          <RequiredMark required={p.required} />
        </span>
      </label>
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}

/** `ui:switch` → `.kb-field[data-control=switch] > label.kb-switch > input[role=switch]`. */
export function Switch(props: KbSwitchProps & KbFormComponentId) {
  return <Toggle {...props} control="switch" />;
}

/** `ui:checkbox` → `.kb-field[data-control=checkbox] > label.kb-check`. */
export function Checkbox(props: KbCheckboxProps & KbFormComponentId) {
  return <Toggle {...props} control="checkbox" />;
}

// -- select -----------------------------------------------------------------

/** `ui:select` → labelled native `select.kb-input.kb-select`. */
export function Select(p: KbSelectProps & KbFormComponentId) {
  const { t } = useKbI18n();
  const ids = useFieldIds(p.id, p.name);
  const change = useFieldChange(p.name);
  const options = optionsOf(p.options);
  const [value, setValue] = useEcho(p.value);
  const hasValue = options.some((option) => option.value === value);
  return (
    <div className="kb-field" {...fieldRootProps(p, 'select')}>
      <FieldLabel p={p} ids={ids} as="label" />
      {/* Wrapper carries the token-colored chevron (`::after`, see the
          source CSS); native `<select>` doesn't reliably support
          pseudo-elements. */}
      <div className="kb-select-wrap">
        <select
          className="kb-input kb-select"
          {...controlProps(p, ids)}
          name={String(p.name ?? '')}
          value={hasValue ? String(value) : ''}
          onChange={(event) => {
            setValue(event.target.value);
            change(event.target.value);
          }}
        >
          {!hasValue || p.placeholder ? (
            <option value="" disabled>
              {p.placeholder || t(KB_FORM_MESSAGE_KEYS.selectPlaceholder)}
            </option>
          ) : null}
          {options.map((option, index) => (
            <option
              key={`${option.value}-${index}`}
              value={String(option.value ?? '')}
              disabled={option.disabled === true || undefined}
            >
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}

// -- radio group / segmented -------------------------------------------------

function ChoiceGroup(
  props: KbRadioGroupProps & KbFormComponentId & { control: 'radio-group' | 'segmented' }
) {
  const { control, ...p } = props;
  const ids = useFieldIds(p.id, p.name);
  const change = useFieldChange(p.name);
  const [value, setValue] = useEcho(p.value);
  const segmented = control === 'segmented';
  const invalid = typeof p.error === 'string' && p.error ? (true as const) : undefined;
  return (
    <fieldset
      className={segmented ? 'kb-field kb-segmented' : 'kb-field kb-choice-group'}
      {...fieldRootProps(p, control)}
      data-direction={!segmented && p.direction === 'horizontal' ? 'horizontal' : undefined}
      aria-describedby={describedBy(ids, p)}
    >
      <FieldLabel p={p} ids={ids} as="legend" />
      <div className={segmented ? 'kb-segmented__options' : 'kb-choice-group__options'}>
        {optionsOf(p.options).map((option, index) => {
          const optionId = `${ids.input}-${index}`;
          const disabled = p.disabled === true || option.disabled === true;
          const input = (
            <input
              className={segmented ? 'kb-segmented__input' : 'kb-check__input'}
              type="radio"
              id={optionId}
              name={ids.input}
              value={String(option.value ?? '')}
              checked={value !== undefined && option.value === value}
              disabled={disabled || undefined}
              required={p.required === true || undefined}
              aria-invalid={invalid}
              aria-describedby={
                !segmented && option.description ? `${optionId}-description` : undefined
              }
              onChange={(event) => {
                if (!event.target.checked) return;
                setValue(option.value);
                change(String(option.value ?? ''));
              }}
            />
          );
          return (
            <label
              key={`${option.value}-${index}`}
              className={segmented ? 'kb-segmented__option' : 'kb-check'}
              data-disabled={disabled ? 'true' : undefined}
            >
              {input}
              {segmented ? (
                <span className="kb-segmented__label">{option.label}</span>
              ) : (
                <span className="kb-check__text">
                  <span className="kb-check__label">{option.label}</span>
                  {option.description ? (
                    <span className="kb-check__description" id={`${optionId}-description`}>
                      {option.description}
                    </span>
                  ) : null}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <HelpAndError p={p} ids={ids} />
    </fieldset>
  );
}

/** `ui:radio-group` → `fieldset.kb-choice-group` of native radios. */
export function RadioGroup(props: KbRadioGroupProps & KbFormComponentId) {
  return <ChoiceGroup {...props} control="radio-group" />;
}

/** `ui:segmented` → `fieldset.kb-segmented` (native radios styled as segments). */
export function Segmented(props: KbSegmentedProps & KbFormComponentId) {
  return <ChoiceGroup {...props} control="segmented" />;
}

// -- text field / textarea ---------------------------------------------------

const TEXT_TYPES: ReadonlySet<string> = new Set(['email', 'url', 'number', 'search']);

/** `ui:text-field` → labelled `input.kb-input`. */
export function TextField(p: KbTextFieldProps & KbFormComponentId) {
  const ids = useFieldIds(p.id, p.name);
  const change = useFieldChange(p.name);
  const type = typeof p.type === 'string' && TEXT_TYPES.has(p.type) ? p.type : 'text';
  const [value, setValue] = useEcho(
    p.value === undefined || p.value === null ? '' : String(p.value)
  );
  return (
    <div className="kb-field" {...fieldRootProps(p, 'text-field')}>
      <FieldLabel p={p} ids={ids} as="label" />
      <input
        className="kb-input"
        type={type}
        {...controlProps(p, ids)}
        name={String(p.name ?? '')}
        placeholder={p.placeholder || undefined}
        maxLength={Number.isInteger(p.maxlength) ? p.maxlength : undefined}
        min={type === 'number' && typeof p.min === 'number' ? p.min : undefined}
        max={type === 'number' && typeof p.max === 'number' ? p.max : undefined}
        step={type === 'number' && typeof p.step === 'number' ? p.step : undefined}
        readOnly={p.readonly === true || undefined}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          change(textFieldValue(type, event.target.value));
        }}
      />
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}

/** `ui:textarea` → labelled `textarea.kb-input.kb-textarea` (+ counter with `maxlength`). */
export function Textarea(p: KbTextareaProps & KbFormComponentId) {
  const { t } = useKbI18n();
  const ids = useFieldIds(p.id, p.name);
  const change = useFieldChange(p.name);
  const [value, setValue] = useEcho(
    p.value === undefined || p.value === null ? '' : String(p.value)
  );
  const maxlength = Number.isInteger(p.maxlength) ? p.maxlength : undefined;
  return (
    <div className="kb-field" {...fieldRootProps(p, 'textarea')}>
      <FieldLabel p={p} ids={ids} as="label" />
      <textarea
        className="kb-input kb-textarea"
        {...controlProps(p, ids)}
        name={String(p.name ?? '')}
        placeholder={p.placeholder || undefined}
        maxLength={maxlength}
        rows={Number.isInteger(p.rows) ? p.rows : undefined}
        readOnly={p.readonly === true || undefined}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          change(event.target.value);
        }}
      />
      {maxlength !== undefined ? (
        <p className="kb-field__count" aria-hidden="true">
          {t(KB_FORM_MESSAGE_KEYS.textCount, { count: value.length, max: maxlength })}
        </p>
      ) : null}
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}

// -- slider -------------------------------------------------------------------

/** `ui:slider` → labelled `input[type=range].kb-slider` with a visible value. */
export function Slider(p: KbSliderProps & KbFormComponentId) {
  const ids = useFieldIds(p.id, p.name);
  const change = useFieldChange(p.name);
  const range = sliderRange(p);
  const [value, setValue] = useEcho(range.value);
  const text = sliderValueText(value, p.unit);
  return (
    <div className="kb-field" {...fieldRootProps(p, 'slider')}>
      <div className="kb-slider__header">
        <FieldLabel p={p} ids={ids} as="label" />
        <output className="kb-slider__value" htmlFor={ids.input} aria-hidden="true">
          {text}
        </output>
      </div>
      <input
        className="kb-slider"
        type="range"
        {...controlProps(p, ids)}
        name={String(p.name ?? '')}
        min={range.min}
        max={range.max}
        step={range.step}
        aria-valuetext={text}
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          setValue(next);
          change(next);
        }}
      />
      <HelpAndError p={p} ids={ids} />
    </div>
  );
}
