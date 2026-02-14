const fs = require('fs');

/**
 * Shared keyword-based classification engine.
 * Used by doc-type-classifier, domain-classifier, intent-classifier.
 */

/**
 * Classify text content against a rules map.
 * @param {string} content - Text to classify
 * @param {Object<string, string[]>} rules - Map of category -> keywords
 * @param {Object} [options]
 * @param {string} [options.resultKey='category'] - Key name for the result
 * @param {number} [options.baseConfidence=0.7] - Confidence when matches found
 * @returns {{ [resultKey]: string, confidence: number, matches: number }}
 */
function classify(content, rules, options = {}) {
  const { resultKey = 'category', baseConfidence = 0.7 } = options;

  let bestCategory = 'unknown';
  let maxScore = 0;
  const totalKeywords = Math.max(...Object.values(rules).map((kw) => kw.length), 1);

  for (const [category, keywords] of Object.entries(rules)) {
    let score = 0;
    for (const word of keywords) {
      if (content.includes(word)) score++;
    }
    if (score > maxScore) {
      maxScore = score;
      bestCategory = category;
    }
  }

  const confidence =
    maxScore > 0 ? Math.min(baseConfidence + (maxScore / totalKeywords) * 0.3, 1.0) : 0;

  return {
    [resultKey]: bestCategory,
    confidence: Math.round(confidence * 100) / 100,
    matches: maxScore,
  };
}

/**
 * Read file and classify its content.
 * @param {string} filePath - Path to file
 * @param {Object<string, string[]>} rules - Classification rules
 * @param {Object} [options] - Options passed to classify()
 */
function classifyFile(filePath, rules, options = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  return classify(content, rules, options);
}

module.exports = { classify, classifyFile };
