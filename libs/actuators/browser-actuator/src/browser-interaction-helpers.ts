export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

/**
 * A DOM presence check that can be lowered to the existing browser pipeline
 * vocabulary.  Keeping this as a compiler helper means conditional actions do
 * not introduce a second, browser-actuator-specific control-flow op.
 */
export interface BrowserElementPresentCondition {
  selector: string;
  text?: string;
  exact?: boolean;
  export_as?: string;
}

export function buildBrowserElementPresentPipeline(input: {
  condition: BrowserElementPresentCondition;
  then: PipelineStep[];
  else?: PipelineStep[];
}): PipelineStep[] {
  const selector = input.condition.selector.trim();
  if (!selector) throw new Error('Browser element condition requires a non-empty selector');

  const exportAs = input.condition.export_as?.trim() || 'browser_condition_match_count';
  const queryParams: Record<string, unknown> = {
    selector,
    export_as: exportAs,
  };
  if (input.condition.text !== undefined) queryParams.text = input.condition.text;
  if (input.condition.exact !== undefined) queryParams.exact = input.condition.exact;

  const branch: Record<string, unknown> = {
    condition: { from: exportAs, operator: 'gt', value: 0 },
    then: input.then,
  };
  if (input.else) branch.else = input.else;

  return [
    { type: 'capture', op: 'query_elements', params: queryParams },
    { type: 'control', op: 'if', params: branch },
  ];
}

interface BrowserAction {
  action: 'pipeline';
  steps: PipelineStep[];
  session_id?: string;
  options?: {
    headless?: boolean;
    viewport?: { width: number; height: number };
    max_steps?: number;
    timeout_ms?: number;
    record_trace?: boolean;
    record_video?: boolean;
    locale?: string;
    lease_ms?: number;
    keep_alive?: boolean;
    user_data_dir?: string;
    browser_channel?: 'chromium' | 'chrome';
    profile_directory?: string;
    launch_args?: string[];
    connect_over_cdp?: boolean;
    cdp_url?: string;
    cdp_port?: number;
  };
  context?: Record<string, any>;
}

interface ComputerInteractionAction {
  version: '0.1';
  kind: 'computer_interaction';
  session_id?: string;
  target?: {
    surface_id?: string;
    runtime_id?: string;
    tab_id?: string;
    display_id?: string;
    domain?: string;
  };
  observation?: {
    mode?: 'screen' | 'dom_snapshot' | 'console' | 'network' | 'mixed';
    include_screenshot?: boolean;
    include_refs?: boolean;
    include_console?: boolean;
    include_network?: boolean;
    viewport?: {
      width?: number;
      height?: number;
      scale?: number;
    };
  };
  action: {
    type:
      | 'snapshot'
      | 'screenshot'
      | 'open_tab'
      | 'select_tab'
      | 'left_click'
      | 'double_click'
      | 'right_click'
      | 'mouse_move'
      | 'left_mouse_down'
      | 'left_mouse_up'
      | 'drag'
      | 'scroll'
      | 'type'
      | 'key'
      | 'wait'
      | 'click_ref'
      | 'fill_ref'
      | 'press_ref'
      | 'wait_for_ref'
      | 'extract_text_ref'
      | 'click_if_present'
      | 'capture_console'
      | 'capture_network';
    coordinate?: { x: number; y: number };
    to_coordinate?: { x: number; y: number };
    button?: 'left' | 'right' | 'middle';
    text?: string;
    selector?: string;
    exact?: boolean;
    key?: string;
    ref?: string;
    url?: string;
    timeout_ms?: number;
    scroll_delta?: { x?: number; y?: number };
  };
}

