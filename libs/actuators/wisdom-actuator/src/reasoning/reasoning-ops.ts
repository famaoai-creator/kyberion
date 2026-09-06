import {
  getReasoningBackend,
  requestPeerAdvice,
  type GenerateWithToolsResult,
  type PeerAdviceResult,
  type ReasoningCallOptions,
  type ToolDefinition,
} from '@agent/core/reasoning-backend';
import { renderDeferredToolAnnouncement } from '@agent/core/prompt-cache-discipline';

export interface PureReasoningInput {
  instruction: string;
  context: string;
  systemPrompt?: string;
  allowBackendDelegation?: boolean;
}

export async function runPureReasoning(input: PureReasoningInput): Promise<string> {
  const backend = getReasoningBackend();
  const fullPrompt = input.systemPrompt
    ? `[SYSTEM: ${input.systemPrompt}]\n\nInstruction: ${input.instruction}\nContext: ${input.context}`
    : `Instruction: ${input.instruction}\nContext: ${input.context}`;

  // Backend delegation is still reasoning, not Agent delegation. The caller
  // records this operation as reasoning_single and receives no runtime receipt.
  return input.allowBackendDelegation
    ? backend.delegateTask(input.instruction, input.context)
    : backend.prompt(fullPrompt);
}

export interface PeerAdviceOpInput {
  question: string;
  context: string;
  tone: 'concise' | 'careful' | 'adversarial';
  preferredProvider?: string;
  preferredLabel?: string;
  modelTier?: ReasoningCallOptions['model_tier'];
  contextLabel?: string;
}

export async function runPeerAdvice(input: PeerAdviceOpInput): Promise<PeerAdviceResult> {
  const backend = getReasoningBackend();
  return requestPeerAdvice(
    backend,
    {
      question: input.question,
      context: input.context,
      tone: input.tone,
      preferred_provider: input.preferredProvider,
      preferred_label: input.preferredLabel,
    },
    {
      context: input.contextLabel || 'wisdom:peer_advice',
      model_tier: input.modelTier,
    }
  );
}

export interface ToolProposalInput {
  prompt: string;
  tools: ToolDefinition[];
  /** PI-17: definitions kept out of the active set for native deferred loading. */
  deferredTools?: ToolDefinition[];
  /** PI-17: caller-owned options for role, cache, and provider-native wire. */
  options?: ReasoningCallOptions;
  /** PI-17: governed catalog lookup for provider-native deferred references. */
  toolSearch?: (query: string) => Promise<readonly ToolDefinition[]> | readonly ToolDefinition[];
}

export interface ToolProposalResult extends GenerateWithToolsResult {
  planned_tool_calls: NonNullable<GenerateWithToolsResult['toolCalls']>;
  tool_execution_status: 'not_executed';
}

async function promoteDeferredToolReferences(
  references: readonly string[],
  activeTools: ToolDefinition[],
  toolRole: string | undefined,
  toolSearch: (query: string) => Promise<readonly ToolDefinition[]> | readonly ToolDefinition[]
): Promise<{ promoted: ToolDefinition[]; announcement: string | null }> {
  const promoted: ToolDefinition[] = [];
  for (const reference of references) {
    const query = String(reference || '').trim();
    if (!query) continue;
    const discovered = await toolSearch(query);
    if (!Array.isArray(discovered)) {
      throw new Error('[TOOL_SEARCH_INVALID_RESULT] catalog callback must return an array.');
    }
    for (const tool of discovered) {
      const name = String(tool?.name || '').trim();
      if (!name || !tool.description || !tool.inputSchema) {
        throw new Error('[TOOL_SEARCH_INVALID_RESULT] discovered tool is incomplete.');
      }
      if (toolRole && tool.allowed_roles?.length && !tool.allowed_roles.includes(toolRole)) {
        throw new Error(
          `[TOOL_SEARCH_ROLE_DENIED] role "${toolRole}" cannot access tool "${name}".`
        );
      }
      const existing = activeTools.find((candidate) => candidate.name === name);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(tool)) {
          throw new Error(`[TOOL_SEARCH_DUPLICATE] tool "${name}" has conflicting definitions.`);
        }
        continue;
      }
      const normalized = { ...tool, name };
      activeTools.push(normalized);
      promoted.push(normalized);
    }
  }
  return { promoted, announcement: renderDeferredToolAnnouncement(promoted) };
}

