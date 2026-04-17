import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { loadStandardIntentCatalog, resolveIntentResolutionPacket } from './intent-resolution.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

describe('intent-resolution', () => {
  it('resolves implemented task-session and bootstrap intents from their first surface examples', () => {
    const intents = loadStandardIntentCatalog().filter((intent) =>
      ['bootstrap-project', 'generate-presentation', 'generate-report', 'generate-workbook', 'inspect-service', 'cross-project-remediation', 'incident-informed-review', 'evolve-agent-harness'].includes(String(intent.id)),
    );

    for (const intent of intents) {
      const sample = intent.surface_examples?.[0];
      expect(sample, `missing surface example for ${intent.id}`).toBeTruthy();
      const packet = resolveIntentResolutionPacket(String(sample));
      expect(packet.selected_intent_id, `failed to resolve ${intent.id}`).toBe(intent.id);
      expect(packet.selected_confidence || 0, `low confidence for ${intent.id}`).toBeGreaterThan(0.45);
    }
  });

  it('keeps service operations and document intents bound to their catalog resolution', () => {
    const servicePacket = resolveIntentResolutionPacket('voice-hub を再起動して');
    expect(servicePacket.selected_intent_id).toBe('inspect-service');
    expect(servicePacket.selected_resolution?.task_kind).toBe('service_operation');

    const reportPacket = resolveIntentResolutionPacket('今週の進捗レポートを docx で作って');
    expect(reportPacket.selected_intent_id).toBe('generate-report');
    expect(reportPacket.selected_resolution?.task_kind).toBe('report_document');
  });

  it('catalogs capture-photo as a first-class surface intent', () => {
    const packet = resolveIntentResolutionPacket('ちょっと写真をとって');
    expect(packet.selected_intent_id).toBe('capture-photo');
    expect(packet.candidates[0]?.source).not.toBe('legacy');
    expect(packet.selected_resolution?.task_kind).toBe('capture_photo');
  });

  it('emits packets that satisfy the intent-resolution schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const schemaPath = pathResolver.knowledge('public/schemas/intent-resolution-packet.schema.json');
    const validate = compileSchemaFromPath(ajv, schemaPath);
    const packet = resolveIntentResolutionPacket('このエージェントのハーネスを benchmark ベースで改善して');
    const valid = validate(packet);
    expect(valid, JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('applies governed confidence threshold and legacy fallback policy', () => {
    const packet = resolveIntentResolutionPacket('voice-hub の状態とログを見せて');
    expect(packet.selected_intent_id).toBe('inspect-service');
    expect(packet.selected_confidence || 0).toBeGreaterThan(0.45);
    expect(packet.candidates.some((candidate) => candidate.reasons.includes('service operation heuristic'))).toBe(true);
  });
});
