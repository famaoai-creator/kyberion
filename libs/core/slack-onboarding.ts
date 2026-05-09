import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import { writeGovernedArtifactJson } from './artifact-store.js';
import { customerResolver } from '@agent/core';

import type {
  OnboardingField,
  OnboardingState,
  OnboardingTurnResult,
  SlackOnboardingActionPayload,
  SlackOnboardingPrompt,
} from './channel-surface-types.js';

const TEXT_MODAL_FIELDS: OnboardingField[] = ['name', 'primary_domain', 'vision'];

function profileRoot(): string {
  return customerResolver.customerRoot('') ?? pathResolver.knowledge('personal');
}

function writeJsonAs(logicalPath: string, record: unknown): string {
  return writeGovernedArtifactJson('slack_bridge', logicalPath, record);
}

function onboardingStateLogicalPath(channel: string, threadTs: string): string {
  const safeThread = threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `active/shared/coordination/channels/slack/onboarding/${channel}-${safeThread}.json`;
}

function onboardingQuestions(): Record<OnboardingField, string> {
  return {
    name: 'まず、どのようにお呼びすれば良いですか？',
    language: '普段のやり取りで使いたい言語を教えてください。例: Japanese / English',
    interaction_style: '対話スタイルはどうしますか？ Senior Partner / Concierge / Minimalist から選んでください。',
    primary_domain: '主な活動領域を教えてください。例: Software Engineering / Data Analysis / Writing',
    vision: 'この環境で実現したい vision を短く教えてください。',
    agent_id: '最後に、この環境のメイン Agent ID を決めます。希望名があれば教えてください。既定値を使う場合は「そのまま」「default」「おまかせ」のいずれかを送ってください。既定値は KYBERION-PRIME です。',
  };
}

function onboardingFieldTitle(field: OnboardingField): string {
  switch (field) {
    case 'name': return 'Sovereign Name';
    case 'language': return 'Language';
    case 'interaction_style': return 'Interaction Style';
    case 'primary_domain': return 'Primary Domain';
    case 'vision': return 'Vision';
    case 'agent_id': return 'Agent ID';
  }
}

function nextOnboardingField(field: OnboardingField): OnboardingField | null {
  const order: OnboardingField[] = ['name', 'language', 'interaction_style', 'primary_domain', 'vision', 'agent_id'];
  const index = order.indexOf(field);
  return index >= 0 && index < order.length - 1 ? order[index + 1] : null;
}

function currentOnboardingField(state: OnboardingState | null): OnboardingField {
  return state?.currentField || 'name';
}

export function isEnvironmentInitialized(): boolean {
  const root = profileRoot();
  return safeExistsSync(path.join(root, 'my-identity.json')) &&
    safeExistsSync(path.join(root, 'my-vision.md')) &&
    safeExistsSync(path.join(root, 'agent-identity.json'));
}

function loadOnboardingState(channel: string, threadTs: string): OnboardingState | null {
  const resolved = pathResolver.resolve(onboardingStateLogicalPath(channel, threadTs));
  if (!safeExistsSync(resolved)) return null;
  return JSON.parse(safeReadFile(resolved, { encoding: 'utf8' }) as string) as OnboardingState;
}

export function getSlackOnboardingState(channel: string, threadTs: string): OnboardingState | null {
  return loadOnboardingState(channel, threadTs);
}

function saveOnboardingState(state: OnboardingState): string {
  return writeJsonAs(onboardingStateLogicalPath(state.channel, state.threadTs), state);
}

function normalizeInteractionStyle(input: string): string {
  const value = input.trim().toLowerCase();
  if (value.startsWith('s')) return 'Senior Partner';
  if (value.startsWith('m')) return 'Minimalist';
  if (value.startsWith('c')) return 'Concierge';
  return input.trim() || 'Concierge';
}

function shouldUseDefaultAgentId(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return true;
  return [
    /^default$/, /^skip$/, /^use default$/, /^そのまま$/, /^おまかせ$/, /^任せます$/,
    /^既定値$/, /^デフォルト$/, /^デフォルトで$/, /^その名前で.*$/, /^いただいた名前で.*$/, /^それで大丈夫.*$/,
  ].some((pattern) => pattern.test(normalized));
}

function normalizeOnboardingAnswer(field: OnboardingField, input: string): string {
  const trimmed = input.trim();
  if (field === 'agent_id' && shouldUseDefaultAgentId(trimmed)) return 'KYBERION-PRIME';
  return trimmed;
}

function serializeOnboardingAction(payload: SlackOnboardingActionPayload): string {
  return JSON.stringify(payload);
}

export function parseSlackOnboardingAction(value: string): SlackOnboardingActionPayload {
  return JSON.parse(value) as SlackOnboardingActionPayload;
}

export function buildSlackOnboardingPrompt(channel: string, threadTs: string): SlackOnboardingPrompt {
  const state = loadOnboardingState(channel, threadTs);
  const field = currentOnboardingField(state);
  return { field, text: onboardingQuestions()[field] };
}

