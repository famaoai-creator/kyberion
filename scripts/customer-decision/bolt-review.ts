/**
 * CD-10 bolt review: `bolt-review` (draft the review agenda of a finished
 * mission) and the routing of the customer's answer after respond / status.
 * Part of scripts/customer_decision.ts (the entry point); see its header.
 *
 * The operator chooses what the customer sees (the summary, the screenshots,
 * a public preview URL); nothing is taken from mission evidence, which mixes
 * in internal information. The draft then goes through the usual `submit`
 * (approval gate) and `send`.
 */
import { logger } from '@agent/core/core';
import { assertSafeRepositoryPath, safeReadFile, safeStat } from '@agent/core/secure-io';
import { CUSTOMER_SLUG_PATTERN, type DecisionLedgerLocation } from '@agent/core/decision-ledger';
import {
  BOLT_MISSION_ID_PATTERN,
  BOLT_REVIEW_ENTRY_ID,
  BOLT_REVIEW_TEMPLATE_ID,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_ENTRY,
  agendaContentHash,
  boltMilestone,
  boltReviewItem,
  boltRoutingTargets,
  instantiateTemplate,
  isBoltTargetRouted,
  linkProblem,
  listReceipts,
  loadDecisionTemplate,
  newAgendaId,
  readAgenda,
  resolveVocabularyText,
  withCustomerDecisionCaseLock,
  writeAgenda,
  writeAgendaAttachment,
  type AgendaAttachment,
  type AgendaEntry,
  type AgendaLink,
  type BoltReviewRouting,
  type DecisionAgenda,
} from '@agent/core/customer-decision';
import {
  resolveMissionDecisionCase,
  SWEEP_LOCK_TIMEOUT_MS,
} from '@agent/core/mission/mission-decision-lock';
import {
  fileBoltReviewWorkItem,
  notifyBoltReviewRejected,
} from '@agent/core/mission/mission-bolt-review';
import { ScriptExitError } from '../lib/harness.js';
import {
  type CustomerDecisionIo,
  agendaSummary,
  asLedgerWriter,
  assertNoOpenAgendaOverlap,
  assertUniqueEntries,
  audit,
  diagnosticCode,
  locationOf,
  memberActorId,
  readRepoText,
  requireOpt,
  tenantOf,
  usageError,
  withCaseLock,
} from './common.js';

const MAX_SUMMARY_CHARS = 8000;

function readAttachmentFile(file: string): { name: string; bytes: Buffer } {
  const safe = assertSafeRepositoryPath(file);
  let size: number;
  try {
    size = safeStat(safe).size;
  } catch {
    throw new ScriptExitError(2, `attachment not found: ${file}`);
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new ScriptExitError(
      2,
      `attachment ${file} is ${size} bytes; at most ${MAX_ATTACHMENT_BYTES} bytes per image`
    );
  }
  return { name: file, bytes: safeReadFile(safe, { encoding: null, maxSizeMB: 1 }) as Buffer };
}

function previewLinks(opts: Record<string, string>, locale: 'ja' | 'en'): AgendaLink[] {
  const url = opts['preview-url']?.trim();
  if (!url) return [];
  const problem = linkProblem(url);
  if (problem) {
    throw usageError(
      `--preview-url refused (${problem}): only a public https URL may be shown to a customer — never localhost, a private address or an internal host name`
    );
  }
  return [
    {
      label: resolveVocabularyText('customer_decision:bolt_review_preview_link_label', locale),
      url,
    },
  ];
}

/** The mission must exist and belong to this tenant's case. */
function assertMissionInCase(
  io: CustomerDecisionIo,
  missionId: string,
  tenant: string,
  caseId: string
): void {
  const resolved = io.missionCase
    ? io.missionCase(missionId)
    : resolveMissionDecisionCase(missionId);
  if (!resolved) {
    throw new ScriptExitError(
      2,
      `mission ${missionId} was not found or has no decision case (its project, or a deal listing it)`
    );
  }
  if (resolved.tenantSlug !== tenant || resolved.caseId !== caseId) {
    throw new ScriptExitError(2, `mission ${missionId} does not belong to case ${caseId}`);
  }
}

/**
 * `bolt-review`: a draft agenda from the `bolt-review` template — one
 * `approval` entry ("do you accept the results of this bolt?"), the summary
 * as its background, our decision "accept", the override window open until
 * the next bolt starts (`bolt-after:<MISSION>`), the images and the preview
 * link. Submit and send it as any agenda.
 */
