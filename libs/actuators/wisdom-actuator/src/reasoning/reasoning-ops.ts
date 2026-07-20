import {
  getReasoningBackend,
  requestPeerAdvice,
  type GenerateWithToolsResult,
  type PeerAdviceResult,
  type ReasoningCallOptions,
  type ToolDefinition,
} from '@agent/core';

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
}

export interface ToolProposalResult extends GenerateWithToolsResult {
  planned_tool_calls: NonNullable<GenerateWithToolsResult['toolCalls']>;
  tool_execution_status: 'not_executed';
}

export async function proposeToolCalls(input: ToolProposalInput): Promise<ToolProposalResult> {
  const backend = getReasoningBackend();
  if (!backend.generateWithTools) {
    throw new Error(
      '[wisdom:propose_tool_calls] Active backend does not support generateWithTools. ' +
        'Set KYBERION_REASONING_BACKEND=anthropic.'
    );
  }
  const result = await backend.generateWithTools(input.prompt, input.tools);
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
  let finalAnswer = '';

  for (let step = 0; step < input.maxSteps; step++) {
    const historyText = history.map((entry) => `[${entry.role}] ${entry.content}`).join('\n');
    const prompt =
      `Goal: ${input.goal}\n\nHistory:\n${historyText || '(none yet)'}\n\n` +
      'Think step by step. Either produce FINAL ANSWER: <answer> or describe the next concrete action needed.';

    const response =
      input.tools.length > 0 && backend.generateWithTools
        ? await backend.generateWithTools(prompt, input.tools)
        : { text: await backend.prompt(prompt) };
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
  }

  return {
    goal: input.goal,
    steps: history,
    final_answer: finalAnswer || history.at(-1)?.content || '',
    tool_execution_status: 'not_executed',
  };
}