export function buildSlackOnboardingBlocks(channel: string, threadTs: string): any[] {
  const prompt = buildSlackOnboardingPrompt(channel, threadTs);
  const state = loadOnboardingState(channel, threadTs);
  const answer = state?.answers?.[prompt.field] || '';
  const blocks: any[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*Onboarding*\n${prompt.text}` } }];
  if (prompt.field === 'language') {
    blocks.push({ type: 'actions', elements: ['日本語', 'English'].map((label) => ({ type: 'button', text: { type: 'plain_text', text: label }, action_id: 'slack_onboarding_pick', value: serializeOnboardingAction({ channel, threadTs, field: prompt.field, answer: label }) })) });
    return blocks;
  }
  if (prompt.field === 'interaction_style') {
    blocks.push({ type: 'actions', elements: ['Senior Partner', 'Concierge', 'Minimalist'].map((label) => ({ type: 'button', text: { type: 'plain_text', text: label }, action_id: 'slack_onboarding_pick', value: serializeOnboardingAction({ channel, threadTs, field: prompt.field, answer: label }) })) });
    return blocks;
  }
  if (prompt.field === 'agent_id') {
    blocks.push({ type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Use KYBERION-PRIME' }, style: 'primary', action_id: 'slack_onboarding_pick', value: serializeOnboardingAction({ channel, threadTs, field: prompt.field, answer: 'default' }) },
      { type: 'button', text: { type: 'plain_text', text: 'Set custom Agent ID' }, action_id: 'slack_onboarding_open_modal', value: serializeOnboardingAction({ channel, threadTs, field: prompt.field }) },
    ] });
    return blocks;
  }
  if (TEXT_MODAL_FIELDS.includes(prompt.field)) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open input form' }, style: 'primary', action_id: 'slack_onboarding_open_modal', value: serializeOnboardingAction({ channel, threadTs, field: prompt.field }) }] });
    if (answer) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Current value: ${answer}` }] });
    }
  }
  return blocks;
}

export function buildSlackOnboardingModal(payload: SlackOnboardingActionPayload): any {
  const existing = loadOnboardingState(payload.channel, payload.threadTs);
  const currentValue = existing?.answers?.[payload.field] || '';
  return {
    type: 'modal',
    callback_id: 'slack_onboarding_submit',
    private_metadata: JSON.stringify(payload),
    title: { type: 'plain_text', text: onboardingFieldTitle(payload.field) },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [{
      type: 'input',
      block_id: 'slack_onboarding_input',
      label: { type: 'plain_text', text: onboardingFieldTitle(payload.field) },
      hint: { type: 'plain_text', text: onboardingQuestions()[payload.field] },
      element: { type: 'plain_text_input', action_id: 'value', multiline: payload.field === 'vision' || payload.field === 'primary_domain', initial_value: currentValue },
    }],
  };
}

function persistOnboardingIdentity(state: OnboardingState): void {
  const name = state.answers.name || 'Sovereign';
  const language = state.answers.language || 'Japanese';
  const interactionStyle = normalizeInteractionStyle(state.answers.interaction_style || 'Concierge');
  const primaryDomain = state.answers.primary_domain || 'General';
  const vision = state.answers.vision || 'Build a high-fidelity Kyberion environment.';
  const agentId = (state.answers.agent_id || 'KYBERION-PRIME').trim().toUpperCase();
  const now = new Date().toISOString();
  withExecutionContext('sovereign_concierge', () => {
    const root = profileRoot();
    safeMkdir(root, { recursive: true });
    safeWriteFile(path.join(root, 'my-identity.json'), JSON.stringify({ name, language, interaction_style: interactionStyle, primary_domain: primaryDomain, created_at: now, status: 'active', version: '1.0.0' }, null, 2));
    safeWriteFile(path.join(root, 'my-vision.md'), `# Sovereign Vision\n\n${vision}\n`);
    safeWriteFile(path.join(root, 'agent-identity.json'), JSON.stringify({ agent_id: agentId, version: '1.0.0', role: 'Ecosystem Architect / Senior Partner', owner: name, trust_tier: 'sovereign', created_at: now, description: `The primary autonomous entity of the Kyberion Ecosystem for ${name}.` }, null, 2));
  });
}

export function handleSlackOnboardingTurn(params: { channel: string; threadTs: string; text: string; }): OnboardingTurnResult {
  const questions = onboardingQuestions();
  let state = loadOnboardingState(params.channel, params.threadTs);
  if (!state) {
    state = { channel: params.channel, threadTs: params.threadTs, currentField: 'name', answers: {}, completed: false, updatedAt: new Date().toISOString() };
    saveOnboardingState(state);
    return { completed: false, replyText: ['この環境はまだ初期化されていないため、まずオンボーディングを進めます。', '1問ずつ確認していきます。', '', questions.name].join('\n') };
  }
  if (!state.completed) {
    state.answers[state.currentField] = normalizeOnboardingAnswer(state.currentField, params.text);
    const nextField = nextOnboardingField(state.currentField);
    state.updatedAt = new Date().toISOString();
    if (!nextField) {
      state.completed = true;
      saveOnboardingState(state);
      persistOnboardingIdentity(state);
      return { completed: true, replyText: ['オンボーディング情報を保存しました。', `Name: ${state.answers.name}`, `Language: ${state.answers.language}`, `Style: ${normalizeInteractionStyle(state.answers.interaction_style || 'Concierge')}`, `Domain: ${state.answers.primary_domain}`, `Agent ID: ${(state.answers.agent_id || 'KYBERION-PRIME').trim().toUpperCase()}`, '', '初期化が完了したので、次のメッセージから通常の routing に切り替えます。'].join('\n') };
    }
    state.currentField = nextField;
    saveOnboardingState(state);
    return { completed: false, replyText: questions[nextField] };
  }
  return { completed: true, replyText: 'オンボーディングは完了しています。通常の依頼を送ってください。' };
}
