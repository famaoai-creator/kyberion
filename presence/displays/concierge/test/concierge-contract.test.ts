/* eslint-disable no-restricted-imports */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('concierge surface contract', () => {
  it('declares its role tagline in the layout header', () => {
    const layout = fs.readFileSync(path.join(appDir, 'src/app/layout.tsx'), 'utf8');
    const header = fs.readFileSync(path.join(appDir, 'src/app/concierge-header.tsx'), 'utf8');
    expect(layout).toContain('ConciergeHeader');
    expect(header).toContain("t('header.tagline')");
    expect(header).toContain("locale === 'ja' ? '秘書室' : 'Concierge'");
  });

  it('guards every mutating route with the shared surface mutation guard', () => {
    const mutatingRoutes = [
      'src/app/api/approvals/[id]/route.ts',
      'src/app/api/outcomes/[id]/route.ts',
      'src/app/api/setup/route.ts',
      'src/app/api/notification-preferences/route.ts',
      'src/app/api/message/route.ts',
      'src/app/api/voice/listen-once/route.ts',
      'src/app/api/voice/stop/route.ts',
      'src/app/api/hygiene/[id]/route.ts',
      'src/app/api/ingest/route.ts',
      'src/app/api/memory-queue/[id]/route.ts',
      'src/app/api/plugins/[id]/route.ts',
      'src/app/api/config-missions/route.ts',
    ];
    for (const route of mutatingRoutes) {
      const source = fs.readFileSync(path.join(appDir, route), 'utf8');
      expect(source, route).toContain('requireConciergeMutationAccess');
    }
  });

  it('exposes the personal-secretary onboarding controls', () => {
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const setupRoute = fs.readFileSync(path.join(appDir, 'src/app/api/setup/route.ts'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );
    expect(setupPage).toContain("t('setup.save_profile')");
    expect(setupPage).toContain("t('setup.image_label')");
    expect(setupPage).toContain("t('setup.save_voice')");
    expect(setupPage).toContain('getUserMedia');
    expect(setupPage).toContain('MediaRecorder');
    expect(setupPage).toContain("t('setup.capture_avatar')");
    expect(setupPage).toContain("t('setup.camera_fallback')");
    expect(setupPage).toContain("t('setup.services_title')");
    expect(setupPage).toContain("t('setup.management_title')");
    expect(setupPage).toContain("action: 'save_management'");
    expect(messages).toContain('プロフィールと接続準備を保存');
    expect(messages).toContain('アバター画像');
    expect(messages).toContain('音声プロフィールを登録');
    expect(messages).toContain('撮影してアバターを作成');
    expect(messages).toContain('マイクで録音');
    expect(setupRoute).toContain('applyBrowserOnboarding');
    expect(setupRoute).toContain('writeTenantProfile');
    expect(setupRoute).toContain('listAgentIdentities');
    expect(setupRoute).toContain("action === 'save_management'");
    expect(setupRoute).toContain('saveBrowserOnboardingVoiceSample');
    expect(setupRoute).toContain("action === 'avatar'");
  });

  it('keeps GET routes free of mutations (summary/theme are read-only)', () => {
    for (const route of [
      'src/app/api/summary/route.ts',
      'src/app/api/theme/route.ts',
      'src/app/api/response-status/route.ts',
      'src/app/api/events/route.ts',
      'src/app/api/voice/status/route.ts',
      'src/app/api/hygiene/route.ts',
      'src/app/api/outcomes/[id]/preview/route.ts',
      'src/app/api/memory-queue/route.ts',
      'src/app/api/plugins/route.ts',
    ]) {
      const source = fs.readFileSync(path.join(appDir, route), 'utf8');
      expect(source, route).not.toMatch(/export (async )?function (POST|PUT|DELETE|PATCH)/);
    }
  });

  it('implements the CS-01 conversation core with the two-path failover', () => {
    const route = fs.readFileSync(path.join(appDir, 'src/app/api/message/route.ts'), 'utf8');
    expect(route).toContain('requireConciergeMutationAccess');
    // Primary path: voice-hub ingest with a bounded timeout so the UI never hangs.
    expect(route).toContain('/api/ingest-text');
    expect(route).toContain('AbortSignal.timeout');
    // Fallback path: lazy orchestrator import (no second daemon required).
    expect(route).toContain("import('@agent/core/channel-surface')");
    expect(route).toContain('runSurfaceMessageConversation');
    // Both paths failing must produce a loud, actionable 503 — never silence.
    expect(route).toContain("mode: 'unavailable'");
    expect(route).toContain('503');
  });

  it('streams summary changes over SSE with heartbeat and abort cleanup', () => {
    const route = fs.readFileSync(path.join(appDir, 'src/app/api/events/route.ts'), 'utf8');
    expect(route).toContain('buildCeoSurfaceSummary');
    expect(route).toContain('text/event-stream');
    expect(route).toContain('heartbeat');
    expect(route).toContain("addEventListener('abort'");
  });

  it('replaces window.prompt and 30 s summary polling on the home page', () => {
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    expect(page).not.toContain('window.prompt');
    expect(page).toContain("t('home.change_send')");
    expect(page).toContain("new EventSource('/api/events')");
  });

  it('mounts the conversation dock through the shared i18n mechanism', () => {
    const dock = fs.readFileSync(path.join(appDir, 'src/app/conversation-dock.tsx'), 'utf8');
    const layout = fs.readFileSync(path.join(appDir, 'src/app/layout.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );
    expect(layout).toContain('ConversationDock');
    expect(dock).toContain('useConciergeI18n');
    expect(dock).toContain("fetch('/api/message'");
    // The four UX-contract conversation shapes render as labeled cards.
    expect(dock).toContain('execution_preview');
    expect(messages).toContain('dock.shape.clarification');
    expect(messages).toContain('dock.shape.execution_preview');
    expect(messages).toContain('dock.shape.status_summary');
    expect(messages).toContain('dock.shape.delivery_summary');
    // ceo-ux.md: no internal execution vocabulary in dock copy.
    expect(dock).not.toMatch(/actuator|pipeline|ADF/i);
  });

  it('implements the CS-02 voice tiers with guarded proxies and Tier-0 fallback', () => {
    const status = fs.readFileSync(path.join(appDir, 'src/app/api/voice/status/route.ts'), 'utf8');
    const listenOnce = fs.readFileSync(
      path.join(appDir, 'src/app/api/voice/listen-once/route.ts'),
      'utf8'
    );
    const stop = fs.readFileSync(path.join(appDir, 'src/app/api/voice/stop/route.ts'), 'utf8');
    const hook = fs.readFileSync(path.join(appDir, 'src/lib/use-voice.ts'), 'utf8');
    const dock = fs.readFileSync(path.join(appDir, 'src/app/conversation-dock.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // Tier detection: bounded /health probe that degrades to available:false
    // instead of throwing — the dock must work with voice-hub down.
    expect(status).toContain('/health');
    expect(status).toContain('AbortSignal.timeout');
    expect(status).toContain('available: false');
    // The mutating proxies forward to the real voice-hub endpoints and are
    // guarded like every other write route.
    expect(listenOnce).toContain('requireConciergeMutationAccess');
    expect(listenOnce).toContain('/api/listen-once');
    expect(listenOnce).toContain('AbortSignal.timeout');
    expect(stop).toContain('requireConciergeMutationAccess');
    expect(stop).toContain('/api/stop-speaking');
    // Tier 0 lives in the hook: browser SpeechRecognition (webkit fallback)
    // for input, speechSynthesis for output, persisted output preference.
    expect(hook).toContain('webkitSpeechRecognition');
    expect(hook).toContain('speechSynthesis');
    expect(hook).toContain("fetch('/api/voice/status')");
    expect(hook).toContain('localStorage');
    expect(hook).toContain("fetch('/api/voice/listen-once'");
    expect(hook).toContain("fetch('/api/voice/stop'");
    // The dock wires the hook: mic button with pressed state, and voice-hub
    // replies are never spoken twice by the browser.
    expect(dock).toContain('useVoice');
    expect(dock).toContain('aria-pressed');
    expect(dock).toContain("payload.mode === 'voice-hub'");
    expect(dock).toContain('notifyServerSpeech');
    expect(messages).toContain('dock.voice.no_transcript');
    expect(messages).toContain('dock.voice.stop_speaking');
  });

  it('renders actionable setup diagnostics that jump to in-page sections (CS-03)', () => {
    const setupRoute = fs.readFileSync(path.join(appDir, 'src/app/api/setup/route.ts'), 'utf8');
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );
    // Every incomplete item carries a machine-actionable navigate descriptor.
    expect(setupRoute).toContain('diagnostics');
    expect(setupRoute).toContain("type: 'navigate'");
    expect(setupRoute).toContain("target: '#setup-");
    // The page renders the checklist and attention items jump to their section.
    expect(setupPage).toContain("t('setup.readiness_title')");
    expect(setupPage).toContain('scrollIntoView');
    for (const anchor of [
      'setup-profile',
      'setup-media',
      'setup-services',
      'setup-notifications',
    ]) {
      expect(setupPage).toContain(`id="${anchor}"`);
    }
    // ceo-ux.md: items with an in-app section no longer print shell commands,
    // and pipeline IDs are not exposed as UI copy.
    expect(setupPage).not.toContain('setup.device_command');
    expect(setupPage).not.toContain('setup.pipeline');
    expect(setupRoute).not.toContain('pnpm surfaces:status');
    expect(setupRoute).not.toContain('schedule-summary-and-coordination');
    // Honest degradation: the reasoning backend has no in-app fix, so the
    // terminal command survives — as guidance-first, visually secondary copy.
    expect(setupRoute).toContain('pnpm reasoning:setup');
    expect(setupPage).toContain("'setup.reasoning_guidance'");
    expect(setupPage).toContain("t('setup.reasoning_command_hint'");
    expect(setupPage).toContain('readiness-command');
    expect(messages).toContain('整備状況');
  });

  it('routes notification channel settings through the guarded preferences API (CS-03)', () => {
    const route = fs.readFileSync(
      path.join(appDir, 'src/app/api/notification-preferences/route.ts'),
      'utf8'
    );
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );
    // Preferences load/save reuse the @agent/core operator-notifications
    // helpers under the sovereign_concierge execution context.
    expect(route).toContain('loadNotificationPreferences');
    expect(route).toContain('saveNotificationPreferences');
    expect(route).toContain("withExecutionContext('sovereign_concierge'");
    expect(route).toContain('withSensitivePathMediation');
    // Channel candidates come from the shared channel directory, and the
    // POST validates the surface against it before saving.
    expect(route).toContain('listChannelDirectoryEntries');
    expect(route).toContain('requireConciergeMutationAccess');
    expect(route).not.toMatch(/export (async )?function (PUT|DELETE|PATCH)/);
    // The setup page exposes the section and reports it in the checklist.
    expect(setupPage).toContain("t('setup.notifications_title')");
    expect(setupPage).toContain("fetch('/api/notification-preferences'");
    expect(messages).toContain('通知設定を保存');
  });

  it('presents stalled missions as inquiry cards where only the human decides (CS-03)', () => {
    const listRoute = fs.readFileSync(path.join(appDir, 'src/app/api/hygiene/route.ts'), 'utf8');
    const decisionRoute = fs.readFileSync(
      path.join(appDir, 'src/app/api/hygiene/[id]/route.ts'),
      'utf8'
    );
    const server = fs.readFileSync(path.join(appDir, 'src/lib/hygiene-server.ts'), 'utf8');
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // Classification comes from the shared hygiene report; the GET is pure
    // read and never touches the mission controller.
    expect(server).toContain('collectMissionHygieneReport');
    expect(listRoute).toContain('listHygieneInquiries');
    expect(listRoute).not.toContain('mission_controller');
    // The report's remediation strings carry CLI commands — they must never
    // reach the client (ceo-ux.md: no internal execution vocabulary).
    expect(server).not.toContain('finding.recommendation');
    expect(server).not.toContain('pnpm');

    // Mission state changes go exclusively through the mission controller
    // (repo invariant), with the controller role and honest exit handling.
    expect(decisionRoute).toContain('requireConciergeMutationAccess');
    expect(decisionRoute).toContain('dist/scripts/mission_controller.js');
    expect(decisionRoute).toContain('safeExecResult');
    expect(decisionRoute).toContain("MISSION_ROLE: 'mission_controller'");
    // Human-only gate: the route accepts nothing but an explicit start/cancel
    // decision from the request body, validates the mission is actually in
    // the hygiene report, and there is no scheduler or auto-invocation path.
    expect(decisionRoute).toContain("['start', 'cancel'] as const");
    expect(decisionRoute).toContain('findHygieneInquiry');
    expect(decisionRoute).not.toMatch(/setInterval|setTimeout/);
    // Exit code 0 alone is not success — the transition is verified on disk.
    expect(decisionRoute).toContain('readMissionStatus');

    // The pane uses an inline confirm step, never the blocking browser dialog.
    // CS-04: the cards moved into the unified inquiry queue; the confirm
    // mechanics (human-only decision) must survive the move.
    expect(page).toContain('renderHygieneCard');
    expect(page).toContain("'hygiene.confirm_start'");
    expect(page).toContain("'hygiene.confirm_cancel'");
    expect(page).not.toContain('window.confirm');
    expect(messages).toContain('ご判断ください(停滞中のご依頼)');
    expect(messages).toContain('開始する');
    expect(messages).toContain('取りやめる');
  });

  it('renders inline artifact previews only from the entry-recorded paths (CS-03 / SU-03)', () => {
    const route = fs.readFileSync(
      path.join(appDir, 'src/app/api/outcomes/[id]/preview/route.ts'),
      'utf8'
    );
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // Path safety: the entry is looked up server-side and only its own
    // artifact_paths are opened — no client-supplied path ever reaches a read.
    expect(route).toContain('listInboxEntries');
    expect(route).toContain('artifact_paths');
    expect(route).not.toContain('searchParams');
    // All reads go through secure-io under the concierge execution context;
    // node:fs never appears (repo invariant).
    expect(route).toContain("withExecutionContext('sovereign_concierge'");
    expect(route).toContain('withSensitivePathMediation');
    expect(route).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    // Bounded output: file count cap, text truncation, and an image size lid.
    expect(route).toContain('MAX_FILES');
    expect(route).toContain('MAX_TEXT_CHARS');
    expect(route).toContain('MAX_IMAGE_BYTES');

    // The outcome card fetches on demand and degrades politely for formats
    // it cannot show inline.
    expect(page).toContain("t('home.preview')");
    expect(page).toContain('/preview');
    expect(page).toContain('data_uri');
    expect(messages).toContain('このファイル形式はここでは表示できません');
    expect(messages).toContain('冒頭のみ表示');
  });

  it('runs document intake as an explicit one-shot ingest ceremony (CS-03)', () => {
    const route = fs.readFileSync(path.join(appDir, 'src/app/api/ingest/route.ts'), 'utf8');
    const page = fs.readFileSync(path.join(appDir, 'src/app/ingest/page.tsx'), 'utf8');
    const header = fs.readFileSync(path.join(appDir, 'src/app/concierge-header.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // The ceremony always goes through the built DA-05 ingest CLI with an
    // explicit identity — anonymous ingests are refused by the script itself.
    expect(route).toContain('requireConciergeMutationAccess');
    expect(route).toContain('dist/scripts/ingest.js');
    expect(route).toContain('--ingested-by');
    expect(route).toContain('safeExecResult');
    expect(route).toContain('--dry-run');
    // Uploads stage under active/shared/tmp (repo temp-file invariant) and are
    // cleaned up best-effort; node:fs never appears (repo invariant).
    expect(route).toContain('active/shared/tmp');
    expect(route).toContain('sharedTmp(');
    expect(route).toContain('safeRmSync');
    expect(route).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    // One explicit upload per ceremony — no scheduler, no auto-retry timer
    // (the deliberate absence of a watch/auto-ingest mode mirrors the CLI).
    expect(route).not.toMatch(/setInterval\(|setTimeout\(/);
    // Exit code 0 alone is not success: the route reads the ceremony's own
    // verdict lines before claiming anything.
    expect(route).toContain('[ingest] DRY RUN');
    expect(route).toContain('[ingest] committed ');
    expect(route).toContain('[ingest] NOT committed');
    // Tenant candidates are validated against the tenant registry.
    expect(route).toContain('listTenantProfileSlugs');

    // The page is a dedicated form: drop zone + picker, tenant select, and a
    // preview-first default (dry-run ON) with an explicit second commit step.
    expect(page).toContain('onDrop');
    expect(page).toContain("t('ingest.drop_hint')");
    expect(page).toContain('setDryRun] = React.useState(true)');
    expect(page).toContain("t('ingest.commit_after_preview')");
    expect(header).toContain("t('header.ingest')");
    expect(messages).toContain('資料の取込');
    expect(messages).toContain('まず内容を確認する');
  });

  it('presents the memory promotion queue for human approval only (CS-03)', () => {
    const listRoute = fs.readFileSync(
      path.join(appDir, 'src/app/api/memory-queue/route.ts'),
      'utf8'
    );
    const decisionRoute = fs.readFileSync(
      path.join(appDir, 'src/app/api/memory-queue/[id]/route.ts'),
      'utf8'
    );
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // The list is a pure read over the shared promotion queue, filtered to
    // undecided candidates; it never touches the mission controller.
    expect(listRoute).toContain('listMemoryPromotionCandidates');
    expect(listRoute).toContain("status === 'queued'");
    expect(listRoute).not.toContain('mission_controller');

    // Decisions go exclusively through scripts/mission_controller.ts (repo
    // invariant), with the controller role and honest exit handling.
    expect(decisionRoute).toContain('requireConciergeMutationAccess');
    expect(decisionRoute).toContain('dist/scripts/mission_controller.js');
    expect(decisionRoute).toContain('memory-approve');
    expect(decisionRoute).toContain('memory-reject');
    expect(decisionRoute).toContain("MISSION_ROLE: 'mission_controller'");
    expect(decisionRoute).toContain('safeExecResult');
    // The candidate must exist and still be pending before anything runs, and
    // exit code 0 alone is not success — the transition is verified on disk.
    expect(decisionRoute).toContain('loadMemoryPromotionCandidate');
    expect(decisionRoute).toContain("candidate.status !== 'queued'");
    expect(decisionRoute).toContain('after?.status !== expected');
    expect(decisionRoute).not.toMatch(/setInterval\(|setTimeout\(/);
    for (const source of [listRoute, decisionRoute]) {
      expect(source).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    }

    // The pane uses inline confirm and translated plain-language labels — the
    // internal kind/tier codes never render verbatim.
    // CS-04: the cards moved into the unified inquiry queue; the confirm
    // mechanics (human-only decision) must survive the move.
    expect(page).toContain('renderMemoryCard');
    expect(page).toContain('memory.kind.');
    expect(page).toContain('memory.tier.');
    expect(page).toContain("'memory.confirm_approve'");
    expect(page).toContain("'memory.confirm_reject'");
    expect(page).not.toContain('window.confirm');
    expect(messages).toContain('記憶にしてよいか(学びの承認)');
    expect(messages).toContain('コツとして残したい学び');
  });

  it('collapses plugin approval into one guarded screen (CS-03)', () => {
    const listRoute = fs.readFileSync(path.join(appDir, 'src/app/api/plugins/route.ts'), 'utf8');
    const decisionRoute = fs.readFileSync(
      path.join(appDir, 'src/app/api/plugins/[id]/route.ts'),
      'utf8'
    );
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // The list reuses the loader's own provenance gate and the managed
    // registry — it can never claim more than the loader would execute, and
    // it never runs plugin code (listing is JSON.parse only, KD-06).
    expect(listRoute).toContain('listManagedPlugins');
    expect(listRoute).toContain('authorizeSkillPlugin');
    expect(listRoute).toContain('readSkillPluginsConfig');
    expect(listRoute).not.toContain('installPluginManaged');

    // The decision route replaces the 3-step CLI ceremony: decide the bound
    // approval request in the shared store, THEN refresh the persisted
    // activation status and report what is now true on disk.
    expect(decisionRoute).toContain('requireConciergeMutationAccess');
    expect(decisionRoute).toContain('loadApprovalRequest');
    expect(decisionRoute).toContain('decideApprovalRequest');
    expect(decisionRoute).toContain('refreshManagedPluginActivation');
    expect(decisionRoute).toContain("decidedByRole: 'sovereign'");
    expect(decisionRoute).toContain("decidedByType: 'human'");
    // Broken manifests stay permanently blocked — approving one is refused.
    expect(decisionRoute).toContain('blocked_broken_manifest');
    for (const source of [listRoute, decisionRoute]) {
      expect(source).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
      expect(source).not.toMatch(/setInterval\(|setTimeout\(/);
    }

    // The setup section shows status chips, decides via inline confirm only,
    // and carries the trust caveat (third-party code runs only after approval).
    expect(setupPage).toContain('id="setup-plugins"');
    expect(setupPage).toContain("t('setup.plugins_caveat')");
    expect(setupPage).toContain("'setup.plugin_confirm_approve'");
    expect(setupPage).toContain("'setup.plugin_confirm_deny'");
    expect(setupPage).not.toContain('window.confirm');
    expect(messages).toContain('稼働可能');
    expect(messages).toContain('承認待ち');
    expect(messages).toContain('破損');
    expect(messages).toContain('ご承認いただくまで一切実行されません');
  });

  it('files governance changes only as governed config missions (CS-03)', () => {
    const route = fs.readFileSync(
      path.join(appDir, 'src/app/api/config-missions/route.ts'),
      'utf8'
    );
    const setupPage = fs.readFileSync(path.join(appDir, 'src/app/setup/page.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // Creation goes exclusively through the built config-mission CLI — the
    // route never writes governance JSON directly, and it never executes the
    // change: 'apply' must not appear anywhere in the route (the GUI stops at
    // filing; the change takes effect only through the governed mission flow).
    expect(route).toContain('requireConciergeMutationAccess');
    expect(route).toContain('dist/scripts/config_mission.js');
    expect(route).toContain('safeExecResult');
    expect(route).toContain('buildExecutionEnv');
    expect(route).not.toContain('apply');
    expect(route).not.toMatch(/from ['"]node:fs['"]|require\(['"]node:fs['"]\)/);
    expect(route).not.toMatch(/setInterval\(|setTimeout\(/);
    // Presets and tenants are validated server-side; argv values are fenced
    // (single key=value elements, leading '-' refused).
    expect(route).toContain('listTenantProfileSlugs');
    expect(route).toContain("value.startsWith('-')");
    // Exit code 0 alone is not success: the CLI's verdict line is parsed and
    // the draft brief is verified on disk before anything is claimed.
    expect(route).toContain('Config mission created:');
    expect(route).toContain("brief.status !== 'draft'");

    // The setup section is preset-picker → declared inputs → inline confirm,
    // and the copy says the change takes effect only after approval.
    expect(setupPage).toContain('id="setup-governance"');
    expect(setupPage).toContain("t('setup.governance_confirm')");
    expect(setupPage).not.toContain('window.confirm');
    expect(messages).toContain('反映はご承認を通ってからになります');
    expect(messages).toContain('変更依頼を起票する');
  });

  it('offers quick-request chips that go through the normal message path (CS-03 方式C)', () => {
    const dock = fs.readFileSync(path.join(appDir, 'src/app/conversation-dock.tsx'), 'utf8');
    const messages = fs.readFileSync(
      path.join(appDir, '../../../knowledge/product/orchestration/user-facing-vocabulary.json'),
      'utf8'
    );

    // The chips only prefill and send text through send() → /api/message —
    // routing stays with the orchestrator, no per-chip special case, and they
    // appear only while the log is still empty.
    expect(dock).toContain("'dock.quick.meeting'");
    expect(dock).toContain("'dock.quick.email'");
    expect(dock).toContain("'dock.quick.calendar'");
    expect(dock).toContain('dock-quick-chip');
    expect(dock).toContain('messages.length === 0');
    expect(dock).toContain('void send(t(key))');
    expect(dock).not.toMatch(/fetch\('\/api\/(meeting|email|calendar)/);
    expect(messages).toContain('会議に参加してほしい');
    expect(messages).toContain('メールの下書きを確認したい');
    expect(messages).toContain('今日の予定を教えて');
  });

  it('surfaces bounded response waiting with a recovery-oriented status panel', () => {
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    const route = fs.readFileSync(
      path.join(appDir, 'src/app/api/response-status/route.ts'),
      'utf8'
    );
    expect(page).toContain("t('home.response_title')");
    expect(page).toContain('/api/response-status');
    expect(route).toContain('listActiveDelegatedTaskRecords');
    expect(route).toContain('peekPersistedDelegationChildrenRegistry');
    expect(route).toContain('staleChildCount');
  });
  it('CS-04: presents one prioritized inquiry queue whose cards are shared with the panes', () => {
    const page = fs.readFileSync(path.join(appDir, 'src/app/page.tsx'), 'utf8');
    // One queue section, ordered by decision urgency, rendered from the same
    // card helpers the detail panes use (no duplicated action UI).
    expect(page).toContain('inquiry-queue');
    expect(page).toContain("t('queue.title')");
    expect(page).toContain('renderApprovalCard');
    expect(page).toContain('renderHygieneCard');
    expect(page).toContain('renderMemoryCard');
    expect(page).toContain('renderOutcomeCard');
    expect(page).toContain('renderExceptionCard');
    // The panes now defer to the queue instead of duplicating the cards.
    expect(page).toContain("t('home.see_queue'");
    expect(page).not.toContain('window.prompt');
  });

  it('CS-04: command palette is keyboard-first, dialog-labelled, and never performs decisions', () => {
    const palette = fs.readFileSync(path.join(appDir, 'src/app/command-palette.tsx'), 'utf8');
    const layout = fs.readFileSync(path.join(appDir, 'src/app/layout.tsx'), 'utf8');
    const css = fs.readFileSync(path.join(appDir, 'src/app/globals.css'), 'utf8');
    expect(layout).toContain('<CommandPalette />');
    expect(palette).toContain('role="dialog"');
    expect(palette).toContain('aria-modal');
    expect(palette).toContain('prefers-reduced-motion');
    // Navigation and dock-opening only — no fetch, no mutation.
    expect(palette).not.toContain('fetch(');
    // Keyboard focus is visible across the surface.
    expect(css).toContain(':focus-visible');
  });
  it('CS-05: the registered surface stays bootable — manifest health route exists and build:ui builds this package', () => {
    // The 2026-07 crash-loop happened because the manifest ran 'next start'
    // while nothing ever built the package. Freeze both halves of the fix.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(appDir, '../../../knowledge/product/governance/surfaces/concierge.json'),
        'utf8'
      )
    );
    const surface = manifest.surfaces.find((entry: { id: string }) => entry.id === 'concierge');
    expect(surface).toBeTruthy();
    expect(surface.healthPath).toBe('/api/summary');
    expect(fs.existsSync(path.join(appDir, 'src/app/api/summary/route.ts'))).toBe(true);
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(appDir, '../../../package.json'), 'utf8')
    );
    expect(rootPackage.scripts['build:ui']).toContain('presence/displays/concierge');
    // CS-05: the legacy Express concierge (port 3033) is gone — one surface,
    // one implementation.
    expect(fs.existsSync(path.join(appDir, 'server.ts'))).toBe(false);
    expect(fs.existsSync(path.join(appDir, 'static'))).toBe(false);
  });
});
