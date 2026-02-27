#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

/**
 * context_ranker.cjs
 * Ranks knowledge files based on intent and filters out noise.
 * "One step up" performance by focusing on high-relevance context.
 */

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/knowledge_index.json');

function rankContext(intent, limit = 7) {
  if (!fs.existsSync(indexPath)) {
    console.error('[Ranker] Index not found. Run generate_knowledge_index.cjs first.');
    return [];
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const query = intent.toLowerCase();
  const queryWords = query.split(/[\s,._/-]+/).filter(w => w.length > 2);

  const scoredItems = index.items.map(item => {
    let score = 0;
    const title = item.title.toLowerCase();
    const id = item.id.toLowerCase();
    const cat = item.category.toLowerCase();

    // 1. Title Match (High Priority)
    queryWords.forEach(word => {
      if (title.includes(word)) score += 10;
      if (id.includes(word)) score += 5;
      if (cat.includes(word)) score += 3;
    });

    // 2. Exact Category Match (Very High Priority)
    if (query.includes(cat) || cat.includes(query)) score += 15;

    // 3. Recency Bonus
    if (item.last_updated && item.last_updated.startsWith('2026')) score += 2;

    // 4. Critical Protocol Boost
    if (id.includes('protocol') || id.includes('policy')) score += 5;

    return { ...item, score };
  });

  // Filter out zero scores and sort by score desc
  const results = scoredItems
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return results;
}

if (require.main === module) {
  const intent = process.argv.slice(2).join(' ');
  if (!intent) {
    console.log('Usage: node context_ranker.cjs "<intent>"');
    process.exit(1);
  }

  const ranked = rankContext(intent);
  console.log(`
🎯 Context Ranking for: "${intent}"`);
  console.log('='.repeat(50));
  
  if (ranked.length === 0) {
    console.log('No highly relevant knowledge found. Defaulting to core protocols.');
  } else {
    ranked.forEach((item, i) => {
      console.log(`${i+1}. [Score: ${item.score}] ${item.title} (${item.id})`);
    });
  }

  // Save to active context for mission-control to consume
  const activeContextPath = path.join(rootDir, 'knowledge/orchestration/active_context.json');
  fs.writeFileSync(activeContextPath, JSON.stringify({
    intent,
    timestamp: new Date().toISOString(),
    top_matches: ranked
  }, null, 2));
  
  console.log(`
✅ Active context saved to ${activeContextPath}`);
}

module.exports = { rankContext };