export async function proposeToolCalls(input: ToolProposalInput): Promise<ToolProposalResult> {
  const backend = getReasoningBackend();
  if (!backend.generateWithTools) {
    throw new Error(
      '[wisdom:propose_tool_calls] Active backend does not support generateWithTools. ' +
        'Set KYBERION_REASONING_BACKEND=anthropic.'
    );
  }
  const options: ReasoningCallOptions = {
    ...(input.options || {}),
    ...(input.deferredTools?.length ? { deferred_tool_definitions: [...input.deferredTools] } : {}),
  };
  const activeTools = [...input.tools];
  const toolRole = input.options?.role;
  const toolSearch =
    input.toolSearch ||
    (input.deferredTools?.length
      ? async (query: string): Promise<readonly ToolDefinition[]> =>
          input.deferredTools!.filter((tool) => tool.name === query)
      : undefined);
  let result = await backend.generateWithTools(input.prompt, activeTools, options);
  if (result.deferredToolReferences?.length && toolSearch) {
    const promotion = await promoteDeferredToolReferences(
      result.deferredToolReferences,
      activeTools,
      toolRole,
      toolSearch
    );
    if (promotion.promoted.length > 0) {
      result = await backend.generateWithTools(
        [input.prompt, promotion.announcement].filter(Boolean).join('\n\n'),
        activeTools,
        options
      );
    }
  }
  return {
    ...result,
    planned_tool_calls: result.toolCalls || [],
    tool_execution_status: 'not_executed',
  };
}

export interface ReasoningLoopInput {
  goal: string;
  maxSteps: number;
  tools: ToolDefinition[];
  /** PI-17: definitions kept out of the active set for native deferred loading. */
  deferredTools?: ToolDefinition[];
  /** PI-17: caller-owned reasoning options propagated to every loop turn. */
  options?: ReasoningCallOptions;
  /** PI-17: governed catalog lookup for provider-native deferred references. */
  toolSearch?: (query: string) => Promise<readonly ToolDefinition[]> | readonly ToolDefinition[];
  /** PI-17: role used to filter discovered tools before promotion. */
  toolRole?: string;
}

export interface ReasoningLoopStep {
  role: 'thought' | 'observation';
  content: string;
}

export interface ReasoningLoopResult {
  goal: string;
  steps: ReasoningLoopStep[];
  final_answer: string;
  tool_execution_status: 'not_executed';
}

export async function runReasoningLoop(input: ReasoningLoopInput): Promise<ReasoningLoopResult> {
  const backend = getReasoningBackend();
  const history: ReasoningLoopStep[] = [];
  const activeTools = [...input.tools];
  // A direct Wisdom caller may not have a runtime catalog callback. In that
  // case, only the definitions it explicitly supplied as deferred are
  // eligible for exact-name promotion; arbitrary provider references never
  // widen the tool surface.
  const toolSearch =
    input.toolSearch ||
    (input.deferredTools?.length
      ? async (query: string): Promise<readonly ToolDefinition[]> =>
          input.deferredTools!.filter((tool) => tool.name === query)
      : undefined);
  const toolRole = input.toolRole || input.options?.role;
  let promotedAnnouncement: string | null = null;
  let finalAnswer = '';

  for (let step = 0; step < input.maxSteps; step++) {
    const historyText = history.map((entry) => `[${entry.role}] ${entry.content}`).join('\n');
    const prompt = [
      `Goal: ${input.goal}\n\nHistory:\n${historyText || '(none yet)'}\n\n` +
        'Think step by step. Either produce FINAL ANSWER: <answer> or describe the next concrete action needed.',
      promotedAnnouncement,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');

    const turnOptions: ReasoningCallOptions = {
      ...(input.options || {}),
      ...(toolRole ? { role: toolRole } : {}),
      ...(input.deferredTools?.length
        ? { deferred_tool_definitions: [...input.deferredTools] }
        : {}),
    };
    const response =
      (activeTools.length > 0 || input.deferredTools?.length) && backend.generateWithTools
        ? await backend.generateWithTools(prompt, activeTools, turnOptions)
        : { text: await backend.prompt(prompt, turnOptions) };
    const responseText = response.text || '';
    history.push({ role: 'thought', content: responseText });

    if (responseText.includes('FINAL ANSWER:')) {
      finalAnswer = responseText.split('FINAL ANSWER:')[1]?.trim() || responseText;
      break;
    }
    for (const call of response.toolCalls || []) {
      history.push({
        role: 'observation',
        content: `Tool "${call.name}" → ${JSON.stringify(call.input)}`,
      });
    }

    // PI-17: a provider-native reference is only a catalog query. Resolve it
    // through the governed callback and add schemas at the next loop boundary.
    // The current request has already completed, so its stable tool prefix is
    // never mutated in place.
    if (response.deferredToolReferences?.length && toolSearch) {
      const promotion = await promoteDeferredToolReferences(
        response.deferredToolReferences,
        activeTools,
        toolRole,
        toolSearch
      );
      promotedAnnouncement = promotion.announcement;
      if (promotion.promoted.length > 0) {
        history.push({
          role: 'observation',
          content: `Deferred tools promoted for the next turn: ${promotion.promoted.map((tool) => tool.name).join(', ')}`,
        });
      }
    }
  }

  return {
    goal: input.goal,
    steps: history,
    final_answer: finalAnswer || history.at(-1)?.content || '',
    tool_execution_status: 'not_executed',
  };
}
