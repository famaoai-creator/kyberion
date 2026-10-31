// Pure helpers for the Kyberion → extension pull mailbox (受信) and the
// page → Kyberion send form (送信). No chrome.* calls and no DOM access, so the
// same file is loaded as a classic script by the Side Panel and imported for
// its side effect by the service worker (background.js), and is unit-testable.
//
// Invariants this module encodes:
// - observe_tab is never auto-answered; only local_infer may be (per-session
//   opt-in, default off).
// - approval_pending notifications are display-only: they expose the CLI
//   approve command, never an approve control.
// - WebMCP tool discovery keeps names, descriptions and input-schema keys only.
// - Page inspections reach the CLI only through the native host
//   (submit_inspection) — never a loopback HTTP port — without input values.
(function (global) {
  const REQUEST_ID_PATTERN = /^BBR-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const MAX_WEBMCP_TOOLS = 50;
  const MAX_WEBMCP_INPUT_KEYS = 32;
  const SEND_MAX_TEXT = 30_000;
  const SEND_MAX_TITLE = 300;
  const SEND_MAX_NOTE = 1_000;
  const TENANT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
  // Mirrors INSPECTION_LIMITS in scripts/lib/browser-inspection-handoff.ts.
  const INSPECT_LIMITS = {
    title: 300,
    headings: 30,
    inputs: 40,
    buttons: 40,
    links: 40,
    excerpt: 1_000,
  };

  const KIND_LABELS = {
    observe_tab: 'ページ観測の依頼',
    local_infer: 'ローカル推論の依頼',
    notify: 'お知らせ',
  };
  // Level/risk are always spelled out in text — never conveyed by colour alone.
  const LEVEL_LABELS = {
    info: '情報',
    progress: '進捗',
    approval_pending: '承認待ち',
  };
  const RISK_LABELS = {
    low: '低リスク',
    medium: '中リスク',
    high: '高リスク',
    critical: '最重要リスク',
  };
  const TASK_LABELS = {
    summarize: '要約',
    classify: '分類',
    extract: '構造化抽出',
    translate: '翻訳',
    detect_language: '言語判定',
    proofread: '校正',
    rewrite: '書き換え',
    write: '文章作成',
  };

  function timeOf(value) {
    const ms = Date.parse(String(value || ''));
    return Number.isFinite(ms) ? ms : NaN;
  }

  function isExpired(item, now = Date.now()) {
    const expires = timeOf(item?.expires_at);
    return !Number.isFinite(expires) || expires <= now;
  }

  function isValidRequestId(value) {
    return REQUEST_ID_PATTERN.test(String(value || ''));
  }

  /** Items that need a person's decision: observe/infer requests and approval notices. */
  function isActionable(item) {
    if (!item) return false;
    if (item.request_kind === 'observe_tab' || item.request_kind === 'local_infer') return true;
    return item.request_kind === 'notify' && item.payload?.level === 'approval_pending';
  }

  function badgeCount(requests) {
    return (requests || []).filter(isActionable).length;
  }

  /** Only local_infer may be answered without a click, and only when opted in. */
  function shouldAutoRespond(item, autoLocalInfer) {
    return autoLocalInfer === true && item?.request_kind === 'local_infer';
  }

  function approveCommand(approvalRequestId) {
    const id = String(approvalRequestId || '');
    return APPROVAL_ID_PATTERN.test(id) ? `pnpm kyberion approvals --approve ${id}` : null;
  }

  function remainingLabel(expiresAt, now = Date.now()) {
    const expires = timeOf(expiresAt);
    if (!Number.isFinite(expires) || expires <= now) return '期限切れ';
    const seconds = Math.ceil((expires - now) / 1000);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return minutes > 0 ? `あと ${minutes} 分 ${rest} 秒` : `あと ${rest} 秒`;
  }

  function requesterLabel(item) {
    const actor = String(item?.requested_by?.actor_id || '不明');
    const mission = item?.requested_by?.mission_id ? ` / ${item.requested_by.mission_id}` : '';
    return `${actor}${mission}`;
  }

  function scopeLabel(item) {
    const tier = String(item?.scope?.tier || '');
    return item?.scope?.tenant_slug ? `${tier} / ${item.scope.tenant_slug}` : tier;
  }

  /**
   * View model for an inbox card. `controls` is the closed set of buttons the
   * Side Panel may render for the item:
   *   respond      — 「許可して応答」(observe_tab, local_infer)
   *   decline      — 「拒否」(observe_tab, local_infer)
   *   acknowledge  — 「確認」(notify info / progress)
   *   copy_command — 承認コマンドをコピー (notify approval_pending)
   *   dismiss      — 表示を閉じる (local only; never answers the request)
   */
  function describeRequest(item, now = Date.now()) {
    const kind = item?.request_kind;
    const payload = item?.payload || {};
    const base = {
      request_id: String(item?.request_id || ''),
      kind,
      kindLabel: KIND_LABELS[kind] || String(kind || ''),
      requester: requesterLabel(item),
      scope: scopeLabel(item),
      expiresAt: item?.expires_at || null,
      remaining: remainingLabel(item?.expires_at, now),
      actionable: isActionable(item),
      lines: [],
      controls: [],
      command: null,
    };
    if (kind === 'observe_tab') {
      const origins = Array.isArray(payload.allowed_origins) ? payload.allowed_origins : [];
      base.title = String(payload.purpose || '目的が指定されていません');
      base.lines.push(
        `取得内容: ${payload.mode === 'structure' ? 'ページ構造（見出し・入力欄・ボタン・リンク）' : 'ページ本文（PII 除去済み）'}`,
        `対象サイト: ${origins.length ? origins.join(', ') : '接続中のタブ（制限なし）'}`
      );
      base.controls = ['respond', 'decline'];
    } else if (kind === 'local_infer') {
      base.title = `${TASK_LABELS[payload.task] || String(payload.task || '')}（Chrome 内蔵 AI）`;
      const input = String(payload.input || '');
      base.lines.push(`入力: ${input.length.toLocaleString('ja-JP')} 文字（この端末内で処理）`);
      base.controls = ['respond', 'decline'];
    } else if (kind === 'notify') {
      const level = payload.level;
      base.level = level;
      base.levelLabel = LEVEL_LABELS[level] || String(level || '');
      base.title = String(payload.title || '');
      if (payload.body) base.lines.push(String(payload.body));
      if (payload.progress && Number.isFinite(payload.progress.total)) {
        base.lines.push(`進捗: ${payload.progress.done} / ${payload.progress.total}`);
      }
      if (payload.mission_id) base.lines.push(`ミッション: ${payload.mission_id}`);
      if (level === 'approval_pending') {
        // Display-only: deciding stays on the authenticated approval path.
        base.command = approveCommand(payload.approval_request_id);
        base.controls = base.command ? ['copy_command', 'dismiss'] : ['dismiss'];
      } else {
        base.controls = ['acknowledge'];
      }
    } else {
      base.title = '未対応の依頼';
      base.controls = ['decline'];
    }
    return base;
  }

  /** Read-only approval summary card (from poll_requests `approvals`). */
  function describeApproval(approval) {
    return {
      request_id: String(approval?.request_id || ''),
      title: String(approval?.title || ''),
      riskLabel: RISK_LABELS[approval?.risk] || `リスク: ${String(approval?.risk || '不明')}`,
      command:
        typeof approval?.approve_command === 'string' &&
        /^pnpm kyberion approvals --approve [A-Za-z0-9_.:-]+$/.test(approval.approve_command)
          ? approval.approve_command
          : approveCommand(approval?.request_id),
      controls: ['copy_command'],
    };
  }

  function stableSignature(value) {
    try {
      return JSON.stringify(value ?? null);
    } catch {
      return '';
    }
  }

  function canonicalOrigin(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  function scrubWith(scrub, value, max) {
    if (typeof scrub !== 'function') return '';
    return String(scrub(String(value ?? '')))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }

  /**
   * Normalise the MAIN-world WebMCP probe output on the isolated side:
   * names/descriptions/input keys only, scrubbed, at most 50 tools.
   */
  function sanitizeWebMcpTools(raw, scrub) {
    const list = Array.isArray(raw) ? raw : [];
    const tools = [];
    for (const entry of list) {
      if (tools.length >= MAX_WEBMCP_TOOLS) break;
      if (!entry || typeof entry !== 'object') continue;
      const name = scrubWith(scrub, entry.name, 120);
      if (!name) continue;
      const description = scrubWith(scrub, entry.description, 500);
      const keys = Array.isArray(entry.input_keys) ? entry.input_keys : [];
      const inputKeys = keys
        .slice(0, MAX_WEBMCP_INPUT_KEYS)
        .map((key) => scrubWith(scrub, key, 80))
        .filter(Boolean);
      tools.push({ name, ...(description ? { description } : {}), input_keys: inputKeys });
    }
    return { tools, truncated: list.length > tools.length };
  }

  /**
   * Validate the Send form and build the native `send_page` payload. Text
   * must already be scrubbed by the caller; this only enforces shape and the
   * tier/tenant/public-confirm rules (the host enforces them again).
   */
  function buildSendPagePayload(form) {
    const errors = [];
    const mode = form?.mode;
    if (mode !== 'intent' && mode !== 'knowledge') errors.push('送信方法を選んでください。');
    const tier = form?.tier || 'personal';
    if (!['personal', 'confidential', 'public'].includes(tier)) errors.push('保存先が不正です。');
    const tenant = String(form?.tenantSlug || '')
      .trim()
      .toLowerCase();
    if (tier === 'confidential' && !TENANT_SLUG_PATTERN.test(tenant)) {
      errors.push('confidential にはテナント slug（英小文字・数字・ハイフン）が必要です。');
    }
    if (tier === 'public' && form?.confirmPublic !== true) {
      errors.push('public に送るには「公開してよい内容です」の確認が必要です。');
    }
    const urlOrigin = canonicalOrigin(form?.urlOrigin);
    if (!urlOrigin) errors.push('送信元ページの origin を確認できません（http(s) のみ）。');
    const text = String(form?.text || '').trim();
    if (!text) errors.push('送る本文がありません。');
    if (text.length > SEND_MAX_TEXT) errors.push('本文は 30,000 文字までです。');
    const note = String(form?.note || '').trim();
    if (note.length > SEND_MAX_NOTE) errors.push('メモは 1,000 文字までです。');
    if (mode === 'intent' && !note && !String(form?.title || '').trim()) {
      errors.push('intent として送るには、やりたいことをメモに書いてください。');
    }
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      errors: [],
      payload: {
        type: 'send_page',
        mode,
        tier,
        ...(tier === 'confidential' ? { tenant_slug: tenant } : {}),
        ...(tier === 'public' ? { confirm_public: true } : {}),
        title: String(form?.title || '').slice(0, SEND_MAX_TITLE),
        url_origin: urlOrigin,
        text,
        selection_only: form?.selectionOnly === true,
        ...(note ? { note } : {}),
      },
    };
  }

  /**
   * Build the native `submit_inspection` payload from a content-script page
   * inspection: scrubbed, bounded, no input values, and URLs without query
   * strings or fragments. The host validates and redacts again.
   */
  function buildSubmitInspectionPayload(inspection, scrub) {
    if (typeof scrub !== 'function') {
      return { ok: false, errors: ['PII scrubber が読み込まれていません。'] };
    }
    if (!inspection || typeof inspection !== 'object') {
      return { ok: false, errors: ['解析結果がありません。'] };
    }
    const pageUrl = stripQuery(inspection.url);
    if (!pageUrl)
      return { ok: false, errors: ['解析したページの URL が http(s) ではありません。'] };
    const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
    const text = (value, max) => scrubWith(scrub, value, max);
    const optional = (value, max) => {
      const cleaned = text(value, max);
      return cleaned ? cleaned : undefined;
    };
    const payload = {
      type: 'submit_inspection',
      inspection: {
        url: pageUrl.toString(),
        origin: pageUrl.origin,
        title: text(inspection.title, INSPECT_LIMITS.title),
        headings: list(inspection.headings, INSPECT_LIMITS.headings)
          .map((h) => ({ level: String(h?.level || '').toLowerCase(), text: text(h?.text, 200) }))
          .filter((h) => h.text),
        inputs: list(inspection.inputs, INSPECT_LIMITS.inputs).map((input) => ({
          tag: String(input?.tag || '').toLowerCase(),
          ...(input?.type ? { type: String(input.type).toLowerCase().slice(0, 40) } : {}),
          ...(optional(input?.name, 200) ? { name: optional(input.name, 200) } : {}),
          ...(optional(input?.id, 200) ? { id: optional(input.id, 200) } : {}),
          ...(optional(input?.placeholder, 200)
            ? { placeholder: optional(input.placeholder, 200) }
            : {}),
          ...(optional(input?.label, 200) ? { label: optional(input.label, 200) } : {}),
          ...(input?.required === true ? { required: true } : {}),
        })),
        buttons: list(inspection.buttons, INSPECT_LIMITS.buttons)
          .map((button) => ({
            text: text(button?.text, 120),
            ...(optional(button?.id, 200) ? { id: optional(button.id, 200) } : {}),
            ...(optional(button?.className, 80)
              ? { className: optional(button.className, 80) }
              : {}),
            ...(button?.disabled === true ? { disabled: true } : {}),
          }))
          .filter((button) => button.text),
        links: list(inspection.links, INSPECT_LIMITS.links)
          .map((link) => {
            const href = stripQuery(link?.href);
            return { text: text(link?.text, 120), href: href ? href.toString() : '' };
          })
          .filter((link) => link.text && link.href),
        textExcerpt: text(inspection.textExcerpt, INSPECT_LIMITS.excerpt),
      },
    };
    return { ok: true, errors: [], payload };
  }

  function stripQuery(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.search = '';
      url.hash = '';
      url.username = '';
      url.password = '';
      return url;
    } catch {
      return null;
    }
  }

  global.KyberionBridgeInbox = {
    MAX_WEBMCP_TOOLS,
    SEND_MAX_TEXT,
    isExpired,
    isValidRequestId,
    isActionable,
    badgeCount,
    shouldAutoRespond,
    approveCommand,
    remainingLabel,
    describeRequest,
    describeApproval,
    stableSignature,
    canonicalOrigin,
    sanitizeWebMcpTools,
    buildSendPagePayload,
    buildSubmitInspectionPayload,
  };
})(globalThis);
