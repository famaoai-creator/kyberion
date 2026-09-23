/**
 * @agent/shared-ui — React renderer for the A2UI `kyberion-base` catalog.
 *
 * Every component emits the `.kb-*` class / BEM / data-attribute contract of
 * `kyberion-ui.css` (source: knowledge/public/design-patterns/web/
 * kyberion-ui.source.css) and nothing else: no inline colors, no Tailwind.
 * Surfaces import the generated `kyberion-ui.css` themselves.
 *
 * Client-safe: only *types* come from `@agent/core`; the runtime tables are
 * mirrored in `catalog.ts`.
 */
export {
  A2UIActionProvider,
  useA2UIActions,
  type A2UIActionContextValue,
  type A2UIActionHandler,
  type A2UIActionProviderProps,
  type A2UILinkProps,
} from './actions.js';
export {
  KB_ALIASES,
  KB_COMPONENT_TYPES,
  KB_STATUS_MESSAGE_KEYS,
  KB_STATUS_TONE_MAP,
  TABS_SELECT_ACTION,
  isKbStatus,
  resolveKbType,
  statusLabel,
  statusTone,
} from './catalog.js';
export {
  KB_UI_DEFAULT_LOCALE,
  KB_UI_DEFAULT_MESSAGES,
  KB_UI_MESSAGE_KEYS,
  KbI18nProvider,
  createKbTranslator,
  useKbI18n,
  type KbI18nProviderProps,
  type KbI18nValue,
  type KbTranslate,
} from './i18n.js';
export { KB_ICON_NAMES, KbIcon, type KbIconProps } from './icons.js';
export { safeHref } from './safety.js';
export {
  ActionRefButton,
  Button,
  Disclosure,
  KbLink,
  type ButtonProps,
  type DisclosureProps,
} from './components/controls.js';
export { KeyValue, List, Metric, Table, Text } from './components/data.js';
export { Badge, Callout, EmptyState, Skeleton, StatusPill } from './components/feedback.js';
export {
  Grid,
  NextAction,
  Section,
  Stack,
  type GridProps,
  type SectionProps,
  type StackProps,
} from './components/layout.js';
export {
  AppShell,
  NavRail,
  PageHeader,
  Tabs,
  type AppShellProps,
  type PageHeaderProps,
  type TabsProps,
} from './components/shell.js';
export {
  A2UIRenderer,
  type A2UIFallbackRegistry,
  type A2UIFallbackRenderInput,
  type A2UIFallbackRenderer,
  type A2UIRendererComponent,
  type A2UIRendererProps,
} from './renderer.js';
// UI-01c settings & forms (files / photos / secret values reach the host only
// through onAction payloads — see src/forms/*).
export {
  AvatarPicker,
  CameraCapture,
  Checkbox,
  FileDrop,
  IntegrationItem,
  KB_FORM_COMPONENT_TYPES,
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
  isKbFormComponentType,
  renderFormComponent,
  type KbFormComponentType,
} from './forms/index.js';
export {
  KB_FORM_ACTIONS,
  KB_FORM_MESSAGE_KEYS,
  createCameraController,
  formatBytes,
  screenFiles,
  type KbCameraController,
  type KbCameraState,
} from '../vanilla/forms.js';
// UI-01b charts & visualisation (geometry lives once in vanilla/charts.js).
export {
  KB_CHART_COMPONENT_TYPES,
  KbChart,
  isKbChartType,
  renderVNode,
  type KbChartProps,
  type KbChartType,
} from './charts/ChartView.js';
export {
  KB_CHART_MESSAGE_KEYS,
  layoutChart,
  type KbChartEnv,
  type KbVNode,
} from '../vanilla/charts.js';
