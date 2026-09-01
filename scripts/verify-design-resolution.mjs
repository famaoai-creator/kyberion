/**
 * Verifies layout/body-zone resolution for each scenario brief.
 * Reads the same JSON files as the runtime, exercises the same logic,
 * and prints a resolution table without building a full PPTX.
 */
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveTenantDesign } from '@agent/core/tenant-design-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { readJson } from '@agent/core/foundation';
import {
  resolveBodyZoneKey as resolveRuntimeBodyZoneKey,
  resolveLayoutTemplate as resolveRuntimeLayoutTemplate,
} from '../dist/libs/actuators/media-actuator/src/media-layout-catalog.js';
import { loadMediaDesignSystemsCatalog } from '../dist/libs/actuators/media-actuator/src/media-catalog-loaders.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(moduleDir, '..');

function safeRead(p) {
  return readJson(resolve(rootDir, p));
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
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const system = designSystems.systems?.[dsId];

  console.log(`  design_system_id : ${dsId}`);
  console.log(`  brand_name       : ${brandName}`);

  // Tenant resolution
  const tenant = resolveTenantDesign({ rootDir, brandName, designSystemId: dsId });
  if (tenant.source === 'tenant') {
    console.log(`  テナントマッチ   : ✅ ${tenant.matchedPath}`);
    console.log(
      `  theme            : ${tenant.tenantOverride?.theme || tenant.themePack?.theme?.name || ''}`
    );
  } else {
    console.log(`  テナントマッチ   : なし（デフォルト使用）`);
  }

  // Layout template
  const layout = resolveRuntimeLayoutTemplate(rootDir, dsId, brief, tenant.themePack);
  const templateId =
    brief.layout_template_id ||
    tenant.tenantOverride?.layout_template_id ||
    system?.layout_template_id;
  console.log(`  レイアウトテンプレート : ${templateId || 'runtime fallback'}`);
  console.log(
    `                     from: shared runtime (${layout ? Object.keys(layout).length : 0} keys)`
  );

  // Body zone per semantic type
  console.log('\n  スライドごとの body_zone 解決:');
  console.log('  ' + '─'.repeat(68));
  console.log(`  ${'semantic_type'.padEnd(PAD)} → ${'body_zone_key'.padEnd(22)} (source)`);
  console.log('  ' + '─'.repeat(68));

  for (const slide of brief.slides || []) {
    const st = slide.semantic_type;
    if (!st || st === 'hero') continue; // hero uses its own zone
    const key = resolveRuntimeBodyZoneKey(st, dsId, rootDir);
    const source = system?.body_zone_map?.[st] ? 'body_zone_map' : 'runtime fallback';
    console.log(`  ${st.padEnd(PAD)} → ${key.padEnd(22)} (${source})`);
  }
}

console.log('\n' + '═'.repeat(72));
console.log('  検証完了');
console.log('═'.repeat(72) + '\n');