export function runBoltReview(
  opts: Record<string, string>,
  lists: Record<string, string[]>,
  io: CustomerDecisionIo,
  now: string
): unknown {
  const tenant = tenantOf(opts);
  const caseId = requireOpt(opts, 'case');
  const location = locationOf(opts, caseId);
  const missionId = requireOpt(opts, 'mission').toUpperCase();
  if (!BOLT_MISSION_ID_PATTERN.test(missionId)) throw usageError('--mission must be a mission id');
  const customer = requireOpt(opts, 'customer');
  if (!CUSTOMER_SLUG_PATTERN.test(customer)) throw usageError('--customer must be a customer slug');
  // i18n-exempt: validates the --locale flag against the agenda schema's ja|en enum, not a UI branch
  const locale = opts.locale === 'en' ? 'en' : 'ja';
  const summary = readRepoText(requireOpt(opts, 'summary-file'), 'summary file').trim();
  if (!summary) throw usageError('--summary-file is empty');
  if (summary.length > MAX_SUMMARY_CHARS)
    throw usageError(`--summary-file is longer than ${MAX_SUMMARY_CHARS} characters`);
  const files = lists.attach ?? [];
  if (files.length > MAX_ATTACHMENTS_PER_ENTRY)
    throw usageError(`at most ${MAX_ATTACHMENTS_PER_ENTRY} --attach images`);
  const links = previewLinks(opts, locale);
  const by = opts.by ? memberActorId(opts.by) : undefined;
  assertMissionInCase(io, missionId, tenant, caseId);
  const images = files.map(readAttachmentFile);

  return withCaseLock(location, () => {
    const attachments: AgendaAttachment[] = [];
    for (const image of images) {
      let stored: AgendaAttachment;
      try {
        stored = asLedgerWriter(tenant, () =>
          writeAgendaAttachment(location, image.name, image.bytes)
        );
      } catch (error) {
        throw new ScriptExitError(
          2,
          `attachment ${image.name} refused — ${diagnosticCode(error)} | only png, jpeg or webp images up to ${MAX_ATTACHMENT_BYTES} bytes, with a matching file extension`
        );
      }
      if (!attachments.some((item) => item.id === stored.id)) attachments.push(stored);
    }
    const template = loadDecisionTemplate(BOLT_REVIEW_TEMPLATE_ID);
    const drafted = instantiateTemplate(template, {
      agendaId: newAgendaId(),
      tenantSlug: tenant,
      caseId,
      customer,
      locale,
      now,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.from?.trim() ? { from: opts.from.trim() } : {}),
      ...(opts.project ? { projectId: opts.project } : {}),
    });
    const entries = drafted.entries.map((entry): AgendaEntry =>
      entry.entry_id !== BOLT_REVIEW_ENTRY_ID
        ? entry
        : {
            ...entry,
            item: boltReviewItem(missionId),
            background: `${entry.background ?? ''}\n\n${summary}`.trim(),
            our_decision: { value: { approved: true } },
            override_until: { kind: 'milestone', milestone: boltMilestone(missionId) },
            ...(attachments.length ? { attachments } : {}),
            ...(links.length ? { links } : {}),
          }
    );
    const agenda: DecisionAgenda = { ...drafted, entries, bolt_mission_id: missionId };
    assertUniqueEntries(agenda.entries);
    assertNoOpenAgendaOverlap(location, tenant, agenda.agenda_id, agenda.entries);
    const written = asLedgerWriter(tenant, () => writeAgenda(location, agenda));
    audit(tenant, 'bolt_review_draft', {
      agenda_id: written.agenda_id,
      case_id: caseId,
      mission_id: missionId,
      attachments: attachments.length,
      links: links.length,
      content_hash: agendaContentHash(written),
      ...(by ? { drafted_by: by } : {}),
    });
    return {
      ...agendaSummary(written),
      bolt_mission_id: missionId,
      attachments: attachments.length,
      links: links.length,
      next: `pnpm kyberion customer-decision submit --tenant ${tenant} --case ${caseId} --agenda ${written.agenda_id} --by user:<member>`,
    };
  });
}

export interface BoltRoutingSummary {
  routed: number;
  /** Targets that could not be routed this time (the next respond / status retries). */
  pending: number;
}

