import { classifyTaskSessionIntent } from './task-session.js';

export type ProductivityTaskDomain =
  | 'calendar'
  | 'meeting'
  | 'email'
  | 'document'
  | 'presentation'
  | 'browser'
  | 'connected_systems';

export type ProductivityEffectLevel = 'read' | 'draft' | 'external_write' | 'financial_commit';

export interface ProductivityTaskPlanStep {
  id: string;
  domain: ProductivityTaskDomain;
  title: string;
  effect: ProductivityEffectLevel;
  capability: string;
  approval_required: boolean;
  execution_mode: 'preview_only';
  evidence: string[];
}

export interface ProductivityTaskPlan {
  kind: 'productivity-task-plan';
  version: '1.0.0';
  request: string;
  primary_intent_id?: string;
  domains: ProductivityTaskDomain[];
  steps: ProductivityTaskPlanStep[];
  approval: {
    required: boolean;
    blocked_step_ids: string[];
    reasons: string[];
  };
  missing_inputs: string[];
  recommended_pipeline: string;
  evidence_plan: string[];
  execution: {
    mode: 'dry_run';
    external_effects_executed: false;
  };
}

interface DomainDefinition {
  domain: ProductivityTaskDomain;
  title: string;
  capability: (effect: ProductivityEffectLevel) => string;
  matches: RegExp;
}

const DOMAIN_DEFINITIONS: DomainDefinition[] = [
  {
    domain: 'calendar',
    title: 'Check or coordinate the calendar',
    capability: (effect) =>
      effect === 'external_write' ? 'calendar:create_event' : 'calendar:list_events',
    matches: /(?:カレンダー|予定|日程|スケジュール|空き時間|calendar|schedule|availability)/i,
  },
  {
    domain: 'meeting',
    title: 'Prepare or operate the meeting',
    capability: (effect) => (effect === 'external_write' ? 'meeting:join' : 'meeting:status'),
    matches: /(?:会議|ミーティング|打ち合わせ|議事録|Zoom|Teams|Google Meet|meeting|minutes)/i,
  },
  {
    domain: 'email',
    title: 'Prepare or deliver the email',
    capability: (effect) => (effect === 'external_write' ? 'email:send' : 'email:create_draft'),
    matches: /(?:メール|返信|受信トレイ|Gmail|mail|email|inbox)/i,
  },
  {
    domain: 'document',
    title: 'Create the document draft',
    capability: () => 'media:docx_render',
    matches: /(?:文書|資料|報告書|レポート|議事録|Word|DOCX|document|report)/i,
  },
  {
    domain: 'presentation',
    title: 'Create the presentation draft',
    capability: () => 'media:pptx_render',
    matches: /(?:スライド|プレゼン|パワポ|PPTX|PowerPoint|presentation|deck)/i,
  },
  {
    domain: 'browser',
    title: 'Inspect or operate the browser flow',
    capability: () => 'browser:pipeline',
    matches: /(?:ブラウザ|サイト|Web|URL|購入|決済|予約|申込|checkout|payment|purchase|browser)/i,
  },
  {
    domain: 'connected_systems',
    title: 'Collect information from connected systems',
    capability: () => 'service:preset',
    matches:
      /(?:連携|システム|サービス|情報収集|データ取得|Notion|Slack|Salesforce|Google Drive|Microsoft 365|API|connector|connected system)/i,
  },
];

const FINANCIAL_EFFECT = /(?:決済|支払|購入確定|注文確定|checkout|payment|pay now|place order)/i;
const DRAFT_EFFECT = /(?:下書き|ドラフト|案を作|文面を作|draft|preview)/i;
const MUTATION_EFFECT =
  /(?:送信|送って|登録|追加|変更|削除|更新|リスケ|予約して|申し込|参加して|代理参加|進行して|発言して|send|deliver|create|update|delete|reschedule|book|join|submit)/i;

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function resolveEffect(domain: ProductivityTaskDomain, request: string): ProductivityEffectLevel {
  if (domain === 'browser' && FINANCIAL_EFFECT.test(request)) return 'financial_commit';
  if (domain === 'document' || domain === 'presentation') return 'draft';
  if (domain === 'email' && DRAFT_EFFECT.test(request)) return 'draft';
  if (MUTATION_EFFECT.test(request)) {
    if (domain === 'calendar' || domain === 'meeting' || domain === 'email') {
      return 'external_write';
    }
    if (domain === 'browser' || domain === 'connected_systems') return 'external_write';
  }
  return 'read';
}

function evidenceFor(domain: ProductivityTaskDomain, effect: ProductivityEffectLevel): string[] {
  const evidence = [`${domain}_result`];
  if (effect === 'external_write') evidence.push('approval_id', 'external_effect_receipt');
  if (effect === 'financial_commit') {
    evidence.push('approval_id', 'order_summary', 'payment_receipt', 'post_action_verification');
  }
  return evidence;
}

export function buildProductivityTaskPlan(request: string): ProductivityTaskPlan {
  const normalizedRequest = request.trim();
  if (!normalizedRequest) throw new Error('request is required');

  const classified = classifyTaskSessionIntent(normalizedRequest);
  const matchedDefinitions = DOMAIN_DEFINITIONS.filter((definition) =>
    definition.matches.test(normalizedRequest)
  );
  const definitions =
    matchedDefinitions.length > 0
      ? matchedDefinitions
      : [DOMAIN_DEFINITIONS.find((entry) => entry.domain === 'connected_systems')!];

  const steps = definitions.map((definition, index): ProductivityTaskPlanStep => {
    const effect = resolveEffect(definition.domain, normalizedRequest);
    return {
      id: `step-${String(index + 1).padStart(2, '0')}-${definition.domain}`,
      domain: definition.domain,
      title: definition.title,
      effect,
      capability: definition.capability(effect),
      approval_required: effect === 'external_write' || effect === 'financial_commit',
      execution_mode: 'preview_only',
      evidence: evidenceFor(definition.domain, effect),
    };
  });

  const blockedSteps = steps.filter((step) => step.approval_required);
  const hasFinancialCommit = steps.some((step) => step.effect === 'financial_commit');
  const missingInputs = [...(classified?.requirements?.missing || [])];
  if (blockedSteps.length > 0) missingInputs.push('approval_confirmation');
  if (hasFinancialCommit) missingInputs.push('merchant', 'total_amount', 'payment_limit');

  return {
    kind: 'productivity-task-plan',
    version: '1.0.0',
    request: normalizedRequest,
    primary_intent_id: classified?.intentId,
    domains: definitions.map((definition) => definition.domain),
    steps,
    approval: {
      required: blockedSteps.length > 0,
      blocked_step_ids: blockedSteps.map((step) => step.id),
      reasons: unique(
        blockedSteps.map((step) =>
          step.effect === 'financial_commit'
            ? 'Financial commitment requires explicit human approval.'
            : 'External write requires explicit human approval.'
        )
      ),
    },
    missing_inputs: unique(missingInputs),
    recommended_pipeline:
      'knowledge/product/pipeline-templates/productivity-task-orchestration.json',
    evidence_plan: unique(steps.flatMap((step) => step.evidence)),
    execution: {
      mode: 'dry_run',
      external_effects_executed: false,
    },
  };
}
