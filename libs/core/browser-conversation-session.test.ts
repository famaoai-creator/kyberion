import { afterEach, describe, expect, it } from 'vitest';
import {
  applyBrowserConversationCommand,
  classifyBrowserConversationCommand,
  confirmBrowserConversationCandidate,
  createBrowserConversationCommand,
  createBrowserConversationSession,
  getActiveBrowserConversationSession,
  listBrowserConversationSessions,
  loadBrowserConversationSession,
  recordBrowserConversationHistory,
  saveBrowserConversationSession,
  validateBrowserConversationCommand,
  validateBrowserConversationFeedback,
  validateBrowserConversationSession,
} from './browser-conversation-session.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile, safeMkdir } from './secure-io.js';

describe('browser conversation session helpers', () => {
  const sessionDir = pathResolver.shared('runtime/browser/conversation-sessions');
  const snapshotDir = pathResolver.shared('runtime/browser/snapshots');

  afterEach(() => {
    safeRmSync(sessionDir, { recursive: true, force: true });
    safeRmSync(snapshotDir, { recursive: true, force: true });
  });

  it('creates and validates a session with defaults', () => {
    const session = createBrowserConversationSession({
      surface: 'presence',
      goal: {
        summary: '承認フローを進める',
        success_condition: '承認を完了する',
      },
    });

    const result = validateBrowserConversationSession(session);
    expect(result.valid).toBe(true);
    expect(session.status).toBe('awaiting_instruction');
    expect(session.control.interruptible).toBe(true);
  });

  it('persists and reloads conversation sessions', () => {
    const session = createBrowserConversationSession({
      sessionId: 'BRS-TEST-1',
      surface: 'presence',
      goal: {
        summary: '承認フローを進める',
        success_condition: '承認を完了する',
      },
    });

    saveBrowserConversationSession(session);
    const loaded = loadBrowserConversationSession('BRS-TEST-1');

    expect(loaded?.session_id).toBe('BRS-TEST-1');
    expect(listBrowserConversationSessions()).toHaveLength(1);
  });

  it('records history entries on an existing session', () => {
    const session = createBrowserConversationSession({
      sessionId: 'BRS-TEST-2',
      surface: 'presence',
      goal: {
        summary: '承認フローを進める',
        success_condition: '承認を完了する',
      },
    });
    saveBrowserConversationSession(session);

    const updated = recordBrowserConversationHistory('BRS-TEST-2', {
      ts: new Date().toISOString(),
      type: 'instruction',
      text: '左下の承認ボタンを押して',
    });

    expect(updated?.history).toHaveLength(1);
    expect(updated?.history[0]?.type).toBe('instruction');
  });

  it('validates browser conversation command and feedback contracts', () => {
    const command = validateBrowserConversationCommand({
      kind: 'browser_session_command',
      session_id: 'BRS-TEST-3',
      command_type: 'step_command',
      utterance: '左下の承認ボタンを押して',
      issued_at: new Date().toISOString(),
      resolution: {
        action: 'click',
        target_hint: {
          text: '承認',
          region: 'bottom-left',
        },
      },
    });
    const feedback = validateBrowserConversationFeedback({
      kind: 'browser_session_feedback',
      session_id: 'BRS-TEST-3',
      status: 'awaiting_confirmation',
      message: '左下の承認ボタンで合っていますか。',
      ts: new Date().toISOString(),
      candidates: [
        {
          element_id: 'el-17',
          label: '承認',
          region_hint: 'bottom-left',
          confidence: 0.92,
        },
      ],
    });

    expect(command.valid).toBe(true);
    expect(feedback.valid).toBe(true);
  });

  it('classifies and applies a step command to the active session', () => {
    const session = createBrowserConversationSession({
      sessionId: 'BRS-TEST-4',
      surface: 'presence',
      goal: {
        summary: '承認フローを進める',
        success_condition: '承認を完了する',
      },
    });
    saveBrowserConversationSession(session);

    const resolution = classifyBrowserConversationCommand('左下の承認ボタンを押して');
    expect(resolution?.commandType).toBe('step_command');
    expect(getActiveBrowserConversationSession('presence')?.session_id).toBe('BRS-TEST-4');

    const command = createBrowserConversationCommand({
      sessionId: 'BRS-TEST-4',
      utterance: '左下の承認ボタンを押して',
      resolution: resolution!,
    });
    const feedback = applyBrowserConversationCommand('BRS-TEST-4', command);
    const loaded = loadBrowserConversationSession('BRS-TEST-4');

    expect(feedback?.status).toBe('progress');
    expect(loaded?.status).toBe('resolving_target');
    expect(loaded?.active_step?.kind).toBe('click');
  });

  it('classifies fill and press commands with conversational hints', () => {
    const fill = classifyBrowserConversationCommand('メール欄に「test@example.com」を入力して');
    const press = classifyBrowserConversationCommand('その入力欄で Enter を押して');
    const click = classifyBrowserConversationCommand('Learn more を押して');

    expect(fill?.action).toBe('fill');
    expect(fill?.inputText).toBe('test@example.com');
    expect(press?.action).toBe('press');
    expect(click?.action).toBe('click');
    expect(click?.targetHint?.text).toBe('Learn more');
  });

  it('resolves a single candidate target from the latest browser snapshot', () => {
    safeMkdir(snapshotDir, { recursive: true });
    safeWriteFile(
      `${snapshotDir}/BRS-TEST-5.json`,
      JSON.stringify({
        session_id: 'BRS-TEST-5',
        tab_id: 'tab-1',
        url: 'https://example.com',
        title: 'Approval Console',
        captured_at: new Date().toISOString(),
        elements: [
          { ref: '@e1', role: 'button', text: '承認', name: '承認' },
          { ref: '@e2', role: 'button', text: 'キャンセル', name: 'キャンセル' },
        ],
      }, null, 2),
    );

    const session = createBrowserConversationSession({
      sessionId: 'BRS-TEST-5',
      surface: 'presence',
      goal: {
        summary: '承認フローを進める',
        success_condition: '承認を完了する',
      },
    });
    saveBrowserConversationSession(session);
    const resolution = classifyBrowserConversationCommand('左下の承認ボタンを押して')!;
    const command = createBrowserConversationCommand({
      sessionId: 'BRS-TEST-5',
      utterance: '左下の承認ボタンを押して',
      resolution,
    });

    const feedback = applyBrowserConversationCommand('BRS-TEST-5', command);
    const loaded = loadBrowserConversationSession('BRS-TEST-5');

    expect(feedback?.message).toContain('承認');
    expect(loaded?.candidate_targets[0]?.element_id).toBe('@e1');
  });

  it('keeps awaiting confirmation for multiple candidates until the user selects one', () => {
    safeMkdir(snapshotDir, { recursive: true });
    safeWriteFile(
      `${snapshotDir}/BRS-TEST-6.json`,
      JSON.stringify({
        session_id: 'BRS-TEST-6',
        tab_id: 'tab-1',
        url: 'https://example.com',
        title: 'Approval Console',
        captured_at: new Date().toISOString(),
        elements: [
          { ref: '@e1', role: 'button', text: '承認', name: '承認' },
          { ref: '@e2', role: 'button', text: '承認', name: '承認（下書き）' },
        ],
      }, null, 2),
    );

    const session = createBrowserConversationSession({
      sessionId: 'BRS-TEST-6',
      surface: 'presence',
      goal: {
        summary: '承認フローを進める',
        success_condition: '承認を完了する',
      },
    });
    saveBrowserConversationSession(session);
    const resolution = classifyBrowserConversationCommand('承認ボタンを押して')!;
    const command = createBrowserConversationCommand({
      sessionId: 'BRS-TEST-6',
      utterance: '承認ボタンを押して',
      resolution,
    });

    const feedback = applyBrowserConversationCommand('BRS-TEST-6', command);
    expect(feedback?.status).toBe('awaiting_confirmation');

    const followUp = confirmBrowserConversationCandidate('BRS-TEST-6', 'どっちだっけ');
    expect(followUp?.feedback.status).toBe('awaiting_confirmation');
    expect(followUp?.feedback.message).toContain('番号か「それ」で指定');
  });

  it('falls back to the underlying browser runtime snapshot when the conversation session has no direct snapshot', () => {
    safeMkdir(snapshotDir, { recursive: true });
    safeWriteFile(
      `${snapshotDir}/presence-demo.json`,
      JSON.stringify({
        session_id: 'presence-demo',
        tab_id: 'tab-2',
        url: 'https://example.com',
        title: 'Example Domain',
        captured_at: new Date().toISOString(),
        elements: [
          { ref: '@e1', role: null, text: 'Learn more', name: 'Learn more' },
        ],
      }, null, 2),
    );

    const session = createBrowserConversationSession({
      sessionId: 'BCS-presence-presence-demo',
      surface: 'presence',
      goal: {
        summary: 'Example Domain',
        success_condition: 'Click the requested link safely.',
      },
      target: {
        app: 'browser',
        browser_session_id: 'presence-demo',
        tab_id: 'tab-2',
      },
    });
    saveBrowserConversationSession(session);

    const resolution = classifyBrowserConversationCommand('Learn more を押して')!;
    const command = createBrowserConversationCommand({
      sessionId: 'BCS-presence-presence-demo',
      utterance: 'Learn more を押して',
      resolution,
    });

    const feedback = applyBrowserConversationCommand('BCS-presence-presence-demo', command);
    const loaded = loadBrowserConversationSession('BCS-presence-presence-demo');

    expect(feedback?.message).toContain('Learn more');
    expect(loaded?.candidate_targets).toHaveLength(1);
    expect(loaded?.candidate_targets[0]?.element_id).toBe('@e1');
  });
});