export function createBrowserInteractionHelpers(deps: {
  executePipeline: (
    steps: PipelineStep[],
    sessionId: string,
    options: any,
    initialCtx?: any
  ) => Promise<any>;
  emitComputerSurfacePatch: (payload: Record<string, any>) => void;
}) {
  function translateComputerInteractionToBrowserAction(
    input: ComputerInteractionAction
  ): BrowserAction {
    const interaction = input.action || { type: 'snapshot' as const };
    const sessionId = input.session_id || input.target?.runtime_id || 'computer-session';
    const viewport =
      input.observation?.viewport?.width && input.observation?.viewport?.height
        ? {
            width: input.observation.viewport.width,
            height: input.observation.viewport.height,
          }
        : undefined;

    const steps: PipelineStep[] = [];
    const options: BrowserAction['options'] = {
      headless: true,
      keep_alive: true,
      lease_ms: 5 * 60 * 1000,
      ...(viewport ? { viewport } : {}),
    };

    if (
      input.target?.tab_id &&
      interaction.type !== 'open_tab' &&
      interaction.type !== 'select_tab'
    ) {
      steps.push({ type: 'control', op: 'select_tab', params: { tab_id: input.target.tab_id } });
    }

    const requiresRefSnapshot =
      interaction.type === 'click_ref' ||
      interaction.type === 'fill_ref' ||
      interaction.type === 'press_ref' ||
      interaction.type === 'wait_for_ref' ||
      interaction.type === 'extract_text_ref' ||
      (interaction.type === 'scroll' && Boolean(interaction.ref));
    if (requiresRefSnapshot) {
      steps.push({ type: 'capture', op: 'snapshot', params: { export_as: 'last_snapshot' } });
    }

    switch (interaction.type) {
      case 'snapshot':
        steps.push({ type: 'capture', op: 'snapshot', params: { export_as: 'last_snapshot' } });
        break;
      case 'screenshot':
        steps.push({ type: 'capture', op: 'screenshot', params: { export_as: 'last_screenshot' } });
        break;
      case 'open_tab':
        steps.push({
          type: 'control',
          op: 'open_tab',
          params: {
            url: interaction.url,
            tab_id: input.target?.tab_id,
            select: true,
          },
        });
        break;
      case 'select_tab':
        steps.push({
          type: 'control',
          op: 'select_tab',
          params: { tab_id: input.target?.tab_id || 'tab-1' },
        });
        break;
      case 'click_ref':
        steps.push({
          type: 'apply',
          op: 'click_ref',
          params: { ref: interaction.ref, timeout: interaction.timeout_ms },
        });
        break;
      case 'click_if_present':
        steps.push(
          ...buildBrowserElementPresentPipeline({
            condition: {
              selector: interaction.selector || '',
              text: interaction.text,
              exact: interaction.exact,
              export_as: 'conditional_match_count',
            },
            then: [
              {
                type: 'apply',
                op: 'click_first_match',
                params: {
                  selector: interaction.selector,
                  text: interaction.text,
                  exact: interaction.exact,
                  export_as: 'conditional_click',
                },
              },
            ],
          })
        );
        break;
      case 'fill_ref':
        steps.push({
          type: 'apply',
          op: 'fill_ref',
          params: {
            ref: interaction.ref,
            text: interaction.text || '',
            timeout: interaction.timeout_ms,
          },
        });
        break;
      case 'press_ref':
        steps.push({
          type: 'apply',
          op: 'press_ref',
          params: {
            ref: interaction.ref,
            key: interaction.key || 'Enter',
            timeout: interaction.timeout_ms,
          },
        });
        break;
      case 'wait_for_ref':
        steps.push({
          type: 'apply',
          op: 'wait_ref',
          params: { ref: interaction.ref, timeout: interaction.timeout_ms },
        });
        break;
      case 'extract_text_ref':
        steps.push({
          type: 'capture',
          op: 'extract_text_ref',
          params: { ref: interaction.ref, export_as: 'last_capture' },
        });
        break;
      case 'scroll':
        steps.push({
          type: 'apply',
          op: interaction.ref ? 'scroll_ref' : 'scroll',
          params: interaction.ref
            ? { ref: interaction.ref, timeout: interaction.timeout_ms }
            : { delta: interaction.scroll_delta, timeout: interaction.timeout_ms },
        });
        break;
      case 'capture_console':
        steps.push({ type: 'capture', op: 'console', params: { export_as: 'console_events' } });
        break;
      case 'capture_network':
        steps.push({ type: 'capture', op: 'network', params: { export_as: 'network_events' } });
        break;
      case 'wait':
        steps.push({
          type: 'apply',
          op: 'wait',
          params: { duration: interaction.timeout_ms || 1000 },
        });
        break;
      default:
        throw new Error(
          `Unsupported computer interaction action for browser-actuator: ${interaction.type}`
        );
    }

    const includeConsole =
      input.observation?.include_console === true ||
      input.observation?.mode === 'console' ||
      input.observation?.mode === 'mixed';
    const includeNetwork =
      input.observation?.include_network === true ||
      input.observation?.mode === 'network' ||
      input.observation?.mode === 'mixed';
    const includeScreenshot = input.observation?.include_screenshot === true;

    if (interaction.type === 'snapshot') {
      if (includeScreenshot) {
        steps.push({
          type: 'capture',
          op: 'screenshot',
          params: {
            export_as: 'last_screenshot',
            path: `active/shared/tmp/computer/${sessionId}-snapshot.png`,
          },
        });
      }
      if (includeConsole) {
        steps.push({ type: 'capture', op: 'console', params: { export_as: 'console_events' } });
      }
      if (includeNetwork) {
        steps.push({ type: 'capture', op: 'network', params: { export_as: 'network_events' } });
      }
    }

    return {
      action: 'pipeline',
      session_id: sessionId,
      options,
      context: {
        computer_interaction_kind: input.kind,
        computer_interaction_target: input.target || {},
      },
      steps,
    };
  }

  async function handleComputerInteraction(input: ComputerInteractionAction) {
    const browserAction = translateComputerInteractionToBrowserAction(input);
    const result = await deps.executePipeline(
      browserAction.steps || [],
      browserAction.session_id || 'default',
      browserAction.options || {},
      browserAction.context || {}
    );
    const ctx = (result as any).context || {};
    deps.emitComputerSurfacePatch({
      sessionId: browserAction.session_id || 'default',
      executor: 'browser',
      status: String((result as any).status || 'unknown'),
      latestAction: input.action.type,
      target: typeof ctx.active_tab_id === 'string' ? ctx.active_tab_id : input.target?.tab_id,
      detail: typeof ctx.last_snapshot?.url === 'string' ? ctx.last_snapshot.url : undefined,
      screenshotPath: typeof ctx.last_screenshot === 'string' ? ctx.last_screenshot : undefined,
      actionCount: Array.isArray(ctx.action_trail) ? ctx.action_trail.length : undefined,
    });
    return result;
  }

  return {
    translateComputerInteractionToBrowserAction,
    handleComputerInteraction,
  };
}
