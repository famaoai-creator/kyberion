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
  normalizeAction,
  type ActionRefLike,
  type ButtonProps,
  type DisclosureProps,
  type KbReactActionRef,
} from './components/controls.js';
export {
  Code,
  KeyValue,
  List,
  Metric,
  Table,
  Text,
  type TableCellContext,
  type TableProps,
} from './components/data.js';
export { DisplayControls, type DisplayControlsProps } from './components/display.js';
export { KB_DISPLAY_CONTROLS_ACTIONS } from '../vanilla/kyberion-ui.js';
export {
  Badge,
  Callout,
  EmptyState,
  Skeleton,
  StatusPill,
  type CalloutProps,
  type EmptyStateProps,
} from './components/feedback.js';
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
  customPropertiesOnly,
  type AppShellProps,
  type AppShellStyle,
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
// PA-02 voice (audio files / transcripts reach the host only through onAction
// payloads — see src/voice/* and vanilla/voice-controller.js).
export {
  KB_VOICE_COMPONENT_TYPES,
  VoiceInput,
  VoiceState,
  isKbVoiceComponentType,
  renderVoiceComponent,
  type KbVoiceComponentType,
} from './voice/index.js';
export {
  KB_VOICE_ACTIONS,
  KB_VOICE_MESSAGE_KEYS,
  createVoiceController,
  type KbVoiceController,
  type KbVoiceControllerOptions,
  type KbVoiceErrorCode,
  type KbVoiceInputState,
} from '../vanilla/voice.js';
// PA-01 pads (toolbar files / sketch images reach the host only through
// onAction payloads — see src/pads/* and vanilla/pads.js).
export {
  Dialog,
  DialogView,
  DrawingPalette,
  KB_PAD_COMPONENT_TYPES,
  PaletteView,
  SketchBoard,
  Toolbar,
  isKbPadComponentType,
  renderPadComponent,
  type KbPadComponentType,
} from './pads/index.js';
export type { DialogProps, DialogViewProps } from './pads/dialog.js';
export type { DrawingPaletteProps, PaletteViewProps, SketchBoardProps } from './pads/drawing.js';
export type { ToolbarProps } from './pads/toolbar.js';
export {
  KB_DIALOG_ACTIONS,
  KB_DIALOG_MESSAGE_KEYS,
  KB_DRAWING_ACTIONS,
  KB_DRAWING_DEFAULT_COLORS,
  KB_DRAWING_MESSAGE_KEYS,
  KB_DRAWING_TOOLS,
  KB_TOOLBAR_ACTIONS,
  createDrawingEngine,
  type KbDrawingEngine,
  type KbDrawingEngineOptions,
  type KbSketchControllerRuntime,
} from '../vanilla/pads.js';
// PA-09 talking avatar (mouth motion only through the avatar.ready controller —
// see src/avatar/* and vanilla/avatar.js / vanilla/lipsync.js).
export {
  KB_AVATAR_COMPONENT_TYPES,
  TalkingAvatar,
  isKbAvatarComponentType,
  renderAvatarComponent,
  type KbAvatarComponentType,
} from './avatar/index.js';
export type { TalkingAvatarProps } from './avatar/talking-avatar.js';
export {
  KB_AVATAR_ACTIONS,
  KB_VISEME_OPENNESS,
  createAvatarController,
  createLipsync,
  cueFromLevel,
  visemeOpenness,
  type KbLipsync,
  type KbLipsyncCue,
  type KbLipsyncOptions,
  type KbTalkingAvatarRuntimeController,
} from '../vanilla/avatar.js';