/**
 * Route the customer's bolt-review answers of one agenda: `request_changes` →
 * one backlog WorkItem, `reject` → the operator (inbox entry + notification).
 * Idempotent (deterministic ids, recorded on the agenda's `bolt_routing`), so
 * respond and status both run it. Waits briefly for the case lock and never
 * throws — the customer's response is already recorded.
 */
export function routeBoltReview(
  tenant: string,
  location: DecisionLedgerLocation,
  agendaId: string,
  now: string
): BoltRoutingSummary {
  const summary: BoltRoutingSummary = { routed: 0, pending: 0 };
  try {
    withCustomerDecisionCaseLock(
      location,
      () => {
        const agenda = asLedgerWriter(tenant, () => readAgenda(location, agendaId));
        if (!agenda?.bolt_mission_id) return;
        const missionId = agenda.bolt_mission_id;
        const receipts = asLedgerWriter(tenant, () => listReceipts(location, { agendaId }));
        const routing: BoltReviewRouting[] = [...(agenda.bolt_routing ?? [])];
        const pending = boltRoutingTargets(agenda, receipts).filter(
          (target) => !isBoltTargetRouted(target, routing)
        );
        if (pending.length === 0) return;
        for (const target of pending) {
          const input = {
            tenantSlug: tenant,
            caseId: agenda.case_id,
            agendaId,
            entryId: target.entry_id,
            ref: target.ref,
            missionId,
            ...(agenda.project_id ? { projectId: agenda.project_id } : {}),
          };
          try {
            const record: BoltReviewRouting =
              target.outcome === 'request_changes'
                ? { ...target, work_item_id: fileBoltReviewWorkItem(input), at: now }
                : {
                    ...target,
                    inbox_entry_id: notifyBoltReviewRejected(input).inbox_entry_id,
                    notified_at: now,
                    at: now,
                  };
            const index = routing.findIndex(
              (entry) => entry.entry_id === target.entry_id && entry.ref === target.ref
            );
            if (index >= 0) routing[index] = record;
            else routing.push(record);
            summary.routed += 1;
          } catch (error) {
            summary.pending += 1;
            logger.warn(
              `bolt review routing skipped — ${diagnosticCode(error)} | the customer's answer is recorded; run customer-decision status --agenda ${agendaId} to retry | outcome=${target.outcome} ref=${target.ref}`
            );
          }
        }
        if (summary.routed === 0) return;
        asLedgerWriter(tenant, () =>
          writeAgenda(location, { ...agenda, bolt_routing: routing, updated_at: now })
        );
        audit(tenant, 'bolt_review_route', {
          agenda_id: agendaId,
          case_id: agenda.case_id,
          mission_id: missionId,
          routed: routing.map((entry) => ({
            entry_id: entry.entry_id,
            ref: entry.ref,
            outcome: entry.outcome,
            ...(entry.work_item_id ? { work_item_id: entry.work_item_id } : {}),
            ...(entry.inbox_entry_id ? { inbox_entry_id: entry.inbox_entry_id } : {}),
          })),
        });
      },
      SWEEP_LOCK_TIMEOUT_MS
    );
  } catch (error) {
    logger.warn(
      `bolt review routing skipped — ${diagnosticCode(error)} | the customer's answer is recorded; run customer-decision status --agenda ${agendaId} to retry | agenda=${agendaId}`
    );
  }
  return summary;
}

/** The `status` view of a bolt review: the reviewed mission, its milestone and where answers went. */
export function boltReviewStatus(agenda: DecisionAgenda): Record<string, unknown> | undefined {
  if (!agenda.bolt_mission_id) return undefined;
  const milestone = boltMilestone(agenda.bolt_mission_id);
  return {
    mission_id: agenda.bolt_mission_id,
    milestone,
    next_bolt_started: (agenda.milestones_passed ?? []).includes(milestone),
    routing: (agenda.bolt_routing ?? []).map((entry) => ({
      entry_id: entry.entry_id,
      ref: entry.ref,
      outcome: entry.outcome,
      ...(entry.work_item_id ? { work_item_id: entry.work_item_id } : {}),
      ...(entry.inbox_entry_id ? { inbox_entry_id: entry.inbox_entry_id } : {}),
      notified: Boolean(entry.notified_at),
      at: entry.at,
    })),
  };
}
