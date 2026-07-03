/**
 * Verifies layout/body-zone resolution for each scenario brief.
 * Reads the same JSON files as the runtime, exercises the same logic,
 * and prints a resolution table without building a full PPTX.
 */
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { safeExistsSync, safeReadFile } from '@agent/core';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(moduleDir, '..');

function safeRead(p) {
  return JSON.parse(String(safeReadFile(resolve(rootDir, p), { encoding: 'utf8' }) || ''));
}

// --- replica of the runtime resolution logic ---

let _cachedRegistry = null;
function resolveConfidentialTenant(brandName, designSystemId) {
  if (!brandName) return null;
  try {
    if (!_cachedRegistry) {
      _cachedRegistry = safeRead('knowledge/confidential/tenants/index.json');
    }
    const key = brandName.toLowerCase();
    for (const entry of _cachedRegistry.tenants || []) {
      try {
        const ov = safeRead(entry.override_path);
        if (designSystemId && ov.design_system_id && ov.design_system_id !== designSystemId)
          continue;
        if (Array.isArray(ov.matchers) && ov.matchers.some((m) => key.includes(m.toLowerCase()))) {
          return { ...ov, _source: entry.override_path };
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* registry unavailable */
  }
  return null;
}

function resolveLayoutTemplate(brief, tenantOverride) {
  const systems = safeRead(
    'knowledge/public/design-patterns/media-templates/media-design-systems/systems.json'
  );
  const system = systems.systems?.[brief.design_system_id];

  // Priority 1: tenant confidential catalog
  if (tenantOverride?.layout_template_catalog) {
    try {
      const catalog = safeRead(tenantOverride.layout_template_catalog);
      const id = tenantOverride.layout_template_id || catalog.default;
      if (catalog.templates?.[id]) {
        return { templateId: id, source: tenantOverride.layout_template_catalog };
      }
    } catch {
      /* fall through */
    }
  }

  // Priority 2: system-level public catalog
  const templateId = tenantOverride?.layout_template_id || system?.layout_template_id || null;
  if (templateId) {
    const publicCatalog = safeRead(
      'knowledge/public/design-patterns/media-templates/slide-layout-presets/layout-templates.json'
    );
    if (publicCatalog.templates?.[templateId]) {
      return { templateId, source: 'public/layout-templates.json' };
    }
  }

  return { templateId: 'body-zone-layouts.json (fallback)', source: 'fallback' };
}

const FALLBACK_ZONE_MAP = {
  hero: 'hero',
  problem: 'two_column_callout',
  evidence: 'two_column_callout',
  roi: 'two_column_callout',
  control: 'two_column_risk',
  plan: 'timeline',
  roadmap: 'timeline',
  solution: 'architecture_panel',
  architecture: 'architecture_panel',
  decision: 'decision_cta',
  cta: 'decision_cta',
  summary: 'single_column',
};

function resolveBodyZoneKey(semanticType, designSystemId) {
  const systems = safeRead(
    'knowledge/public/design-patterns/media-templates/media-design-systems/systems.json'
  );
  const system = systems.systems?.[designSystemId];
  if (system?.body_zone_map?.[semanticType]) {
    return { key: system.body_zone_map[semanticType], source: 'body_zone_map' };
  }
  return { key: FALLBACK_ZONE_MAP[semanticType] || 'single_column', source: 'fallback' };
}

// --- scenario runner ---

const SCENARIOS = [
  {
    name: 'ソリューション提案（SBISS）',
    brief: 'active/shared/tmp/verify-scenarios/solution-proposal-sbiss/deck-brief.json',
  },
  {
    name: 'システム提案',
    brief: 'active/shared/tmp/verify-scenarios/system-proposal/deck-brief.json',
  },
  { name: '設計書', brief: 'active/shared/tmp/verify-scenarios/design-document/deck-brief.json' },
  {
    name: '調査報告レポート',
    brief: 'active/shared/tmp/verify-scenarios/research-report/deck-brief.json',
  },
];

const PAD = 26;

for (const scenario of SCENARIOS) {
  console.log('\n' + '═'.repeat(72));
  console.log(`  ${scenario.name}`);
  console.log('═'.repeat(72));

  if (!safeExistsSync(scenario.brief)) {
    console.log(`  missing brief     : ${scenario.brief}`);
    console.log('  → skipped (fixture not present)');
    continue;
  }

  const brief = safeRead(scenario.brief);
  const brandName = brief.branding?.brand_name || brief.client || '';
  const dsId = brief.design_system_id;

  console.log(`  design_system_id : ${dsId}`);
  console.log(`  brand_name       : ${brandName}`);

  // Tenant resolution
  const tenant = resolveConfidentialTenant(brandName, dsId);
  if (tenant) {
    console.log(`  テナントマッチ   : ✅ ${tenant._source}`);
    console.log(`  theme            : ${tenant.theme}`);
  } else {
    console.log(`  テナントマッチ   : なし（デフォルト使用）`);
  }

  // Layout template
  const layout = resolveLayoutTemplate(brief, tenant);
  console.log(`  レイアウトテンプレート : ${layout.templateId}`);
  console.log(`                     from: ${layout.source}`);

  // Body zone per semantic type
  console.log('\n  スライドごとの body_zone 解決:');
  console.log('  ' + '─'.repeat(68));
  console.log(`  ${'semantic_type'.padEnd(PAD)} → ${'body_zone_key'.padEnd(22)} (source)`);
  console.log('  ' + '─'.repeat(68));

  for (const slide of brief.slides || []) {
    const st = slide.semantic_type;
    if (!st || st === 'hero') continue; // hero uses its own zone
    const bz = resolveBodyZoneKey(st, dsId);
    console.log(`  ${st.padEnd(PAD)} → ${bz.key.padEnd(22)} (${bz.source})`);
  }
}

console.log('\n' + '═'.repeat(72));
console.log('  検証完了');
console.log('═'.repeat(72) + '\n');
