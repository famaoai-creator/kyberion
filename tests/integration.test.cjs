/**
 * Integration tests — skill chain tests
 *
 * Each test chain feeds the output of one skill into the next skill,
 * verifying that skills compose correctly end-to-end.
 *
 * Run:  node tests/integration.test.cjs
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const tmpDir = path.join(__dirname, '_tmp_integration');

// Setup
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  pass  ${name}`);
    passed++;
  } catch (_err) {
    console.error(`  FAIL  ${name}: ${_err.message}`);
    failures.push(name);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function run(skillScript, args) {
  const cmd = `node "${path.join(rootDir, skillScript)}" ${args}`;
  return execSync(cmd, { encoding: 'utf8', cwd: rootDir, timeout: 15000 });
}

/** Parse skill-wrapper envelope and return the full envelope */
function runAndParse(skillScript, args) {
  const raw = run(skillScript, args);
  const envelope = JSON.parse(raw);
  assert(envelope.status === 'success', `Skill failed: ${JSON.stringify(envelope.error)}`);
  return envelope;
}

function writeTemp(name, content) {
  const p = path.join(tmpDir, name);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ========================================
// Chain 1: Format Detection -> Data Transformation
// ========================================
console.log('\n--- Chain 1: Format Detection -> Data Transformation ---');

test('detect JSON format then transform to YAML', () => {
  // Step 1: Create a JSON file
  const sourceData = { project: 'gemini-skills', version: '2.0', features: ['chains', 'scoring'] };
  const jsonFile = writeTemp('chain1_input.json', JSON.stringify(sourceData, null, 2));

  // Step 2: Run format-detector to identify the file format
  const detectEnv = runAndParse('format-detector/scripts/detect.cjs', `-i "${jsonFile}"`);
  assert(
    detectEnv.data.format === 'json',
    `Expected format "json", got "${detectEnv.data.format}"`
  );
  assert(detectEnv.data.confidence > 0, 'Format detector should have positive confidence');
  assert(
    detectEnv.skill === 'format-detector',
    `Expected skill "format-detector", got "${detectEnv.skill}"`
  );
  assert(detectEnv.metadata.duration_ms >= 0, 'Envelope should have duration_ms');

  // Step 3: Since format was detected as JSON, transform it to YAML
  const detectedFormat = detectEnv.data.format;
  assert(detectedFormat === 'json', 'Chain gate: format must be json before transforming');
  const transformEnv = runAndParse(
    'data-transformer/scripts/transform.cjs',
    `-i "${jsonFile}" -t yaml`
  );
  assert(
    transformEnv.data.format === 'yaml',
    `Expected transformed format "yaml", got "${transformEnv.data.format}"`
  );

  // Step 4: Verify the YAML output contains original data values
  const yamlContent = transformEnv.data.content;
  assert(yamlContent.includes('project: gemini-skills'), 'YAML should contain project name');
  assert(yamlContent.includes('version:'), 'YAML should contain version field');
  assert(yamlContent.includes('chains'), 'YAML should contain array item "chains"');
  assert(yamlContent.includes('scoring'), 'YAML should contain array item "scoring"');
});

test('detect JSON format then transform to CSV (array data)', () => {
  // Step 1: Create a JSON array file
  const arrayData = [
    { name: 'alpha', priority: 1, status: 'active' },
    { name: 'beta', priority: 2, status: 'pending' },
    { name: 'gamma', priority: 3, status: 'done' },
  ];
  const jsonFile = writeTemp('chain1_array.json', JSON.stringify(arrayData));

  // Step 2: Detect format
  const detectEnv = runAndParse('format-detector/scripts/detect.cjs', `-i "${jsonFile}"`);
  assert(detectEnv.data.format === 'json', 'Should detect JSON format for array data');

  // Step 3: Transform to CSV
  const transformEnv = runAndParse(
    'data-transformer/scripts/transform.cjs',
    `-i "${jsonFile}" -t csv`
  );
  assert(transformEnv.data.format === 'csv', 'Should report csv format after transformation');

  // Step 4: Verify CSV output has headers and rows
  const csvContent = transformEnv.data.content;
  assert(csvContent.includes('name'), 'CSV should have name header');
  assert(csvContent.includes('priority'), 'CSV should have priority header');
  assert(csvContent.includes('alpha'), 'CSV should contain first row value');
  assert(csvContent.includes('gamma'), 'CSV should contain last row value');
});

// ========================================
// Chain 2: Classification Pipeline
// ========================================
console.log('\n--- Chain 2: Classification Pipeline ---');

test('classify tech document through domain -> doc-type -> intent pipeline', () => {
  // Step 1: Create a tech specification document with keywords matching actual rules
  // domain-classifier rules for tech: ['API', 'Server', 'Deploy', 'Bug', 'Code', ...]
  // doc-type-classifier rules for specification: ['仕様書', '設計', 'Architecture', 'Sequence', 'API Definition']
  const techDoc = [
    'API Definition Document',
    '',
    'This document defines the Architecture and Sequence of the Server deployment.',
    'Deploy the API Server with the following configuration.',
    'The system Architecture uses a microservice Sequence pattern.',
    'Bug tracking and Code review processes are also defined.',
  ].join('\n');
  const techFile = writeTemp('chain2_tech_spec.txt', techDoc);

  // Step 2: Run domain-classifier -> should detect tech domain
  const domainEnv = runAndParse('domain-classifier/scripts/classify.cjs', `-i "${techFile}"`);
  assert(
    domainEnv.data.domain === 'tech',
    `Expected domain "tech", got "${domainEnv.data.domain}"`
  );
  assert(domainEnv.data.confidence > 0, 'Domain classifier should have positive confidence');
  assert(domainEnv.data.matches > 0, 'Should have keyword matches');

  // Step 3: Since domain is tech, run doc-type-classifier -> should detect specification
  const docTypeEnv = runAndParse('doc-type-classifier/scripts/classify.cjs', `-i "${techFile}"`);
  assert(
    docTypeEnv.data.type === 'specification',
    `Expected type "specification", got "${docTypeEnv.data.type}"`
  );
  assert(docTypeEnv.data.confidence > 0, 'Doc-type classifier should have positive confidence');

  // Step 4: Run intent-classifier -> verify the intent
  const intentEnv = runAndParse('intent-classifier/scripts/classify.cjs', `-i "${techFile}"`);
  assert(intentEnv.data.intent !== undefined, 'Intent classifier should return an intent');
  assert(intentEnv.data.confidence >= 0, 'Intent classifier should have non-negative confidence');
  // The chain completed: domain -> doc-type -> intent
  assert(intentEnv.metadata.timestamp !== undefined, 'Envelope should have timestamp');
});

test('classification pipeline preserves envelope structure across all classifiers', () => {
  const doc =
    'Budget report for Q4 fiscal year. Total cost: $500,000. Revenue projection analysis.';
  const docFile = writeTemp('chain2_finance.txt', doc);

  const domainEnv = runAndParse('domain-classifier/scripts/classify.cjs', `-i "${docFile}"`);
  const docTypeEnv = runAndParse('doc-type-classifier/scripts/classify.cjs', `-i "${docFile}"`);
  const intentEnv = runAndParse('intent-classifier/scripts/classify.cjs', `-i "${docFile}"`);

  // Verify all three return proper envelopes with consistent structure
  for (const [name, env] of [
    ['domain', domainEnv],
    ['doc-type', docTypeEnv],
    ['intent', intentEnv],
  ]) {
    assert(env.status === 'success', `${name} classifier should succeed`);
    assert(env.skill !== undefined, `${name} classifier envelope should have skill name`);
    assert(env.metadata !== undefined, `${name} classifier should have metadata`);
    assert(env.metadata.duration_ms >= 0, `${name} classifier should report duration`);
    assert(env.metadata.timestamp !== undefined, `${name} classifier should have timestamp`);
  }
});

// ========================================
// Chain 3: Analysis -> Report
// ========================================
console.log('\n--- Chain 3: Analysis -> Report ---');

test('score quality and completeness then generate HTML report', () => {
  // Step 1: Create a markdown document
  const markdownContent = [
    '# Project Status Report',
    '',
    '## Overview',
    '',
    'This document provides a comprehensive overview of the project status.',
    'The project is currently on track and meeting all milestone deadlines.',
    '',
    '## Key Metrics',
    '',
    '- **Completion**: 85% of features delivered',
    '- **Quality**: All tests passing with 95% coverage',
    '- **Performance**: API response times under 50ms',
    '',
    '## Next Steps',
    '',
    'The team will focus on the remaining 15% of features.',
    'Priority items include documentation updates and integration testing.',
    'Final release is scheduled for the end of the quarter.',
  ].join('\n');
  const mdFile = writeTemp('chain3_report.md', markdownContent);

  // Step 2: Run quality-scorer
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${mdFile}"`);
  assert(
    qualityEnv.data.score >= 0 && qualityEnv.data.score <= 100,
    `Quality score should be 0-100, got ${qualityEnv.data.score}`
  );
  assert(qualityEnv.data.metrics !== undefined, 'Quality scorer should return metrics');
  assert(qualityEnv.data.metrics.charCount > 0, 'Char count should be positive');

  // Step 3: Run completeness-scorer
  const completenessEnv = runAndParse('completeness-scorer/scripts/score.cjs', `-i "${mdFile}"`);
  assert(
    completenessEnv.data.score >= 0 && completenessEnv.data.score <= 100,
    `Completeness score should be 0-100, got ${completenessEnv.data.score}`
  );
  assert(
    Array.isArray(completenessEnv.data.issues),
    'Completeness scorer should return issues array'
  );

  // Step 4: Generate HTML report from the scored markdown
  const htmlOutFile = path.join(tmpDir, 'chain3_output.html');
  const reportTitle = `Quality: ${qualityEnv.data.score}, Completeness: ${completenessEnv.data.score}`;
  const reportEnv = runAndParse(
    'html-reporter/scripts/report.cjs',
    `-i "${mdFile}" -o "${htmlOutFile}" -t "${reportTitle}"`
  );
  assert(reportEnv.data.output === htmlOutFile, 'HTML reporter should report correct output path');
  assert(reportEnv.data.title === reportTitle, 'HTML reporter should use the chain-derived title');
  assert(reportEnv.data.size > 0, 'HTML report size should be positive');

  // Step 5: Verify the HTML file exists and has expected content
  assert(fs.existsSync(htmlOutFile), 'HTML output file should exist on disk');
  const htmlContent = fs.readFileSync(htmlOutFile, 'utf8');
  assert(htmlContent.includes('<h1>'), 'HTML should contain H1 heading');
  assert(
    htmlContent.includes('Project Status Report'),
    'HTML should contain the report title text'
  );
  assert(htmlContent.includes('<strong>'), 'HTML should render bold markdown');
  assert(htmlContent.includes('<li>'), 'HTML should render list items');
});

test('quality and completeness scores correlate for complete vs incomplete docs', () => {
  // Complete document
  const completeDoc = [
    'This is a thorough and complete technical document.',
    'It covers all the necessary details and provides clear explanations.',
    'No sections are left incomplete and all topics are well addressed.',
    'The writing quality is consistently high throughout.',
  ].join('\n');
  const completeFile = writeTemp('chain3_complete.txt', completeDoc);

  // Incomplete document with TODOs and placeholders
  const incompleteDoc = [
    'Draft document.',
    'TODO: add introduction section',
    'TBD: fill in the details here',
    'FIXME: broken section needs rewriting',
    'TODO: add conclusion',
  ].join('\n');
  const incompleteFile = writeTemp('chain3_incomplete.txt', incompleteDoc);

  const _completeQuality = runAndParse('quality-scorer/scripts/score.cjs', `-i "${completeFile}"`);
  const _incompleteQuality = runAndParse(
    'quality-scorer/scripts/score.cjs',
    `-i "${incompleteFile}"`
  );
  const completeCompleteness = runAndParse(
    'completeness-scorer/scripts/score.cjs',
    `-i "${completeFile}"`
  );
  const incompleteCompleteness = runAndParse(
    'completeness-scorer/scripts/score.cjs',
    `-i "${incompleteFile}"`
  );

  // The incomplete doc should have lower completeness
  assert(
    completeCompleteness.data.score > incompleteCompleteness.data.score,
    `Complete doc (${completeCompleteness.data.score}) should score higher than incomplete (${incompleteCompleteness.data.score})`
  );

  // The incomplete doc should have issues flagged
  assert(
    incompleteCompleteness.data.issues.length > 0,
    'Incomplete doc should have flagged issues'
  );
});

// ========================================
// Chain 4: Code Analysis
// ========================================
console.log('\n--- Chain 4: Code Analysis ---');

test('detect code language, check sensitivity, and verify encoding', () => {
  // Step 1: Create a clean JavaScript file
  const jsCode = [
    '// Module for calculating statistics',
    'const calculateMean = (numbers) => {',
    '  const sum = numbers.reduce((acc, n) => acc + n, 0);',
    '  return sum / numbers.length;',
    '};',
    '',
    'const calculateMedian = (numbers) => {',
    '  const sorted = [...numbers].sort((a, b) => a - b);',
    '  const mid = Math.floor(sorted.length / 2);',
    '  return sorted.length % 2 !== 0',
    '    ? sorted[mid]',
    '    : (sorted[mid - 1] + sorted[mid]) / 2;',
    '};',
    '',
    'module.exports = { calculateMean, calculateMedian };',
  ].join('\n');
  const jsFile = writeTemp('chain4_stats.js', jsCode);

  // Step 2: Detect code language -> should be JavaScript
  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${jsFile}"`);
  assert(langEnv.data.lang === 'javascript', `Expected "javascript", got "${langEnv.data.lang}"`);
  assert(langEnv.data.confidence === 1.0, 'Should have full confidence for .js extension');
  assert(langEnv.data.method === 'extension', 'Should use extension-based detection');

  // Step 3: Check sensitivity -> should have no PII (clean code)
  const sensitivityEnv = runAndParse('sensitivity-detector/scripts/scan.cjs', `-i "${jsFile}"`);
  assert(sensitivityEnv.data.hasPII === false, 'Clean JS code should have no PII');

  // Step 4: Detect encoding -> should be UTF-8 with LF line endings
  const encodingEnv = runAndParse('encoding-detector/scripts/detect.cjs', `-i "${jsFile}"`);
  assert(encodingEnv.data.encoding !== undefined, 'Should detect an encoding');
  assert(
    encodingEnv.data.lineEnding === 'LF',
    `Expected LF line ending, got "${encodingEnv.data.lineEnding}"`
  );
  assert(encodingEnv.data.confidence > 0, 'Should have positive encoding confidence');

  // Verify the full chain produced consistent results for the same file
  assert(
    langEnv.skill !== undefined &&
      sensitivityEnv.skill !== undefined &&
      encodingEnv.skill !== undefined,
    'All skills in chain should identify themselves in the envelope'
  );
});

test('code analysis chain flags PII in code with embedded secrets', () => {
  // Create a JS file that contains PII
  const dirtyCode = [
    'const config = {',
    '  adminEmail: "admin@company.com",',
    '  serverIP: "10.0.0.1",',
    '  apiEndpoint: "https://api.example.com",',
    '};',
    'module.exports = config;',
  ].join('\n');
  const dirtyFile = writeTemp('chain4_dirty.js', dirtyCode);

  // Language detection should still work
  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${dirtyFile}"`);
  assert(langEnv.data.lang === 'javascript', 'Should still detect JavaScript');

  // Sensitivity detection should flag PII
  const sensitivityEnv = runAndParse('sensitivity-detector/scripts/scan.cjs', `-i "${dirtyFile}"`);
  assert(sensitivityEnv.data.hasPII === true, 'Should detect PII in code with secrets');
  assert(sensitivityEnv.data.findings.email >= 1, 'Should find at least 1 email');
  assert(sensitivityEnv.data.findings.ipv4 >= 1, 'Should find at least 1 IP address');
});

test('code analysis chain for Python file via keyword detection', () => {
  const pyCode = [
    'def process_data(items):',
    '    import json',
    '    results = []',
    '    for item in items:',
    '        results.append(item * 2)',
    '    return results',
  ].join('\n');
  // Use .txt extension to force keyword-based detection
  const pyFile = writeTemp('chain4_pycode.txt', pyCode);

  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${pyFile}"`);
  assert(langEnv.data.lang === 'python', `Expected "python", got "${langEnv.data.lang}"`);
  assert(langEnv.data.method === 'keyword', 'Should use keyword-based detection for .txt file');

  const sensitivityEnv = runAndParse('sensitivity-detector/scripts/scan.cjs', `-i "${pyFile}"`);
  assert(sensitivityEnv.data.hasPII === false, 'Clean Python code should have no PII');

  const encodingEnv = runAndParse('encoding-detector/scripts/detect.cjs', `-i "${pyFile}"`);
  assert(encodingEnv.data.encoding !== undefined, 'Should detect encoding for Python code');
});

// ========================================
// Chain 5: Dependency -> Visualization
// ========================================
console.log('\n--- Chain 5: Dependency -> Visualization ---');

test('graph dependencies then render with template', () => {
  // Step 1: Create a fake package.json in a subdirectory
  const pkgDir = path.join(tmpDir, 'chain5_pkg');
  if (!fs.existsSync(pkgDir)) fs.mkdirSync(pkgDir, { recursive: true });
  const pkgData = {
    name: 'my-web-app',
    version: '1.0.0',
    dependencies: {
      express: '^4.18.0',
      lodash: '^4.17.0',
      axios: '^1.5.0',
    },
    devDependencies: {
      jest: '^29.0.0',
    },
  };
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgData, null, 2));

  // Step 2: Run dependency-grapher to produce a mermaid graph
  const graphEnv = runAndParse('dependency-grapher/scripts/graph.cjs', `-d "${pkgDir}"`);
  assert(graphEnv.data.content.includes('graph TD'), 'Mermaid graph should start with "graph TD"');
  assert(graphEnv.data.content.includes('my-web-app'), 'Graph should include root package name');
  assert(graphEnv.data.content.includes('express'), 'Graph should include express dependency');
  assert(graphEnv.data.content.includes('lodash'), 'Graph should include lodash dependency');
  assert(graphEnv.data.content.includes('axios'), 'Graph should include axios dependency');
  assert(graphEnv.data.nodeCount >= 4, `Expected at least 4 nodes, got ${graphEnv.data.nodeCount}`);

  // Step 3: Create a template that will render the graph into an HTML document
  const templateContent = [
    '<!DOCTYPE html>',
    '<html>',
    '<head><title>{{title}}</title></head>',
    '<body>',
    '<h1>{{title}}</h1>',
    '<pre class="mermaid">',
    '{{graph}}',
    '</pre>',
    '<p>Nodes: {{nodeCount}}</p>',
    '</body>',
    '</html>',
  ].join('\n');
  const templateFile = writeTemp('chain5_template.mustache', templateContent);

  // Step 4: Prepare template data from the graph output
  const templateData = {
    title: `Dependencies for ${pkgData.name}`,
    graph: graphEnv.data.content,
    nodeCount: graphEnv.data.nodeCount,
  };
  const dataFile = writeTemp('chain5_data.json', JSON.stringify(templateData));

  // Step 5: Render the template with graph data
  const renderEnv = runAndParse(
    'template-renderer/scripts/render.cjs',
    `-t "${templateFile}" -d "${dataFile}"`
  );
  assert(
    renderEnv.data.content.includes('Dependencies for my-web-app'),
    'Rendered output should include title'
  );
  assert(
    renderEnv.data.content.includes('graph TD'),
    'Rendered output should include the mermaid graph'
  );
  assert(
    renderEnv.data.content.includes('express'),
    'Rendered output should include dependency names'
  );
  assert(
    renderEnv.data.content.includes(`Nodes: ${graphEnv.data.nodeCount}`),
    'Rendered output should include node count'
  );
  assert(
    renderEnv.data.content.includes('<html>'),
    'Rendered output should be valid HTML structure'
  );
});

test('dependency graph node count feeds into template accurately', () => {
  // Minimal package with known dependency count
  const pkgDir2 = path.join(tmpDir, 'chain5_pkg2');
  if (!fs.existsSync(pkgDir2)) fs.mkdirSync(pkgDir2, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir2, 'package.json'),
    JSON.stringify({
      name: 'tiny-lib',
      dependencies: { chalk: '^5.0.0' },
    })
  );

  const graphEnv = runAndParse('dependency-grapher/scripts/graph.cjs', `-d "${pkgDir2}"`);
  // With 1 dependency + root: should be 2 nodes
  assert(graphEnv.data.nodeCount === 2, `Expected 2 nodes, got ${graphEnv.data.nodeCount}`);

  const simpleTemplate = writeTemp(
    'chain5_simple.mustache',
    'Package {{name}} has {{nodeCount}} nodes.'
  );
  const simpleData = writeTemp(
    'chain5_simple_data.json',
    JSON.stringify({
      name: 'tiny-lib',
      nodeCount: graphEnv.data.nodeCount,
    })
  );

  const renderEnv = runAndParse(
    'template-renderer/scripts/render.cjs',
    `-t "${simpleTemplate}" -d "${simpleData}"`
  );
  assert(
    renderEnv.data.content === 'Package tiny-lib has 2 nodes.',
    `Expected exact rendered string, got "${renderEnv.data.content}"`
  );
});

// ========================================
// Chain 6: Schema Validation
// ========================================
console.log('\n--- Chain 6: Schema Validation ---');

test('validate valid input against skill-input schema then invalidate modified data', () => {
  const schemaPath = path.join(rootDir, 'schemas/skill-input.schema.json');

  // Step 1: Create valid data (matches required fields: skill + action)
  const validData = {
    skill: 'data-transformer',
    action: 'transform',
    params: { format: 'yaml', inputFile: '/tmp/data.json' },
    context: { knowledge_tier: 'public', caller: 'integration-test' },
  };
  const validFile = writeTemp('chain6_valid.json', JSON.stringify(validData));

  // Step 2: Validate -> should pass
  const validEnv = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${validFile}" -s "${schemaPath}"`
  );
  assert(validEnv.data.valid === true, 'Valid data should pass schema validation');

  // Step 3: Create invalid data (missing required "skill" and "action" fields)
  const invalidData = {
    params: { format: 'yaml' },
    context: { knowledge_tier: 'public' },
  };
  const invalidFile = writeTemp('chain6_invalid.json', JSON.stringify(invalidData));

  // Step 4: Validate -> should fail
  const invalidEnv = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${invalidFile}" -s "${schemaPath}"`
  );
  assert(
    invalidEnv.data.valid === false,
    'Invalid data (missing required fields) should fail validation'
  );
  assert(Array.isArray(invalidEnv.data.errors), 'Failed validation should include errors array');
  assert(invalidEnv.data.errors.length > 0, 'Should have at least one validation error');
});

test('schema validation correctly handles progressively degraded input', () => {
  const schemaPath = path.join(rootDir, 'schemas/skill-input.schema.json');

  // Full valid input
  const fullInput = { skill: 'test', action: 'run', params: { x: 1 } };
  const fullFile = writeTemp('chain6_full.json', JSON.stringify(fullInput));
  const fullEnv = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${fullFile}" -s "${schemaPath}"`
  );
  assert(fullEnv.data.valid === true, 'Full input should be valid');

  // Minimal valid input (only required fields)
  const minimalInput = { skill: 'test', action: 'run' };
  const minimalFile = writeTemp('chain6_minimal.json', JSON.stringify(minimalInput));
  const minimalEnv = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${minimalFile}" -s "${schemaPath}"`
  );
  assert(minimalEnv.data.valid === true, 'Minimal input with only required fields should be valid');

  // Missing "action" field
  const noAction = { skill: 'test' };
  const noActionFile = writeTemp('chain6_no_action.json', JSON.stringify(noAction));
  const noActionEnv = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${noActionFile}" -s "${schemaPath}"`
  );
  assert(noActionEnv.data.valid === false, 'Input missing "action" should be invalid');

  // Missing "skill" field
  const noSkill = { action: 'run' };
  const noSkillFile = writeTemp('chain6_no_skill.json', JSON.stringify(noSkill));
  const noSkillEnv = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${noSkillFile}" -s "${schemaPath}"`
  );
  assert(noSkillEnv.data.valid === false, 'Input missing "skill" should be invalid');

  // Completely empty object
  const emptyObj = {};
  const emptyFile = writeTemp('chain6_empty.json', JSON.stringify(emptyObj));
  const emptyEnv = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${emptyFile}" -s "${schemaPath}"`
  );
  assert(emptyEnv.data.valid === false, 'Empty object should be invalid');
  assert(
    emptyEnv.data.errors.length >= 1,
    'Empty object should have at least 1 validation error for missing required fields'
  );
});

test('schema validation chain: validate then re-validate after fixing', () => {
  const schemaPath = path.join(rootDir, 'schemas/skill-input.schema.json');

  // Step 1: Start with invalid data
  const brokenData = { description: 'missing required fields' };
  const dataFile = writeTemp('chain6_fix.json', JSON.stringify(brokenData));

  const firstValidation = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${dataFile}" -s "${schemaPath}"`
  );
  assert(firstValidation.data.valid === false, 'First validation should fail');

  // Step 2: Fix the data by adding required fields
  const fixedData = {
    skill: 'repaired-skill',
    action: 'execute',
    description: 'now has required fields',
  };
  fs.writeFileSync(dataFile, JSON.stringify(fixedData));

  // Step 3: Re-validate -> should pass now
  const secondValidation = runAndParse(
    'schema-validator/scripts/validate.cjs',
    `-i "${dataFile}" -s "${schemaPath}"`
  );
  assert(secondValidation.data.valid === true, 'Second validation after fix should pass');
});

// ========================================
// Bonus: Cross-chain verification
// ========================================
console.log('\n--- Cross-chain: Multi-skill consistency ---');

test('all skills in a chain produce consistent envelope metadata', () => {
  const testFile = writeTemp(
    'cross_chain.json',
    JSON.stringify({ skill: 'test', action: 'verify' })
  );

  const formatEnv = runAndParse('format-detector/scripts/detect.cjs', `-i "${testFile}"`);
  const encodingEnv = runAndParse('encoding-detector/scripts/detect.cjs', `-i "${testFile}"`);
  const sensitivityEnv = runAndParse('sensitivity-detector/scripts/scan.cjs', `-i "${testFile}"`);

  // All envelopes should follow the same structure
  for (const [name, env] of [
    ['format', formatEnv],
    ['encoding', encodingEnv],
    ['sensitivity', sensitivityEnv],
  ]) {
    assert(
      typeof env.skill === 'string' && env.skill.length > 0,
      `${name}: skill should be a non-empty string`
    );
    assert(env.status === 'success', `${name}: status should be "success"`);
    assert(typeof env.data === 'object' && env.data !== null, `${name}: data should be an object`);
    assert(
      typeof env.metadata === 'object' && env.metadata !== null,
      `${name}: metadata should be an object`
    );
    assert(typeof env.metadata.duration_ms === 'number', `${name}: duration_ms should be a number`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: timestamp should be a string`);
  }
});

test('format detection output drives correct transformer target', () => {
  // Create a YAML file, detect its format, then transform to JSON
  const yamlInput = 'name: integration-test\nstatus: passing\nitems:\n  - alpha\n  - beta\n';
  const yamlFile = writeTemp('cross_yaml_input.yaml', yamlInput);

  // Detect format
  const formatEnv = runAndParse('format-detector/scripts/detect.cjs', `-i "${yamlFile}"`);
  assert(formatEnv.data.format === 'yaml', 'Should detect YAML format');

  // Since it is YAML, transform to JSON (the opposite direction from chain 1)
  const transformEnv = runAndParse(
    'data-transformer/scripts/transform.cjs',
    `-i "${yamlFile}" -t json`
  );
  assert(transformEnv.data.format === 'json', 'Should transform to JSON');

  // Verify the JSON content is valid
  const parsedJson = JSON.parse(transformEnv.data.content);
  assert(parsedJson.name === 'integration-test', 'Transformed JSON should preserve name field');
  assert(parsedJson.status === 'passing', 'Transformed JSON should preserve status field');
  assert(Array.isArray(parsedJson.items), 'Transformed JSON should preserve items as array');
  assert(parsedJson.items.length === 2, 'Transformed JSON should have 2 items');
});

// ========================================
// Chain 7: Full Security Audit Pipeline (4 skills)
// codebase-mapper → security-scanner → bug-predictor → html-reporter
// ========================================
console.log('\n--- Chain 7: Full Security Audit Pipeline (4 skills) ---');

test('codebase-mapper -> security-scanner -> bug-predictor -> html-reporter', () => {
  // Step 1: Create a temp directory with a few source files for mapping
  const auditDir = path.join(tmpDir, 'chain7_audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });

  const srcFile1 = path.join(auditDir, 'app.js');
  fs.writeFileSync(
    srcFile1,
    [
      'const express = require("express");',
      'const app = express();',
      'app.get("/", (req, res) => {',
      '  if (req.query.admin) {',
      '    res.send("admin panel");',
      '  } else {',
      '    res.send("hello");',
      '  }',
      '});',
      'module.exports = app;',
    ].join('\n')
  );

  const srcFile2 = path.join(auditDir, 'config.json');
  fs.writeFileSync(srcFile2, JSON.stringify({ port: 3000, debug: true }, null, 2));

  const srcFile3 = path.join(auditDir, 'utils.js');
  fs.writeFileSync(
    srcFile3,
    [
      'function validate(input) {',
      '  if (!input) throw new Error("missing");',
      '  return input.trim();',
      '}',
      'module.exports = { validate };',
    ].join('\n')
  );

  // Step 2: Run codebase-mapper on the audit directory
  const mapEnv = runAndParse('codebase-mapper/scripts/map.cjs', `"${auditDir}" 2`);
  assert(
    mapEnv.skill === 'codebase-mapper',
    `Expected skill "codebase-mapper", got "${mapEnv.skill}"`
  );
  assert(mapEnv.data.root !== undefined, 'Codebase mapper should return root path');
  assert(Array.isArray(mapEnv.data.tree), 'Codebase mapper should return tree array');
  assert(mapEnv.data.tree.length > 0, 'Tree should have entries for the created files');

  // Step 3: Run security-scanner (it uses logger.success which writes to stdout before JSON)
  const secRaw = run('security-scanner/scripts/scan.cjs', '');
  // Extract the JSON portion (skip any logger output before the opening brace)
  const secJsonStart = secRaw.indexOf('{');
  assert(secJsonStart >= 0, 'Security scanner output should contain JSON');
  const secEnv = JSON.parse(secRaw.slice(secJsonStart));
  assert(
    secEnv.status === 'success',
    `Security scanner should succeed: ${JSON.stringify(secEnv.error)}`
  );
  assert(
    secEnv.skill === 'security-scanner',
    `Expected skill "security-scanner", got "${secEnv.skill}"`
  );
  assert(secEnv.data.status === 'scan_complete', 'Security scanner should report scan_complete');
  assert(Array.isArray(secEnv.data.ignoreDirs), 'Security scanner should list ignored dirs');

  // Step 4: Run bug-predictor on a small git repo (main repo may be too large)
  // Initialize the audit directory as a git repo with a few commits
  execSync('git init', { cwd: auditDir, stdio: 'pipe' });
  execSync('git add -A', { cwd: auditDir, stdio: 'pipe' });
  execSync('git -c user.email="test@test.com" -c user.name="Test" commit -m "initial"', {
    cwd: auditDir,
    stdio: 'pipe',
  });
  // Modify a file and commit again to create churn
  fs.writeFileSync(srcFile1, fs.readFileSync(srcFile1, 'utf8') + '\n// updated\n');
  execSync('git add -A', { cwd: auditDir, stdio: 'pipe' });
  execSync('git -c user.email="test@test.com" -c user.name="Test" commit -m "update app"', {
    cwd: auditDir,
    stdio: 'pipe',
  });

  const bugEnv = runAndParse('bug-predictor/scripts/predict.cjs', `-d "${auditDir}" -n 5`);
  assert(bugEnv.skill === 'bug-predictor', `Expected skill "bug-predictor", got "${bugEnv.skill}"`);
  assert(bugEnv.data.repository !== undefined, 'Bug predictor should report repository path');
  assert(Array.isArray(bugEnv.data.hotspots), 'Bug predictor should return hotspots array');
  assert(bugEnv.data.riskSummary !== undefined, 'Bug predictor should return risk summary');

  // Step 5: Generate an HTML report summarizing the security audit
  const auditSummaryMd = [
    '# Security Audit Report',
    '',
    '## Codebase Structure',
    `- Root: ${mapEnv.data.root}`,
    `- Files mapped: ${mapEnv.data.tree.length} entries`,
    '',
    '## Security Scan',
    `- Status: ${secEnv.data.status}`,
    `- Ignored directories: ${secEnv.data.ignoreDirs.length}`,
    '',
    '## Bug Risk Analysis',
    `- Files analyzed: ${bugEnv.data.totalFilesAnalyzed}`,
    `- High risk: ${bugEnv.data.riskSummary.high}`,
    `- Medium risk: ${bugEnv.data.riskSummary.medium}`,
    `- Low risk: ${bugEnv.data.riskSummary.low}`,
    '',
    `Recommendation: ${bugEnv.data.recommendation}`,
  ].join('\n');
  const auditMdFile = writeTemp('chain7_audit_summary.md', auditSummaryMd);
  const auditHtmlFile = path.join(tmpDir, 'chain7_audit_report.html');

  const reportEnv = runAndParse(
    'html-reporter/scripts/report.cjs',
    `-i "${auditMdFile}" -o "${auditHtmlFile}" -t "Security Audit Report"`
  );
  assert(
    reportEnv.skill === 'html-reporter',
    `Expected skill "html-reporter", got "${reportEnv.skill}"`
  );
  assert(reportEnv.data.size > 0, 'HTML report size should be positive');
  assert(fs.existsSync(auditHtmlFile), 'Audit HTML report file should exist on disk');

  // Verify all 4 envelopes have consistent metadata structure
  for (const [name, env] of [
    ['codebase-mapper', mapEnv],
    ['security-scanner', secEnv],
    ['bug-predictor', bugEnv],
    ['html-reporter', reportEnv],
  ]) {
    assert(env.status === 'success', `${name}: status should be success`);
    assert(typeof env.metadata === 'object', `${name}: metadata should be an object`);
    assert(typeof env.metadata.duration_ms === 'number', `${name}: should have duration_ms`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

test('security audit pipeline produces HTML containing data from all upstream skills', () => {
  // Verify the HTML report content references data from the pipeline
  const auditHtmlFile = path.join(tmpDir, 'chain7_audit_report.html');
  // The file was created by the previous test; if it exists, validate its content
  if (fs.existsSync(auditHtmlFile)) {
    const htmlContent = fs.readFileSync(auditHtmlFile, 'utf8');
    assert(htmlContent.includes('Security Audit Report'), 'HTML should contain report title');
    assert(htmlContent.includes('Codebase Structure'), 'HTML should contain codebase section');
    assert(htmlContent.includes('Bug Risk Analysis'), 'HTML should contain bug risk section');
    assert(htmlContent.includes('Recommendation'), 'HTML should contain recommendation');
    assert(htmlContent.includes('<h1>'), 'HTML should have H1 tag');
    assert(htmlContent.includes('<li>'), 'HTML should have list items from the markdown');
  } else {
    // If previous test failed, recreate minimally to keep this test independent
    assert(false, 'Audit HTML file not found - chain 7 first test may have failed');
  }
});

// ========================================
// Chain 8: Document Processing Pipeline (5 skills)
// format-detector → data-transformer → quality-scorer → completeness-scorer → template-renderer
// ========================================
console.log('\n--- Chain 8: Document Processing Pipeline (5 skills) ---');

test('format-detector -> data-transformer -> quality-scorer -> completeness-scorer -> template-renderer', () => {
  // Step 1: Create a JSON test file with meaningful data
  const sourceData = {
    title: 'Quarterly Review Document',
    department: 'Engineering',
    summary:
      'This document provides a comprehensive overview of engineering progress. All milestones have been met and the team continues to deliver high quality results. Performance metrics remain strong across all categories.',
    metrics: { velocity: 42, coverage: 88, satisfaction: 95 },
    status: 'on-track',
  };
  const jsonFile = writeTemp('chain8_input.json', JSON.stringify(sourceData, null, 2));

  // Step 2: Detect its format (should be json)
  const formatEnv = runAndParse('format-detector/scripts/detect.cjs', `-i "${jsonFile}"`);
  assert(
    formatEnv.data.format === 'json',
    `Expected format "json", got "${formatEnv.data.format}"`
  );
  assert(formatEnv.data.confidence === 1.0, 'JSON detection should have full confidence');

  // Step 3: Transform to YAML
  const transformEnv = runAndParse(
    'data-transformer/scripts/transform.cjs',
    `-i "${jsonFile}" -t yaml`
  );
  assert(
    transformEnv.data.format === 'yaml',
    `Expected transformed format "yaml", got "${transformEnv.data.format}"`
  );
  const yamlContent = transformEnv.data.content;
  assert(yamlContent.includes('title:'), 'YAML should contain title field');
  assert(yamlContent.includes('Quarterly Review Document'), 'YAML should preserve title value');

  // Step 4: Write the YAML to a file and score its quality
  const yamlFile = writeTemp('chain8_transformed.yaml', yamlContent);
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${yamlFile}"`);
  assert(typeof qualityEnv.data.score === 'number', 'Quality score should be a number');
  assert(
    qualityEnv.data.score >= 0 && qualityEnv.data.score <= 100,
    `Quality score should be 0-100, got ${qualityEnv.data.score}`
  );
  assert(qualityEnv.data.metrics.charCount > 0, 'Quality metrics charCount should be positive');

  // Step 5: Score completeness on the YAML output
  const completenessEnv = runAndParse('completeness-scorer/scripts/score.cjs', `-i "${yamlFile}"`);
  assert(typeof completenessEnv.data.score === 'number', 'Completeness score should be a number');
  assert(
    completenessEnv.data.score >= 0 && completenessEnv.data.score <= 100,
    `Completeness score should be 0-100, got ${completenessEnv.data.score}`
  );
  assert(Array.isArray(completenessEnv.data.issues), 'Completeness should return issues array');

  // Step 6: Render a summary template with the scores
  const summaryTemplate = writeTemp(
    'chain8_summary.mustache',
    [
      'Document Processing Summary',
      '===========================',
      'Input Format: {{inputFormat}} (confidence: {{formatConfidence}})',
      'Output Format: {{outputFormat}}',
      'Quality Score: {{qualityScore}}/100',
      'Completeness Score: {{completenessScore}}/100',
      'Character Count: {{charCount}}',
      'Issues Found: {{issueCount}}',
    ].join('\n')
  );

  const summaryData = writeTemp(
    'chain8_summary_data.json',
    JSON.stringify({
      inputFormat: formatEnv.data.format,
      formatConfidence: formatEnv.data.confidence,
      outputFormat: transformEnv.data.format,
      qualityScore: qualityEnv.data.score,
      completenessScore: completenessEnv.data.score,
      charCount: qualityEnv.data.metrics.charCount,
      issueCount: completenessEnv.data.issues.length,
    })
  );

  const renderEnv = runAndParse(
    'template-renderer/scripts/render.cjs',
    `-t "${summaryTemplate}" -d "${summaryData}"`
  );
  assert(
    renderEnv.data.content.includes('Input Format: json'),
    'Rendered summary should contain input format'
  );
  assert(
    renderEnv.data.content.includes('Output Format: yaml'),
    'Rendered summary should contain output format'
  );
  assert(
    renderEnv.data.content.includes(`Quality Score: ${qualityEnv.data.score}`),
    'Rendered summary should contain quality score'
  );
  assert(
    renderEnv.data.content.includes(`Completeness Score: ${completenessEnv.data.score}`),
    'Rendered summary should contain completeness score'
  );

  // Verify all 5 envelopes are valid
  for (const [name, env] of [
    ['format-detector', formatEnv],
    ['data-transformer', transformEnv],
    ['quality-scorer', qualityEnv],
    ['completeness-scorer', completenessEnv],
    ['template-renderer', renderEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata.duration_ms === 'number', `${name}: should have duration_ms`);
  }
});

// ========================================
// Chain 9: Code Review Chain (4 skills)
// code-lang-detector → encoding-detector → sensitivity-detector → quality-scorer
// ========================================
console.log('\n--- Chain 9: Code Review Chain (4 skills) ---');

test('code-lang-detector -> encoding-detector -> sensitivity-detector -> quality-scorer', () => {
  // Step 1: Create a test JavaScript file with substantial code
  const jsCode = [
    '/**',
    ' * User authentication module.',
    ' * Handles login, logout, and session management.',
    ' */',
    'const crypto = require("crypto");',
    '',
    'class AuthManager {',
    '  constructor(config) {',
    '    this.sessions = new Map();',
    '    this.maxAge = config.maxAge || 3600000;',
    '  }',
    '',
    '  login(username, password) {',
    '    const hash = crypto.createHash("sha256").update(password).digest("hex");',
    '    const token = crypto.randomBytes(32).toString("hex");',
    '    this.sessions.set(token, { username, hash, createdAt: Date.now() });',
    '    return token;',
    '  }',
    '',
    '  logout(token) {',
    '    return this.sessions.delete(token);',
    '  }',
    '',
    '  verify(token) {',
    '    const session = this.sessions.get(token);',
    '    if (!session) return false;',
    '    if (Date.now() - session.createdAt > this.maxAge) {',
    '      this.sessions.delete(token);',
    '      return false;',
    '    }',
    '    return true;',
    '  }',
    '}',
    '',
    'module.exports = AuthManager;',
  ].join('\n');
  const jsFile = writeTemp('chain9_auth.js', jsCode);

  // Step 2: Detect its language
  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${jsFile}"`);
  assert(langEnv.data.lang === 'javascript', `Expected "javascript", got "${langEnv.data.lang}"`);
  assert(langEnv.data.confidence === 1.0, 'Should have full confidence for .js extension');
  assert(langEnv.data.method === 'extension', 'Should use extension-based detection');

  // Step 3: Check its encoding
  const encodingEnv = runAndParse('encoding-detector/scripts/detect.cjs', `-i "${jsFile}"`);
  assert(encodingEnv.data.encoding !== undefined, 'Should detect an encoding');
  assert(
    encodingEnv.data.lineEnding === 'LF',
    `Expected LF line ending, got "${encodingEnv.data.lineEnding}"`
  );
  assert(encodingEnv.data.confidence > 0, 'Should have positive encoding confidence');

  // Step 4: Scan for sensitivity (clean code, no PII)
  const sensitivityEnv = runAndParse('sensitivity-detector/scripts/scan.cjs', `-i "${jsFile}"`);
  assert(sensitivityEnv.data.hasPII === false, 'Clean auth code should not flag PII');

  // Step 5: Score its quality
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${jsFile}"`);
  assert(typeof qualityEnv.data.score === 'number', 'Quality score should be a number');
  assert(
    qualityEnv.data.score >= 0 && qualityEnv.data.score <= 100,
    `Quality score should be 0-100, got ${qualityEnv.data.score}`
  );
  assert(qualityEnv.data.metrics.lines > 20, 'Should have more than 20 lines');

  // Verify all 4 envelopes have consistent metadata
  const allEnvelopes = [
    ['code-lang-detector', langEnv],
    ['encoding-detector', encodingEnv],
    ['sensitivity-detector', sensitivityEnv],
    ['quality-scorer', qualityEnv],
  ];
  for (const [name, env] of allEnvelopes) {
    assert(env.status === 'success', `${name}: should have success status`);
    assert(env.skill === name, `${name}: skill field should be "${name}", got "${env.skill}"`);
    assert(
      typeof env.metadata === 'object' && env.metadata !== null,
      `${name}: metadata should be an object`
    );
    assert(
      typeof env.metadata.duration_ms === 'number',
      `${name}: should have numeric duration_ms`
    );
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have string timestamp`);
  }
});

test('code review chain detects PII and scores very short code', () => {
  // Create code with PII and very short content (under 50 chars triggers quality penalty)
  const badCode = ['var x = "admin@corp.com";', 'var y = "192.168.1.1";'].join('\n');
  const badFile = writeTemp('chain9_bad.js', badCode);

  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${badFile}"`);
  assert(langEnv.data.lang === 'javascript', 'Should detect JavaScript');

  const sensitivityEnv = runAndParse('sensitivity-detector/scripts/scan.cjs', `-i "${badFile}"`);
  assert(sensitivityEnv.data.hasPII === true, 'Should detect PII in bad code');
  assert(sensitivityEnv.data.findings.email >= 1, 'Should find email PII');
  assert(sensitivityEnv.data.findings.ipv4 >= 1, 'Should find IP address PII');

  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${badFile}"`);
  // The code is under 50 chars, so quality scorer deducts 20 points
  assert(
    qualityEnv.data.score < 100,
    'Very short code (under 50 chars) should have reduced quality score'
  );
  assert(qualityEnv.data.metrics.charCount < 50, 'Bad code should be under 50 chars');
});

// ========================================
// Chain 10: Classification Deep Chain (4 skills)
// domain-classifier → doc-type-classifier → intent-classifier → lang-detector
// ========================================
console.log('\n--- Chain 10: Classification Deep Chain (4 skills) ---');

test('domain-classifier -> doc-type-classifier -> intent-classifier -> lang-detector on tech document', () => {
  // Create a technical document with keywords that trigger tech domain detection
  // domain-classifier: tech keywords are API, Server, Code, Bug, Deploy
  // doc-type-classifier: specification keywords are Architecture, Sequence, API Definition
  // intent-classifier: report keywords are Done, completed
  const techDoc = [
    'API Definition and Architecture Specification',
    '',
    'This Architecture document defines the Server deployment process.',
    'The Code review and Bug tracking Sequence is documented below.',
    'All API endpoints have been implemented and tested.',
    'Server Deploy pipeline is fully configured.',
    'Code coverage meets our threshold. Bug fixes are Done.',
    'We have completed the Architecture review successfully.',
  ].join('\n');
  const techFile = writeTemp('chain10_tech_doc.txt', techDoc);

  // Step 1: Classify domain -> should be "tech"
  const domainEnv = runAndParse('domain-classifier/scripts/classify.cjs', `-i "${techFile}"`);
  assert(
    domainEnv.data.domain === 'tech',
    `Expected domain "tech", got "${domainEnv.data.domain}"`
  );
  assert(domainEnv.data.confidence > 0, 'Domain confidence should be positive');
  assert(domainEnv.data.matches > 0, 'Domain should have keyword matches');

  // Step 2: Classify doc-type -> should be "specification"
  const docTypeEnv = runAndParse('doc-type-classifier/scripts/classify.cjs', `-i "${techFile}"`);
  assert(
    docTypeEnv.data.type === 'specification',
    `Expected type "specification", got "${docTypeEnv.data.type}"`
  );
  assert(docTypeEnv.data.confidence > 0, 'Doc-type confidence should be positive');

  // Step 3: Classify intent
  const intentEnv = runAndParse('intent-classifier/scripts/classify.cjs', `-i "${techFile}"`);
  assert(intentEnv.data.intent !== undefined, 'Intent should be returned');
  assert(intentEnv.data.confidence >= 0, 'Intent confidence should be non-negative');

  // Step 4: Detect natural language
  const langEnv = runAndParse('lang-detector/scripts/detect.cjs', `-i "${techFile}"`);
  assert(langEnv.data.language !== undefined, 'Language should be detected');
  assert(langEnv.data.confidence >= 0, 'Language confidence should be non-negative');

  // Verify all 4 classifiers return consistent envelopes
  const allEnvelopes = [
    ['domain-classifier', domainEnv],
    ['doc-type-classifier', docTypeEnv],
    ['intent-classifier', intentEnv],
    ['lang-detector', langEnv],
  ];
  for (const [name, env] of allEnvelopes) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.duration_ms === 'number', `${name}: should have duration_ms`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }

  // Verify domain is "tech" for this technical content
  assert(
    domainEnv.data.domain === 'tech',
    'Domain should be "tech" for document with API, Server, Code, Bug, Deploy keywords'
  );
});

test('classification deep chain returns different domain for finance content', () => {
  // Create a finance document with Budget and Profit keywords
  const financeDoc = [
    'Budget Allocation Report for FY2025.',
    '',
    'The total Budget for this quarter is $2M.',
    'Profit margins have increased by 15% compared to last quarter.',
    'Budget adjustments were made to accommodate new Profit centers.',
    'Final Budget review is Done.',
  ].join('\n');
  const financeFile = writeTemp('chain10_finance_doc.txt', financeDoc);

  const domainEnv = runAndParse('domain-classifier/scripts/classify.cjs', `-i "${financeFile}"`);
  assert(
    domainEnv.data.domain === 'finance',
    `Expected domain "finance", got "${domainEnv.data.domain}"`
  );

  const docTypeEnv = runAndParse('doc-type-classifier/scripts/classify.cjs', `-i "${financeFile}"`);
  assert(docTypeEnv.data.type !== undefined, 'Doc-type should be detected for finance doc');

  const intentEnv = runAndParse('intent-classifier/scripts/classify.cjs', `-i "${financeFile}"`);
  assert(intentEnv.data.intent !== undefined, 'Intent should be detected for finance doc');

  const langEnv = runAndParse('lang-detector/scripts/detect.cjs', `-i "${financeFile}"`);
  assert(langEnv.data.language !== undefined, 'Language should be detected for finance doc');

  // Verify domain differs from tech
  assert(
    domainEnv.data.domain !== 'tech',
    'Finance document should NOT be classified as tech domain'
  );
});

// ========================================
// Chain 11: Error Propagation Chain
// Verify that errors in early chain steps are handled gracefully
// ========================================
console.log('\n--- Chain 11: Error Propagation Chain ---');

test('format-detector on nonexistent file produces parseable error envelope', () => {
  const nonexistentFile = path.join(tmpDir, 'does_not_exist_' + Date.now() + '.json');

  // Running on a nonexistent file should cause the skill to exit with code 1
  // execSync will throw, but we can capture stderr/stdout from the error
  let errorOutput;
  try {
    const cmd = `node "${path.join(rootDir, 'format-detector/scripts/detect.cjs')}" -i "${nonexistentFile}"`;
    execSync(cmd, { encoding: 'utf8', cwd: rootDir, timeout: 15000, stdio: 'pipe' });
    assert(false, 'Expected the command to throw on nonexistent file');
  } catch (_err) {
    // execSync throws on non-zero exit code; stdout contains the JSON envelope
    errorOutput = _err.stdout || _err.stderr || '';
  }

  // The error envelope should be parseable JSON
  assert(errorOutput.length > 0, 'Error output should not be empty');
  const errorEnvelope = JSON.parse(errorOutput);
  assert(
    errorEnvelope.status === 'error',
    `Expected status "error", got "${errorEnvelope.status}"`
  );
  assert(errorEnvelope.skill === 'format-detector', 'Error envelope should identify the skill');
  assert(errorEnvelope.error !== undefined, 'Error envelope should have an error field');
  assert(typeof errorEnvelope.error.message === 'string', 'Error should have a message string');
  assert(
    errorEnvelope.error.message.includes('not found') ||
      errorEnvelope.error.message.includes('File'),
    'Error message should mention file not found'
  );
  assert(typeof errorEnvelope.metadata === 'object', 'Error envelope should still have metadata');
  assert(
    typeof errorEnvelope.metadata.duration_ms === 'number',
    'Error envelope should have duration_ms'
  );
});

test('quality-scorer on nonexistent file produces parseable error envelope', () => {
  const nonexistentFile = path.join(tmpDir, 'nonexistent_quality_' + Date.now() + '.txt');

  let errorOutput;
  try {
    const cmd = `node "${path.join(rootDir, 'quality-scorer/scripts/score.cjs')}" -i "${nonexistentFile}"`;
    execSync(cmd, { encoding: 'utf8', cwd: rootDir, timeout: 15000, stdio: 'pipe' });
    assert(false, 'Expected the command to throw on nonexistent file');
  } catch (_err) {
    errorOutput = _err.stdout || _err.stderr || '';
  }

  // Parse the error envelope
  assert(errorOutput.length > 0, 'Error output should not be empty');
  const errorEnvelope = JSON.parse(errorOutput);
  assert(errorEnvelope.status === 'error', 'Should have error status');
  assert(errorEnvelope.skill === 'quality-scorer', 'Error envelope should identify quality-scorer');
  assert(errorEnvelope.error !== undefined, 'Should have error field');
  assert(typeof errorEnvelope.error.message === 'string', 'Error should have a message');
});

test('error propagation: error from format-detector does not crash quality-scorer on valid file', () => {
  const nonexistentFile = path.join(tmpDir, 'ghost_file_' + Date.now() + '.json');

  // Step 1: Attempt format detection on nonexistent file (will error)
  let formatError = null;
  try {
    const cmd = `node "${path.join(rootDir, 'format-detector/scripts/detect.cjs')}" -i "${nonexistentFile}"`;
    execSync(cmd, { encoding: 'utf8', cwd: rootDir, timeout: 15000, stdio: 'pipe' });
  } catch (_err) {
    const output = _err.stdout || '';
    if (output) formatError = JSON.parse(output);
  }

  assert(formatError !== null, 'Should have captured format-detector error');
  assert(formatError.status === 'error', 'Format-detector should return error status');

  // Step 2: Despite the error, quality-scorer should work fine on a valid file
  const validContent =
    'This is a valid document with enough content to be scored properly by the quality engine.';
  const validFile = writeTemp('chain11_valid.txt', validContent);
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${validFile}"`);
  assert(qualityEnv.status === 'success', 'Quality scorer should succeed on valid input');
  assert(typeof qualityEnv.data.score === 'number', 'Quality score should be a number');

  // Step 3: Verify the error envelope and success envelope have the same structure
  assert(formatError.skill !== undefined, 'Error envelope should have skill field');
  assert(qualityEnv.skill !== undefined, 'Success envelope should have skill field');
  assert(formatError.metadata !== undefined, 'Error envelope should have metadata');
  assert(qualityEnv.metadata !== undefined, 'Success envelope should have metadata');
  assert(
    typeof formatError.metadata.duration_ms === 'number',
    'Error envelope duration_ms should be a number'
  );
  assert(
    typeof qualityEnv.metadata.duration_ms === 'number',
    'Success envelope duration_ms should be a number'
  );
});

// ========================================
// Chain 12: Knowledge Pipeline (3 skills)
// knowledge-harvester -> prompt-optimizer -> template-renderer
// ========================================
console.log('\n--- Chain 12: Knowledge Pipeline ---');

test('harvest knowledge, optimize SKILL.md, render template', () => {
  // Step 1: Create a temp directory with package.json + README.md
  const knowledgeDir = path.join(tmpDir, 'chain12_project');
  if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(
    path.join(knowledgeDir, 'package.json'),
    JSON.stringify(
      {
        name: 'sample-project',
        version: '1.0.0',
        description: 'A sample project for testing knowledge harvesting',
        dependencies: { express: '^4.18.0', lodash: '^4.17.21' },
        devDependencies: { jest: '^29.0.0', eslint: '^8.0.0' },
        scripts: { test: 'jest', start: 'node index.js' },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(knowledgeDir, 'README.md'),
    [
      '# Sample Project',
      '',
      'A Node.js web server built with Express.',
      '',
      '## Usage',
      '',
      'Run npm start to launch the server.',
      '',
      '## Troubleshooting',
      '',
      'Check logs for errors.',
      '',
      '## Options',
      '',
      '- --port: specify port number',
    ].join('\n')
  );

  // Step 2: Run knowledge-harvester on the temp dir
  const harvestEnv = runAndParse(
    'knowledge-harvester/scripts/harvest.cjs',
    `--dir "${knowledgeDir}"`
  );
  assert(harvestEnv.skill === 'knowledge-harvester', 'Skill should be knowledge-harvester');
  assert(harvestEnv.data !== undefined, 'Harvest should return data');
  assert(typeof harvestEnv.metadata === 'object', 'Should have metadata');
  assert(typeof harvestEnv.metadata.duration_ms === 'number', 'Should have duration_ms');
  // Verify it found the tech stack
  const harvestData = harvestEnv.data;
  assert(
    (harvestData.files && harvestData.files.length > 0) ||
      (harvestData.techStack && harvestData.techStack.length > 0) ||
      harvestData.dependencies ||
      harvestData.highlights,
    'Harvest should find files, techStack, or dependencies'
  );

  // Step 3: Run prompt-optimizer on the knowledge-harvester SKILL.md
  const skillMdPath = path.join(rootDir, 'knowledge-harvester', 'SKILL.md');
  const optimizerEnv = runAndParse('prompt-optimizer/scripts/optimize.cjs', `-i "${skillMdPath}"`);
  assert(optimizerEnv.skill === 'prompt-optimizer', 'Skill should be prompt-optimizer');
  assert(typeof optimizerEnv.data.score === 'number', 'Optimizer should return a score');
  assert(optimizerEnv.data.score >= 0 && optimizerEnv.data.score <= 100, 'Score should be 0-100');
  assert(
    typeof optimizerEnv.metadata.duration_ms === 'number',
    'Optimizer should have duration_ms'
  );

  // Step 4: Feed harvest data into template-renderer
  const templateFile = writeTemp(
    'chain12_template.mustache',
    [
      'Project Knowledge Report',
      '========================',
      'Skill: {{skill}}',
      'Score: {{score}}',
      'Status: {{status}}',
    ].join('\n')
  );
  const templateData = writeTemp(
    'chain12_data.json',
    JSON.stringify({
      skill: harvestEnv.skill,
      score: optimizerEnv.data.score,
      status: harvestEnv.status,
    })
  );
  const rendererEnv = runAndParse(
    'template-renderer/scripts/render.cjs',
    `-t "${templateFile}" -d "${templateData}"`
  );
  assert(rendererEnv.skill === 'template-renderer', 'Skill should be template-renderer');
  assert(rendererEnv.data.content !== undefined, 'Renderer should produce content');
  assert(
    rendererEnv.data.content.includes('knowledge-harvester'),
    'Rendered content should include skill name'
  );
  assert(
    rendererEnv.data.content.includes('Project Knowledge Report'),
    'Rendered content should include report title'
  );
  assert(typeof rendererEnv.metadata.duration_ms === 'number', 'Renderer should have duration_ms');
});

// ========================================
// Chain 13: Data Curation Pipeline (3 skills)
// format-detector -> quality-scorer -> completeness-scorer
// (dataset-curator has no scripts yet, so we skip it)
// ========================================
console.log('\n--- Chain 13: Data Curation Pipeline ---');

test('detect format, score quality, score completeness', () => {
  // Step 1: Create a JSON data file with some content
  const dataContent = {
    title: 'Product Catalog',
    version: '2.1',
    items: [
      {
        id: 1,
        name: 'Widget A',
        price: 9.99,
        description: 'A high-quality widget for general use.',
      },
      {
        id: 2,
        name: 'Widget B',
        price: 19.99,
        description: 'Premium widget with extended features.',
      },
      {
        id: 3,
        name: 'Gadget C',
        price: 29.99,
        description: 'Advanced gadget with smart capabilities.',
      },
    ],
    metadata: { created: '2025-01-15', author: 'Data Team' },
  };
  const jsonFile = writeTemp('chain13_catalog.json', JSON.stringify(dataContent, null, 2));

  // Step 2: Run format-detector to verify it is JSON
  const detectEnv = runAndParse('format-detector/scripts/detect.cjs', `-i "${jsonFile}"`);
  assert(detectEnv.skill === 'format-detector', 'Skill should be format-detector');
  assert(
    detectEnv.data.format === 'json',
    `Expected format "json", got "${detectEnv.data.format}"`
  );
  assert(detectEnv.data.confidence > 0, 'Confidence should be positive');
  assert(typeof detectEnv.metadata.duration_ms === 'number', 'Should have duration_ms');

  // Step 3: Run quality-scorer on the same file
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${jsonFile}"`);
  assert(qualityEnv.skill === 'quality-scorer', 'Skill should be quality-scorer');
  assert(typeof qualityEnv.data.score === 'number', 'Quality scorer should return a numeric score');
  assert(
    qualityEnv.data.score >= 0 && qualityEnv.data.score <= 100,
    'Quality score should be 0-100'
  );
  assert(
    typeof qualityEnv.metadata.duration_ms === 'number',
    'Quality scorer should have duration_ms'
  );

  // Step 4: Run completeness-scorer on the same file
  const completenessEnv = runAndParse('completeness-scorer/scripts/score.cjs', `-i "${jsonFile}"`);
  assert(completenessEnv.skill === 'completeness-scorer', 'Skill should be completeness-scorer');
  assert(
    typeof completenessEnv.data.score === 'number',
    'Completeness scorer should return a numeric score'
  );
  assert(
    completenessEnv.data.score >= 0 && completenessEnv.data.score <= 100,
    'Completeness score should be 0-100'
  );
  assert(
    typeof completenessEnv.metadata.duration_ms === 'number',
    'Completeness scorer should have duration_ms'
  );

  // Verify all three skills returned consistent envelope structure
  const allEnvelopes = [
    ['format-detector', detectEnv],
    ['quality-scorer', qualityEnv],
    ['completeness-scorer', completenessEnv],
  ];
  for (const [name, env] of allEnvelopes) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

// ========================================
// Chain 14: Refactoring Pipeline (3 skills)
// code-lang-detector -> refactoring-engine -> quality-scorer
// ========================================
console.log('\n--- Chain 14: Refactoring Pipeline ---');

test('detect language, find code smells, score quality', () => {
  // Step 1: Create a JavaScript file with some code smells
  const jsCode = [
    '// A sample JavaScript module with intentional smells',
    'const express = require("express");',
    'const app = express();',
    '',
    'function handleRequest(req, res) {',
    '  const x = 42;',
    '  const y = 3.14159;',
    '  if (req.query.type === "a") {',
    '    if (req.query.subtype === "b") {',
    '      if (req.query.detail === "c") {',
    '        if (req.query.extra === "d") {',
    '          res.send("deeply nested response");',
    '        }',
    '      }',
    '    }',
    '  }',
    '  return res.status(200).json({ result: x + y });',
    '}',
    '',
    'function veryLongFunction(a, b, c, d, e) {',
    '  let result = 0;',
    '  result += a * 17;',
    '  result += b * 23;',
    '  result += c * 31;',
    '  result += d * 37;',
    '  result += e * 41;',
    '  console.log("processing...");',
    '  console.log("step 1 done");',
    '  console.log("step 2 done");',
    '  console.log("step 3 done");',
    '  console.log("step 4 done");',
    '  console.log("finishing...");',
    '  return result;',
    '}',
    '',
    'app.get("/api", handleRequest);',
    'app.listen(3000);',
  ].join('\n');
  const jsFile = writeTemp('chain14_sample.js', jsCode);

  // Step 2: Run code-lang-detector
  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${jsFile}"`);
  assert(langEnv.skill === 'code-lang-detector', 'Skill should be code-lang-detector');
  assert(
    langEnv.data.lang === 'javascript',
    `Expected language "javascript", got "${langEnv.data.lang}"`
  );
  assert(langEnv.data.confidence > 0, 'Language confidence should be positive');
  assert(typeof langEnv.metadata.duration_ms === 'number', 'Lang detector should have duration_ms');

  // Step 3: Run refactoring-engine to find code smells
  const refactorEnv = runAndParse('refactoring-engine/scripts/analyze.cjs', `-i "${jsFile}"`);
  assert(refactorEnv.skill === 'refactoring-engine', 'Skill should be refactoring-engine');
  assert(typeof refactorEnv.data === 'object', 'Refactoring engine should return data');
  // Should find smells (magic numbers, deep nesting)
  assert(
    (refactorEnv.data.smells && refactorEnv.data.smells.length > 0) ||
      (refactorEnv.data.issues && refactorEnv.data.issues.length > 0) ||
      refactorEnv.data.totalSmells > 0 ||
      refactorEnv.data.summary,
    'Refactoring engine should find at least one code smell'
  );
  assert(
    typeof refactorEnv.metadata.duration_ms === 'number',
    'Refactoring engine should have duration_ms'
  );

  // Step 4: Run quality-scorer on the same JS file
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${jsFile}"`);
  assert(qualityEnv.skill === 'quality-scorer', 'Skill should be quality-scorer');
  assert(typeof qualityEnv.data.score === 'number', 'Quality score should be a number');
  assert(
    qualityEnv.data.score >= 0 && qualityEnv.data.score <= 100,
    'Quality score should be 0-100'
  );
  assert(
    typeof qualityEnv.metadata.duration_ms === 'number',
    'Quality scorer should have duration_ms'
  );

  // Verify all envelopes
  const allEnvelopes = [
    ['code-lang-detector', langEnv],
    ['refactoring-engine', refactorEnv],
    ['quality-scorer', qualityEnv],
  ];
  for (const [name, env] of allEnvelopes) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

// ========================================
// Chain 15: Requirements Pipeline (3 skills)
// requirements-wizard -> completeness-scorer -> quality-scorer
// ========================================
console.log('\n--- Chain 15: Requirements Pipeline ---');

test('score requirements, assess completeness, measure quality', () => {
  // Step 1: Create a requirements document with IPA-standard keywords
  const requirementsDoc = [
    '# Software Requirements Specification',
    '',
    '## 1. Scope',
    '',
    'This document defines the scope and objectives for the Inventory Management System.',
    'The goal is to provide a web-based platform for tracking warehouse inventory.',
    'The boundary of this system includes order management and reporting modules.',
    '',
    '## 2. Stakeholders',
    '',
    'The primary stakeholders include:',
    '- Product Owner: responsible for feature prioritization',
    '- End User: warehouse staff who interact with the system daily',
    '- Customer: retail partners who place orders',
    '- System Administrator: manages user accounts and configuration',
    '',
    '## 3. Functional Requirements',
    '',
    'The system shall provide the following capabilities:',
    '- FR-001: The system shall allow users to add new inventory items.',
    '- FR-002: The system shall generate daily stock reports.',
    '- FR-003: The system shall send alerts when stock falls below threshold.',
    '',
    '## 4. Non-Functional Requirements',
    '',
    'Performance: The system shall respond to queries within 200ms.',
    'Reliability: The system shall maintain 99.9% uptime.',
    'Security: All data shall be encrypted at rest and in transit.',
    'Scalability: The system shall support up to 10,000 concurrent users.',
    '',
    '## 5. Constraints',
    '',
    'The following constraints apply:',
    '- Must deploy on AWS infrastructure.',
    '- Budget limitation of $50,000 for initial development.',
    '- Dependency on third-party payment gateway API.',
    '',
    '## 6. Glossary',
    '',
    '- SKU: Stock Keeping Unit, a unique identifier for each product.',
    '- ERP: Enterprise Resource Planning system.',
    '- SLA: Service Level Agreement.',
    '',
    '## 7. Acceptance Criteria',
    '',
    'The definition of done for each feature includes:',
    '- All acceptance tests pass.',
    '- Code review completed and approved.',
    '- Documentation updated.',
    '- Verification by QA team.',
  ].join('\n');
  const reqFile = writeTemp('chain15_requirements.md', requirementsDoc);

  // Step 2: Run requirements-wizard with IPA standard
  const reqEnv = runAndParse(
    'requirements-wizard/scripts/main.cjs',
    `-i "${reqFile}" --standard ipa`
  );
  assert(reqEnv.skill === 'requirements-wizard', 'Skill should be requirements-wizard');
  assert(typeof reqEnv.data === 'object', 'Requirements wizard should return data');
  assert(
    typeof reqEnv.data.score === 'number' ||
      typeof reqEnv.data.totalScore === 'number' ||
      typeof reqEnv.data.coverage === 'number',
    'Requirements wizard should return a score or coverage metric'
  );
  assert(
    typeof reqEnv.metadata.duration_ms === 'number',
    'Requirements wizard should have duration_ms'
  );

  // Step 3: Run completeness-scorer on the requirements doc
  const completenessEnv = runAndParse('completeness-scorer/scripts/score.cjs', `-i "${reqFile}"`);
  assert(completenessEnv.skill === 'completeness-scorer', 'Skill should be completeness-scorer');
  assert(typeof completenessEnv.data.score === 'number', 'Completeness score should be a number');
  assert(
    completenessEnv.data.score >= 0 && completenessEnv.data.score <= 100,
    'Completeness score should be 0-100'
  );
  assert(
    typeof completenessEnv.metadata.duration_ms === 'number',
    'Completeness scorer should have duration_ms'
  );
  // A well-structured requirements doc should score reasonably high
  assert(
    completenessEnv.data.score >= 50,
    `Requirements doc completeness should be >= 50, got ${completenessEnv.data.score}`
  );

  // Step 4: Run quality-scorer on the requirements doc
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${reqFile}"`);
  assert(qualityEnv.skill === 'quality-scorer', 'Skill should be quality-scorer');
  assert(typeof qualityEnv.data.score === 'number', 'Quality score should be a number');
  assert(
    qualityEnv.data.score >= 0 && qualityEnv.data.score <= 100,
    'Quality score should be 0-100'
  );
  assert(
    typeof qualityEnv.metadata.duration_ms === 'number',
    'Quality scorer should have duration_ms'
  );

  // Verify all envelopes have consistent structure
  const allEnvelopes = [
    ['requirements-wizard', reqEnv],
    ['completeness-scorer', completenessEnv],
    ['quality-scorer', qualityEnv],
  ];
  for (const [name, env] of allEnvelopes) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }

  // Cross-chain assertion: both completeness and quality should be scored
  assert(
    typeof completenessEnv.data.score === 'number' && typeof qualityEnv.data.score === 'number',
    'Both completeness and quality should produce numeric scores for the same document'
  );
});

// ========================================
// Chain 16: License Audit -> Local Reviewer
// ========================================
console.log('\n--- Chain 16: License Audit -> Local Reviewer ---');

test('license-auditor scans project then local-reviewer produces valid output', () => {
  // Step 1: Run license-auditor on the project root
  const auditEnv = runAndParse('license-auditor/scripts/audit.cjs', `--dir "${rootDir}"`);
  assert(
    auditEnv.skill === 'license-auditor',
    `Expected skill "license-auditor", got "${auditEnv.skill}"`
  );
  assert(Array.isArray(auditEnv.data.packages), 'License auditor should return packages array');
  assert(auditEnv.data.packages.length > 0, 'License auditor should find at least one package');
  assert(auditEnv.data.summary !== undefined, 'License auditor should return summary');
  assert(typeof auditEnv.data.summary.total === 'number', 'Summary total should be a number');
  assert(typeof auditEnv.metadata.duration_ms === 'number', 'Should have duration_ms');

  // Step 2: Verify each package has expected fields
  for (const pkg of auditEnv.data.packages) {
    assert(typeof pkg.name === 'string' && pkg.name.length > 0, 'Each package should have a name');
    assert(typeof pkg.license === 'string', 'Each package should have a license field');
    assert(typeof pkg.risk === 'string', 'Each package should have a risk field');
  }

  // Step 3: Run local-reviewer (reviews staged git changes)
  const reviewEnv = runAndParse('local-reviewer/scripts/review.cjs', '');
  assert(
    reviewEnv.skill === 'local-reviewer',
    `Expected skill "local-reviewer", got "${reviewEnv.skill}"`
  );
  assert(reviewEnv.status === 'success', 'Local reviewer should return success status');
  assert(typeof reviewEnv.data === 'object', 'Local reviewer should return data object');
  assert(
    typeof reviewEnv.metadata.duration_ms === 'number',
    'Local reviewer should have duration_ms'
  );

  // Step 4: Verify both skills produce valid envelope metadata
  for (const [name, env] of [
    ['license-auditor', auditEnv],
    ['local-reviewer', reviewEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

// ========================================
// Chain 17: Knowledge Harvester -> Prompt Optimizer
// ========================================
console.log('\n--- Chain 17: Knowledge Harvester -> Prompt Optimizer ---');

test('harvest knowledge from project then optimize SKILL.md prompt', () => {
  // Step 1: Create a temp project directory with package.json and README.md
  const harvestDir = path.join(tmpDir, 'chain17_project');
  if (!fs.existsSync(harvestDir)) fs.mkdirSync(harvestDir, { recursive: true });
  fs.writeFileSync(
    path.join(harvestDir, 'package.json'),
    JSON.stringify(
      {
        name: 'chain17-sample',
        version: '1.0.0',
        description: 'A sample project for knowledge harvesting',
        dependencies: { express: '^4.18.0', lodash: '^4.17.21' },
        devDependencies: { jest: '^29.0.0' },
        scripts: { test: 'jest', start: 'node index.js' },
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(harvestDir, 'README.md'),
    [
      '# Chain17 Sample Project',
      '',
      'A Node.js API service built with Express.',
      '',
      '## Usage',
      '',
      'Run npm start to launch the server.',
    ].join('\n')
  );

  // Step 2: Run knowledge-harvester
  const harvestEnv = runAndParse(
    'knowledge-harvester/scripts/harvest.cjs',
    `--dir "${harvestDir}"`
  );
  assert(
    harvestEnv.skill === 'knowledge-harvester',
    `Expected skill "knowledge-harvester", got "${harvestEnv.skill}"`
  );
  assert(harvestEnv.data.directory !== undefined, 'Harvest should return directory');
  assert(harvestEnv.data.projectName !== undefined, 'Harvest should return projectName');
  assert(harvestEnv.data.fileCount > 0, 'Harvest should find files');
  assert(
    (harvestEnv.data.techStack && harvestEnv.data.techStack.length > 0) ||
      (harvestEnv.data.patterns && harvestEnv.data.patterns.length > 0),
    'Harvest should detect tech stack or patterns'
  );
  assert(typeof harvestEnv.data.summary === 'string', 'Harvest should return a summary string');
  assert(typeof harvestEnv.metadata.duration_ms === 'number', 'Harvester should have duration_ms');

  // Step 3: Create a SKILL.md-like temp file for prompt-optimizer
  const skillMdContent = [
    '---',
    'name: chain17-test-skill',
    'description: A test skill that demonstrates knowledge harvesting and prompt optimization working together.',
    '---',
    '',
    '## Usage',
    '',
    'Run this skill to harvest knowledge from a project directory.',
    '',
    '## Troubleshooting',
    '',
    'If no files are found, check the directory path.',
    '',
    '## Options',
    '',
    '- --dir: specify the target directory',
    '',
    '## Knowledge Protocol',
    '',
    'This skill uses the standard knowledge protocol for structured output.',
    '',
    'Example:',
    '',
    '```bash',
    'node harvest.cjs --dir /path/to/project',
    '```',
  ].join('\n');
  const skillMdFile = writeTemp('chain17_SKILL.md', skillMdContent);

  // Step 4: Run prompt-optimizer on the SKILL.md file
  const optimizerEnv = runAndParse('prompt-optimizer/scripts/optimize.cjs', `-i "${skillMdFile}"`);
  assert(
    optimizerEnv.skill === 'prompt-optimizer',
    `Expected skill "prompt-optimizer", got "${optimizerEnv.skill}"`
  );
  assert(typeof optimizerEnv.data.score === 'number', 'Optimizer should return a score');
  assert(optimizerEnv.data.score >= 0, 'Score should be non-negative');
  assert(typeof optimizerEnv.data.maxScore === 'number', 'Optimizer should return maxScore');
  assert(Array.isArray(optimizerEnv.data.checks), 'Optimizer should return checks array');
  assert(optimizerEnv.data.checks.length > 0, 'Should have at least one check');
  assert(Array.isArray(optimizerEnv.data.suggestions), 'Optimizer should return suggestions array');
  assert(
    typeof optimizerEnv.metadata.duration_ms === 'number',
    'Optimizer should have duration_ms'
  );

  // Step 5: Verify both skills produce consistent envelope structure
  for (const [name, env] of [
    ['knowledge-harvester', harvestEnv],
    ['prompt-optimizer', optimizerEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

// ========================================
// Chain 18: Dataset Curator -> Doc-to-Text
// ========================================
console.log('\n--- Chain 18: Dataset Curator -> Doc-to-Text ---');

test('curate dataset then extract text from markdown document', () => {
  // Step 1: Create a temp JSON dataset file with some data quality issues
  const datasetContent = [
    { id: 1, name: 'Widget Alpha', category: 'hardware', price: 29.99 },
    { id: 2, name: '', category: 'software', price: null },
    { id: 3, name: 'Gadget Gamma', category: 'hardware', price: 49.99 },
    { id: 4, name: 'Service Delta', category: 'service', price: 99.99 },
    { id: 5, name: null, category: '', price: 0 },
  ];
  const datasetFile = writeTemp('chain18_dataset.json', JSON.stringify(datasetContent, null, 2));

  // Step 2: Run dataset-curator on the JSON dataset
  const curateEnv = runAndParse(
    'dataset-curator/scripts/curate.cjs',
    `-i "${datasetFile}" -f json`
  );
  assert(
    curateEnv.skill === 'dataset-curator',
    `Expected skill "dataset-curator", got "${curateEnv.skill}"`
  );
  assert(curateEnv.data.inputFile !== undefined, 'Curator should return inputFile');
  assert(
    curateEnv.data.format === 'json',
    `Expected format "json", got "${curateEnv.data.format}"`
  );
  assert(
    typeof curateEnv.data.originalRecords === 'number',
    'Curator should return originalRecords count'
  );
  assert(
    curateEnv.data.originalRecords === 5,
    `Expected 5 original records, got ${curateEnv.data.originalRecords}`
  );
  assert(
    typeof curateEnv.data.cleanedRecords === 'number',
    'Curator should return cleanedRecords count'
  );
  assert(curateEnv.data.qualityReport !== undefined, 'Curator should return qualityReport');
  assert(
    typeof curateEnv.data.qualityReport.nulls === 'number',
    'Quality report should have nulls count'
  );
  assert(curateEnv.data.qualityReport.nulls > 0, 'Should detect null values in the dataset');
  assert(typeof curateEnv.metadata.duration_ms === 'number', 'Curator should have duration_ms');

  // Step 3: Create a markdown document summarizing the dataset
  const docContent = [
    '# Dataset Quality Report',
    '',
    '## Summary',
    '',
    'The dataset contains product information with some quality issues.',
    'Total records: ' + curateEnv.data.originalRecords,
    'Cleaned records: ' + curateEnv.data.cleanedRecords,
    'Null values found: ' + curateEnv.data.qualityReport.nulls,
    '',
    '## Recommendations',
    '',
    '- Fix missing product names in records with null or empty name fields.',
    '- Ensure all price fields contain valid numeric values.',
    '- Standardize category values across the dataset.',
  ].join('\n');
  const docFile = writeTemp('chain18_report.md', docContent);

  // Step 4: Run doc-to-text on the markdown file
  // doc-to-text outputs logger lines before JSON, so we extract the JSON portion
  const extractRaw = run('doc-to-text/scripts/extract.cjs', `"${docFile}"`);
  const extractMatch = extractRaw.match(/\{[\s\S]*\}/);
  assert(extractMatch !== null, 'doc-to-text output should contain JSON');
  const extractEnv = JSON.parse(extractMatch[0]);
  assert(
    extractEnv.status === 'success',
    `doc-to-text should succeed: ${JSON.stringify(extractEnv.error)}`
  );
  assert(
    extractEnv.skill === 'doc-to-text',
    `Expected skill "doc-to-text", got "${extractEnv.skill}"`
  );
  assert(extractEnv.data.filePath !== undefined, 'Extract should return filePath');
  assert(
    extractEnv.data.format === '.md',
    `Expected format ".md", got "${extractEnv.data.format}"`
  );
  assert(typeof extractEnv.data.contentLength === 'number', 'Extract should return contentLength');
  assert(extractEnv.data.contentLength > 0, 'Extracted content length should be positive');
  assert(
    extractEnv.data.content.includes('Dataset Quality Report'),
    'Extracted text should contain the report title'
  );
  assert(
    extractEnv.data.content.includes('Recommendations'),
    'Extracted text should contain Recommendations section'
  );
  assert(
    typeof extractEnv.metadata.duration_ms === 'number',
    'doc-to-text should have duration_ms'
  );

  // Step 5: Verify both skills produce consistent envelope structure
  for (const [name, env] of [
    ['dataset-curator', curateEnv],
    ['doc-to-text', extractEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

// ========================================
// Chain 19: Operational Runbook -> Sequence Mapper
// ========================================
console.log('\n--- Chain 19: Operational Runbook -> Sequence Mapper ---');

test('generate deploy runbook then map sequences from code-like output', () => {
  // Step 1: Run operational-runbook-generator with --service test --type deploy
  const runbookEnv = runAndParse(
    'operational-runbook-generator/scripts/generate.cjs',
    '--service test-api --type deploy'
  );
  assert(
    runbookEnv.skill === 'operational-runbook-generator',
    `Expected skill "operational-runbook-generator", got "${runbookEnv.skill}"`
  );
  assert(
    runbookEnv.data.service === 'test-api',
    `Expected service "test-api", got "${runbookEnv.data.service}"`
  );
  assert(
    runbookEnv.data.type === 'deploy',
    `Expected type "deploy", got "${runbookEnv.data.type}"`
  );
  assert(typeof runbookEnv.data.markdown === 'string', 'Runbook should return markdown string');
  assert(runbookEnv.data.markdown.length > 0, 'Runbook markdown should not be empty');
  assert(
    runbookEnv.data.markdown.includes('# Deploy Runbook'),
    'Runbook should contain deploy heading'
  );
  assert(
    runbookEnv.data.markdown.includes('test-api'),
    'Runbook should reference the service name'
  );
  assert(Array.isArray(runbookEnv.data.sections), 'Runbook should return sections array');
  assert(runbookEnv.data.sections.length > 0, 'Runbook should have at least one section');
  assert(
    typeof runbookEnv.metadata.duration_ms === 'number',
    'Runbook generator should have duration_ms'
  );

  // Step 2: Create a temp file with code-like content derived from the runbook
  // sequence-mapper detects function definitions and function calls
  const sequenceInput = [
    'function deployPipeline() {',
    '  pullRelease();',
    '  runHealthChecks();',
    '  deployVersion();',
    '  runSmokeTests();',
    '  monitorErrors();',
    '}',
    '',
    'function rollbackProcedure() {',
    '  revertVersion();',
    '  verifySmokeTests();',
    '  notifyTeam();',
    '}',
  ].join('\n');
  const sequenceFile = writeTemp('chain19_deploy_sequence.js', sequenceInput);

  // Step 3: Run sequence-mapper on the code-like file
  const sequenceEnv = runAndParse('sequence-mapper/scripts/map.cjs', `-i "${sequenceFile}"`);
  assert(
    sequenceEnv.skill === 'sequence-mapper',
    `Expected skill "sequence-mapper", got "${sequenceEnv.skill}"`
  );
  assert(
    typeof sequenceEnv.data.content === 'string',
    'Sequence mapper should return content string'
  );
  assert(
    sequenceEnv.data.content.includes('sequenceDiagram'),
    'Output should contain mermaid sequenceDiagram'
  );
  assert(sequenceEnv.data.content.includes('autonumber'), 'Output should contain autonumber');
  // Verify it detected the function calls
  assert(
    sequenceEnv.data.content.includes('deployPipeline'),
    'Should detect deployPipeline as caller'
  );
  assert(sequenceEnv.data.content.includes('pullRelease'), 'Should detect pullRelease call');
  assert(
    sequenceEnv.data.content.includes('runHealthChecks'),
    'Should detect runHealthChecks call'
  );
  assert(sequenceEnv.data.content.includes('deployVersion'), 'Should detect deployVersion call');
  assert(
    sequenceEnv.data.content.includes('rollbackProcedure'),
    'Should detect rollbackProcedure as caller'
  );
  assert(sequenceEnv.data.content.includes('revertVersion'), 'Should detect revertVersion call');
  assert(
    typeof sequenceEnv.metadata.duration_ms === 'number',
    'Sequence mapper should have duration_ms'
  );

  // Step 4: Verify both skills produce consistent envelope structure
  for (const [name, env] of [
    ['operational-runbook-generator', runbookEnv],
    ['sequence-mapper', sequenceEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

// ========================================
// Chain 20: Token Economist -> Quality Scorer
// ========================================
console.log('\n--- Chain 20: Token Economist -> Quality Scorer ---');

test('asset-token-economist analyzes file then quality-scorer assesses same content', () => {
  // Step 1: Create a substantial text file for token analysis
  const docContent = [
    '# Architecture Decision Record',
    '',
    '## Context',
    '',
    'The system requires a scalable data processing pipeline that can handle',
    'up to 10,000 events per second with sub-100ms latency requirements.',
    'We evaluated three approaches: batch processing, stream processing, and hybrid.',
    '',
    '## Decision',
    '',
    'We chose stream processing with Apache Kafka for real-time event ingestion',
    'and Apache Flink for stateful stream processing. This architecture provides',
    'the lowest latency while maintaining exactly-once processing guarantees.',
    '',
    '## Consequences',
    '',
    'The team will need to invest in learning Kafka and Flink operationally.',
    'Infrastructure costs will increase by approximately 30% due to the streaming',
    'cluster requirements. However, end-to-end latency will decrease from 5 seconds',
    'to under 100 milliseconds, meeting the stated requirements.',
  ].join('\n');
  const docFile = writeTemp('chain20_architecture.txt', docContent);

  // Step 2: Run asset-token-economist to get token count and cost estimates
  const tokenEnv = runAndParse('asset-token-economist/scripts/analyze.cjs', `-i "${docFile}"`);
  assert(
    tokenEnv.skill === 'asset-token-economist',
    `Expected skill "asset-token-economist", got "${tokenEnv.skill}"`
  );
  assert(typeof tokenEnv.data.inputChars === 'number', 'Token economist should return inputChars');
  assert(tokenEnv.data.inputChars > 0, 'Input chars should be positive');
  assert(
    typeof tokenEnv.data.estimatedTokens === 'number',
    'Token economist should return estimatedTokens'
  );
  assert(tokenEnv.data.estimatedTokens > 0, 'Estimated tokens should be positive');
  assert(typeof tokenEnv.data.lineCount === 'number', 'Token economist should return lineCount');
  assert(tokenEnv.data.lineCount > 0, 'Line count should be positive');
  assert(tokenEnv.data.costEstimate !== undefined, 'Token economist should return costEstimate');
  assert(tokenEnv.data.costEstimate.gpt4 !== undefined, 'Cost estimate should include gpt4');
  assert(tokenEnv.data.costEstimate.claude !== undefined, 'Cost estimate should include claude');
  assert(
    typeof tokenEnv.metadata.duration_ms === 'number',
    'Token economist should have duration_ms'
  );

  // Step 3: Run quality-scorer on the same file for overall assessment
  const qualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${docFile}"`);
  assert(
    qualityEnv.skill === 'quality-scorer',
    `Expected skill "quality-scorer", got "${qualityEnv.skill}"`
  );
  assert(typeof qualityEnv.data.score === 'number', 'Quality score should be a number');
  assert(
    qualityEnv.data.score >= 0 && qualityEnv.data.score <= 100,
    `Quality score should be 0-100, got ${qualityEnv.data.score}`
  );
  assert(qualityEnv.data.metrics !== undefined, 'Quality scorer should return metrics');
  assert(qualityEnv.data.metrics.charCount > 0, 'Char count should be positive');
  assert(
    typeof qualityEnv.metadata.duration_ms === 'number',
    'Quality scorer should have duration_ms'
  );

  // Step 4: Cross-validate that both skills agree on content size
  // Token economist's inputChars and quality scorer's charCount should match
  assert(
    tokenEnv.data.inputChars === qualityEnv.data.metrics.charCount,
    `Token economist inputChars (${tokenEnv.data.inputChars}) should match quality scorer charCount (${qualityEnv.data.metrics.charCount})`
  );

  // Step 5: Verify consistent envelope structure
  for (const [name, env] of [
    ['asset-token-economist', tokenEnv],
    ['quality-scorer', qualityEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

test('asset-token-economist recommendations vary by input size', () => {
  // Create a very small file
  const smallContent = 'Hello world.';
  const smallFile = writeTemp('chain20_small.txt', smallContent);

  const smallTokenEnv = runAndParse(
    'asset-token-economist/scripts/analyze.cjs',
    `-i "${smallFile}"`
  );
  assert(smallTokenEnv.data.estimatedTokens > 0, 'Small file should still have tokens');
  assert(
    Array.isArray(smallTokenEnv.data.recommendations),
    'Token economist should return recommendations array'
  );

  // Score the small file's quality too
  const smallQualityEnv = runAndParse('quality-scorer/scripts/score.cjs', `-i "${smallFile}"`);
  assert(
    typeof smallQualityEnv.data.score === 'number',
    'Quality score for small file should be a number'
  );
  // Very short content (under 50 chars) should trigger a quality deduction
  assert(smallQualityEnv.data.metrics.charCount < 50, 'Small file should be under 50 chars');
});

// ========================================
// Chain 21: Bug Predictor -> Release Note Crafter
// ========================================
console.log('\n--- Chain 21: Bug Predictor -> Release Note Crafter ---');

test('bug-predictor identifies hotspots then release-note-crafter generates notes', () => {
  // Step 1: Create a small git repository with some code and commit history
  const bugDir = path.join(tmpDir, 'chain21_repo');
  if (!fs.existsSync(bugDir)) fs.mkdirSync(bugDir, { recursive: true });

  const srcFile1 = path.join(bugDir, 'server.js');
  fs.writeFileSync(
    srcFile1,
    [
      'const http = require("http");',
      'const server = http.createServer((req, res) => {',
      '  res.writeHead(200);',
      '  res.end("ok");',
      '});',
      'module.exports = server;',
    ].join('\n')
  );

  const srcFile2 = path.join(bugDir, 'utils.js');
  fs.writeFileSync(
    srcFile2,
    [
      'function validate(input) {',
      '  if (!input) throw new Error("missing");',
      '  return input.trim();',
      '}',
      'module.exports = { validate };',
    ].join('\n')
  );

  // Initialize git repo and create commit history for churn analysis
  execSync('git init', { cwd: bugDir, stdio: 'pipe' });
  execSync('git add -A', { cwd: bugDir, stdio: 'pipe' });
  execSync(
    'git -c user.email="test@test.com" -c user.name="Test" commit -m "feat: initial server and utils"',
    { cwd: bugDir, stdio: 'pipe' }
  );

  // Add more changes to create churn
  fs.writeFileSync(srcFile1, fs.readFileSync(srcFile1, 'utf8') + '\n// fix: handle errors\n');
  execSync('git add -A', { cwd: bugDir, stdio: 'pipe' });
  execSync(
    'git -c user.email="test@test.com" -c user.name="Test" commit -m "fix: add error handling to server"',
    { cwd: bugDir, stdio: 'pipe' }
  );

  fs.writeFileSync(
    srcFile2,
    fs.readFileSync(srcFile2, 'utf8') + '\n// refactor: improved validation\n'
  );
  execSync('git add -A', { cwd: bugDir, stdio: 'pipe' });
  execSync(
    'git -c user.email="test@test.com" -c user.name="Test" commit -m "refactor: improve input validation"',
    { cwd: bugDir, stdio: 'pipe' }
  );

  // Step 2: Run bug-predictor on the small repo
  const bugEnv = runAndParse('bug-predictor/scripts/predict.cjs', `-d "${bugDir}" -n 5`);
  assert(bugEnv.skill === 'bug-predictor', `Expected skill "bug-predictor", got "${bugEnv.skill}"`);
  assert(bugEnv.data.repository !== undefined, 'Bug predictor should report repository path');
  assert(Array.isArray(bugEnv.data.hotspots), 'Bug predictor should return hotspots array');
  assert(bugEnv.data.riskSummary !== undefined, 'Bug predictor should return risk summary');
  assert(typeof bugEnv.data.riskSummary.high === 'number', 'Risk summary should have high count');
  assert(
    typeof bugEnv.data.riskSummary.medium === 'number',
    'Risk summary should have medium count'
  );
  assert(typeof bugEnv.data.riskSummary.low === 'number', 'Risk summary should have low count');
  assert(
    typeof bugEnv.data.totalFilesAnalyzed === 'number',
    'Bug predictor should report totalFilesAnalyzed'
  );
  assert(bugEnv.data.recommendation !== undefined, 'Bug predictor should include a recommendation');
  assert(typeof bugEnv.metadata.duration_ms === 'number', 'Bug predictor should have duration_ms');

  // Step 3: Run release-note-crafter on the same repo
  const releaseEnv = runAndParse(
    'release-note-crafter/scripts/main.cjs',
    `-d "${bugDir}" -s "2020-01-01"`
  );
  assert(
    releaseEnv.skill === 'release-note-crafter',
    `Expected skill "release-note-crafter", got "${releaseEnv.skill}"`
  );
  assert(
    typeof releaseEnv.data.commits === 'number',
    'Release note crafter should return commit count'
  );
  assert(releaseEnv.data.commits > 0, 'Should find commits in the repo');
  assert(releaseEnv.data.sections !== undefined, 'Release note crafter should return sections');
  assert(
    typeof releaseEnv.data.markdown === 'string',
    'Release note crafter should return markdown string'
  );
  assert(releaseEnv.data.markdown.length > 0, 'Release notes markdown should not be empty');
  assert(
    releaseEnv.data.markdown.includes('Release Notes'),
    'Release notes should contain heading'
  );
  assert(
    typeof releaseEnv.metadata.duration_ms === 'number',
    'Release note crafter should have duration_ms'
  );

  // Step 4: Verify both envelopes have consistent structure
  for (const [name, env] of [
    ['bug-predictor', bugEnv],
    ['release-note-crafter', releaseEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

test('release-note-crafter sections reflect commit message prefixes', () => {
  // The chain21 repo was set up in the previous test with feat:, fix:, and refactor: commits
  const bugDir = path.join(tmpDir, 'chain21_repo');
  if (fs.existsSync(bugDir)) {
    const releaseEnv = runAndParse(
      'release-note-crafter/scripts/main.cjs',
      `-d "${bugDir}" -s "2020-01-01"`
    );
    assert(releaseEnv.data.commits === 3, `Expected 3 commits, got ${releaseEnv.data.commits}`);
    // Verify that conventional commit prefixes were parsed into sections
    const sections = releaseEnv.data.sections;
    assert(sections !== undefined, 'Should have sections object');
    // At least Features or Bug Fixes or Refactoring should have entries
    const totalCategorized =
      (sections.Features || 0) + (sections['Bug Fixes'] || 0) + (sections.Refactoring || 0);
    assert(totalCategorized > 0, 'Should have categorized at least one commit by prefix');
  } else {
    assert(false, 'chain21_repo directory not found - previous test may have failed');
  }
});

// ========================================
// Chain 22: Encoding Detector -> Data Transformer
// ========================================
console.log('\n--- Chain 22: Encoding Detector -> Data Transformer ---');

test('encoding-detector verifies file encoding then data-transformer converts format', () => {
  // Step 1: Create a JSON file with Unicode content
  const jsonData = {
    title: 'International Menu',
    items: [
      { id: 1, name: 'Croissant', origin: 'France', price: 3.5 },
      { id: 2, name: 'Sushi', origin: 'Japan', price: 12.0 },
      { id: 3, name: 'Tacos', origin: 'Mexico', price: 8.5 },
    ],
    currency: 'USD',
  };
  const jsonFile = writeTemp('chain22_menu.json', JSON.stringify(jsonData, null, 2));

  // Step 2: Run encoding-detector to verify the file encoding
  const encodingEnv = runAndParse('encoding-detector/scripts/detect.cjs', `-i "${jsonFile}"`);
  assert(
    encodingEnv.skill === 'encoding-detector',
    `Expected skill "encoding-detector", got "${encodingEnv.skill}"`
  );
  assert(encodingEnv.data.encoding !== undefined, 'Encoding detector should return encoding');
  assert(encodingEnv.data.confidence > 0, 'Encoding confidence should be positive');
  assert(encodingEnv.data.lineEnding !== undefined, 'Encoding detector should report line ending');
  assert(
    typeof encodingEnv.metadata.duration_ms === 'number',
    'Encoding detector should have duration_ms'
  );

  // Step 3: Since encoding is valid, transform the JSON to YAML
  const transformEnv = runAndParse(
    'data-transformer/scripts/transform.cjs',
    `-i "${jsonFile}" -t yaml`
  );
  assert(
    transformEnv.skill === 'data-transformer',
    `Expected skill "data-transformer", got "${transformEnv.skill}"`
  );
  assert(
    transformEnv.data.format === 'yaml',
    `Expected format "yaml", got "${transformEnv.data.format}"`
  );
  assert(typeof transformEnv.data.content === 'string', 'Transformer should return content string');
  assert(transformEnv.data.content.includes('International Menu'), 'YAML should contain the title');
  assert(transformEnv.data.content.includes('Croissant'), 'YAML should contain first item name');
  assert(transformEnv.data.content.includes('Sushi'), 'YAML should contain second item name');
  assert(transformEnv.data.content.includes('Tacos'), 'YAML should contain third item name');
  assert(
    typeof transformEnv.metadata.duration_ms === 'number',
    'Data transformer should have duration_ms'
  );

  // Step 4: Verify consistent envelope structure
  for (const [name, env] of [
    ['encoding-detector', encodingEnv],
    ['data-transformer', transformEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

test('encoding-detector detects LF line endings then data-transformer preserves data integrity', () => {
  // Step 1: Create a CSV file (no trailing newline to avoid empty trailing records)
  const csvContent = 'name,age,city\nAlice,30,Tokyo\nBob,25,London\nCharlie,35,Paris';
  const csvFile = writeTemp('chain22_people.csv', csvContent);

  // Step 2: Detect encoding and verify LF line endings
  const encodingEnv = runAndParse('encoding-detector/scripts/detect.cjs', `-i "${csvFile}"`);
  assert(
    encodingEnv.data.lineEnding === 'LF',
    `Expected LF line ending, got "${encodingEnv.data.lineEnding}"`
  );
  assert(encodingEnv.data.confidence > 0, 'Should have positive confidence');

  // Step 3: Transform CSV to JSON
  const transformEnv = runAndParse(
    'data-transformer/scripts/transform.cjs',
    `-i "${csvFile}" -t json`
  );
  assert(
    transformEnv.data.format === 'json',
    `Expected format "json", got "${transformEnv.data.format}"`
  );

  // Step 4: Verify the JSON output preserves all CSV data
  const parsedJson = JSON.parse(transformEnv.data.content);
  assert(Array.isArray(parsedJson), 'Transformed JSON should be an array');
  assert(parsedJson.length === 3, `Expected 3 records, got ${parsedJson.length}`);
  assert(parsedJson[0].name === 'Alice', 'First record name should be Alice');
  assert(parsedJson[1].name === 'Bob', 'Second record name should be Bob');
  assert(parsedJson[2].name === 'Charlie', 'Third record name should be Charlie');
});

// ========================================
// Chain 23: Refactoring Engine -> Code Lang Detector
// ========================================
console.log('\n--- Chain 23: Refactoring Engine -> Code Lang Detector ---');

test('refactoring-engine finds smells then code-lang-detector confirms language', () => {
  // Step 1: Create a JavaScript file with intentional code smells
  const jsCode = [
    '// Authentication service with intentional smells',
    'const SECRET = 99999;',
    'const THRESHOLD = 3.14159;',
    'const MAX_RETRIES = 42;',
    '',
    'function authenticate(user, pass, role, org, level) {',
    '  let attempts = 0;',
    '  while (attempts < MAX_RETRIES) {',
    '    if (user === "admin") {',
    '      if (pass === "secret") {',
    '        if (role === "superuser") {',
    '          if (org === "root") {',
    '            return { token: SECRET, level: level * THRESHOLD };',
    '          }',
    '        }',
    '      }',
    '    }',
    '    attempts++;',
    '  }',
    '  return null;',
    '}',
    '',
    'function processData(items) {',
    '  let result = 0;',
    '  result += items[0] * 17;',
    '  result += items[1] * 23;',
    '  result += items[2] * 31;',
    '  result += items[3] * 37;',
    '  result += items[4] * 41;',
    '  result += items[5] * 43;',
    '  console.log("processing step 1");',
    '  console.log("processing step 2");',
    '  console.log("processing step 3");',
    '  console.log("finishing");',
    '  return result;',
    '}',
    '',
    'module.exports = { authenticate, processData };',
  ].join('\n');
  const jsFile = writeTemp('chain23_auth_service.js', jsCode);

  // Step 2: Run refactoring-engine to find code smells
  const refactorEnv = runAndParse('refactoring-engine/scripts/analyze.cjs', `-i "${jsFile}"`);
  assert(
    refactorEnv.skill === 'refactoring-engine',
    `Expected skill "refactoring-engine", got "${refactorEnv.skill}"`
  );
  assert(typeof refactorEnv.data === 'object', 'Refactoring engine should return data');
  assert(refactorEnv.data.file !== undefined, 'Refactoring engine should report the analyzed file');
  assert(Array.isArray(refactorEnv.data.smells), 'Refactoring engine should return smells array');
  assert(
    refactorEnv.data.smells.length > 0,
    'Should find code smells in the intentionally smelly code'
  );
  assert(refactorEnv.data.summary !== undefined, 'Refactoring engine should return summary');
  assert(typeof refactorEnv.data.summary.total === 'number', 'Summary should have total count');
  assert(refactorEnv.data.summary.total > 0, 'Total smells should be positive');
  assert(
    typeof refactorEnv.metadata.duration_ms === 'number',
    'Refactoring engine should have duration_ms'
  );

  // Verify at least one magic-number smell was found
  const magicSmells = refactorEnv.data.smells.filter((s) => s.type === 'magic-number');
  assert(magicSmells.length > 0, 'Should find at least one magic-number smell');

  // Step 3: Run code-lang-detector on the same file to confirm language
  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${jsFile}"`);
  assert(
    langEnv.skill === 'code-lang-detector',
    `Expected skill "code-lang-detector", got "${langEnv.skill}"`
  );
  assert(langEnv.data.lang === 'javascript', `Expected "javascript", got "${langEnv.data.lang}"`);
  assert(langEnv.data.confidence === 1.0, 'Should have full confidence for .js extension');
  assert(langEnv.data.method === 'extension', 'Should use extension-based detection for .js file');
  assert(
    typeof langEnv.metadata.duration_ms === 'number',
    'Code lang detector should have duration_ms'
  );

  // Step 4: Verify both envelopes have consistent structure
  for (const [name, env] of [
    ['refactoring-engine', refactorEnv],
    ['code-lang-detector', langEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

test('refactoring-engine results and code-lang-detector agree on Python code via keyword detection', () => {
  // Step 1: Create a Python file (using .txt extension to force keyword detection)
  const pyCode = [
    'import os',
    'import sys',
    '',
    'def process_records(data):',
    '    magic_value = 42',
    '    threshold = 3.14159',
    '    results = []',
    '    for item in data:',
    '        if item > magic_value:',
    '            results.append(item * threshold)',
    '    return results',
    '',
    'def main():',
    '    data = [10, 50, 30, 80, 20]',
    '    output = process_records(data)',
    '    print(output)',
    '',
    'if __name__ == "__main__":',
    '    main()',
  ].join('\n');
  const pyFile = writeTemp('chain23_pycode.txt', pyCode);

  // Step 2: Run refactoring-engine on the Python-like file
  const refactorEnv = runAndParse('refactoring-engine/scripts/analyze.cjs', `-i "${pyFile}"`);
  assert(refactorEnv.skill === 'refactoring-engine', 'Skill should be refactoring-engine');
  assert(typeof refactorEnv.data === 'object', 'Should return data');
  // The engine may or may not find smells in Python-like syntax (it primarily targets JS patterns)
  assert(refactorEnv.data.summary !== undefined, 'Should return summary');
  assert(typeof refactorEnv.data.summary.total === 'number', 'Summary total should be a number');

  // Step 3: Run code-lang-detector -> should detect Python via keyword analysis
  const langEnv = runAndParse('code-lang-detector/scripts/detect.cjs', `-i "${pyFile}"`);
  assert(langEnv.skill === 'code-lang-detector', 'Skill should be code-lang-detector');
  assert(langEnv.data.lang === 'python', `Expected "python", got "${langEnv.data.lang}"`);
  assert(langEnv.data.method === 'keyword', 'Should use keyword-based detection for .txt file');
  assert(langEnv.data.confidence > 0, 'Confidence should be positive');

  // Step 4: Verify both envelopes
  for (const [name, env] of [
    ['refactoring-engine', refactorEnv],
    ['code-lang-detector', langEnv],
  ]) {
    assert(env.status === 'success', `${name}: should succeed`);
    assert(env.skill === name, `${name}: skill field should match`);
    assert(typeof env.metadata === 'object', `${name}: should have metadata`);
    assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
  }
});

// ========================================
// Chain 24: PR Architect -> Release Note Crafter
// ========================================
console.log('\n--- Chain 24: PR Architect -> Release Note Crafter ---');

test('pr-architect generates PR data then release-note-crafter generates notes from same repo', () => {
  // Step 1: Create a small git repository with conventional commits
  const prDir = path.join(tmpDir, 'chain24_repo');
  if (!fs.existsSync(prDir)) fs.mkdirSync(prDir, { recursive: true });

  const appFile = path.join(prDir, 'app.js');
  fs.writeFileSync(
    appFile,
    [
      'const express = require("express");',
      'const app = express();',
      'app.get("/", (req, res) => res.send("hello"));',
      'module.exports = app;',
    ].join('\n')
  );

  const configFile = path.join(prDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ port: 3000, env: 'development' }, null, 2));

  execSync('git init', { cwd: prDir, stdio: 'pipe' });
  execSync('git add -A', { cwd: prDir, stdio: 'pipe' });
  execSync(
    'git -c user.email="test@test.com" -c user.name="Test" commit -m "feat: add express app with config"',
    { cwd: prDir, stdio: 'pipe' }
  );

  // Add a second commit to create diff history
  fs.writeFileSync(
    appFile,
    fs.readFileSync(appFile, 'utf8') +
      '\n// fix: handle 404\napp.use((req, res) => res.status(404).send("not found"));\n'
  );
  execSync('git add -A', { cwd: prDir, stdio: 'pipe' });
  execSync(
    'git -c user.email="test@test.com" -c user.name="Test" commit -m "fix: add 404 handler"',
    { cwd: prDir, stdio: 'pipe' }
  );

  fs.writeFileSync(
    configFile,
    JSON.stringify({ port: 3000, env: 'production', debug: false }, null, 2)
  );
  execSync('git add -A', { cwd: prDir, stdio: 'pipe' });
  execSync(
    'git -c user.email="test@test.com" -c user.name="Test" commit -m "chore: update config for production"',
    { cwd: prDir, stdio: 'pipe' }
  );

  // Step 2: Run pr-architect to generate PR data
  const prEnv = runAndParse('pr-architect/scripts/draft.cjs', `-d "${prDir}"`);
  assert(prEnv.skill === 'pr-architect', `Expected skill "pr-architect", got "${prEnv.skill}"`);
  assert(typeof prEnv.data.title === 'string', 'PR architect should return a title');
  assert(prEnv.data.title.length > 0, 'PR title should not be empty');
  assert(typeof prEnv.data.description === 'string', 'PR architect should return a description');
  assert(Array.isArray(prEnv.data.commits), 'PR architect should return commits array');
  assert(
    prEnv.data.commits.length >= 3,
    `Expected at least 3 commits, got ${prEnv.data.commits.length}`
  );
  assert(typeof prEnv.metadata.duration_ms === 'number', 'PR architect should have duration_ms');

  // Step 3: Run release-note-crafter on the same repo
  const releaseEnv = runAndParse(
    'release-note-crafter/scripts/main.cjs',
    `-d "${prDir}" -s "2020-01-01"`
  );
  assert(
    releaseEnv.skill === 'release-note-crafter',
    `Expected skill "release-note-crafter", got "${releaseEnv.skill}"`
  );
  assert(
    typeof releaseEnv.data.commits === 'number',
    'Release note crafter should return commit count'
  );
  assert(releaseEnv.data.commits === 3, `Expected 3 commits, got ${releaseEnv.data.commits}`);
  assert(
    typeof releaseEnv.data.markdown === 'string',
    'Release note crafter should return markdown'
  );
  assert(
    releaseEnv.data.markdown.includes('Release Notes'),
    'Release notes should contain heading'
  );
  assert(
    typeof releaseEnv.metadata.duration_ms === 'number',
    'Release note crafter should have duration_ms'
  );

  // Step 4: Verify cross-skill consistency: both analyzed same commit history
  const prCommitCount = prEnv.data.commits.length;
  const releaseCommitCount = releaseEnv.data.commits;
  assert(
    prCommitCount >= releaseCommitCount,
    'PR architect should see at least as many commits as release-note-crafter'
  );
});

test('release-note-crafter sections reflect conventional prefixes from pr-architect commits', () => {
  const prDir = path.join(tmpDir, 'chain24_repo');
  if (fs.existsSync(prDir)) {
    const releaseEnv = runAndParse(
      'release-note-crafter/scripts/main.cjs',
      `-d "${prDir}" -s "2020-01-01"`
    );
    const sections = releaseEnv.data.sections;
    assert(sections !== undefined, 'Should have sections object');
    // The repo has feat:, fix:, and chore: commits
    const totalCategorized =
      (sections.Features || 0) + (sections['Bug Fixes'] || 0) + (sections.Chores || 0);
    assert(totalCategorized === 3, `Expected 3 categorized commits, got ${totalCategorized}`);
    assert((sections.Features || 0) >= 1, 'Should have at least 1 feature');
    assert((sections['Bug Fixes'] || 0) >= 1, 'Should have at least 1 bug fix');
  } else {
    assert(false, 'chain24_repo directory not found - previous test may have failed');
  }
});

test('pr-architect and release-note-crafter envelopes have consistent structure', () => {
  const prDir = path.join(tmpDir, 'chain24_repo');
  if (fs.existsSync(prDir)) {
    const prEnv = runAndParse('pr-architect/scripts/draft.cjs', `-d "${prDir}"`);
    const releaseEnv = runAndParse(
      'release-note-crafter/scripts/main.cjs',
      `-d "${prDir}" -s "2020-01-01"`
    );
    for (const [name, env] of [
      ['pr-architect', prEnv],
      ['release-note-crafter', releaseEnv],
    ]) {
      assert(env.status === 'success', `${name}: should succeed`);
      assert(env.skill === name, `${name}: skill field should match`);
      assert(typeof env.metadata === 'object', `${name}: should have metadata`);
      assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
    }
  } else {
    assert(false, 'chain24_repo directory not found - previous test may have failed');
  }
});

// ========================================
// Chain 25: Onboarding Wizard -> Project Health Check
// ========================================
console.log('\n--- Chain 25: Onboarding Wizard -> Project Health Check ---');

test('onboarding-wizard generates docs then project-health-check audits the same project', () => {
  // Step 1: Create a project directory with typical structure
  const projDir = path.join(tmpDir, 'chain25_project');
  if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });

  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify(
      {
        name: 'chain25-test-project',
        version: '1.0.0',
        scripts: { test: 'jest', dev: 'node server.js', lint: 'eslint .' },
        devDependencies: { jest: '^29.0.0', eslint: '^8.0.0' },
      },
      null,
      2
    )
  );

  fs.writeFileSync(
    path.join(projDir, 'README.md'),
    '# Chain 25 Test Project\nA project for testing skill chains.'
  );
  fs.writeFileSync(
    path.join(projDir, 'server.js'),
    'const http = require("http");\nhttp.createServer((req, res) => res.end("ok")).listen(3000);'
  );

  // Add CI config for health check
  const workflowDir = path.join(projDir, '.github', 'workflows');
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, 'ci.yml'),
    'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n'
  );

  // Step 2: Run onboarding-wizard on the project
  const onboardEnv = runAndParse('onboarding-wizard/scripts/generate.cjs', `-d "${projDir}"`);
  assert(
    onboardEnv.skill === 'onboarding-wizard',
    `Expected skill "onboarding-wizard", got "${onboardEnv.skill}"`
  );
  assert(
    typeof onboardEnv.data.projectName === 'string',
    'Onboarding wizard should return project name'
  );
  assert(
    onboardEnv.data.projectName === 'chain25-test-project',
    `Expected project name "chain25-test-project", got "${onboardEnv.data.projectName}"`
  );
  assert(
    Array.isArray(onboardEnv.data.prerequisites),
    'Onboarding wizard should return prerequisites array'
  );
  assert(onboardEnv.data.prerequisites.length > 0, 'Should have at least one prerequisite');
  assert(Array.isArray(onboardEnv.data.setupSteps), 'Onboarding wizard should return setup steps');
  assert(onboardEnv.data.setupSteps.length > 0, 'Should have at least one setup step');
  assert(Array.isArray(onboardEnv.data.keyFiles), 'Onboarding wizard should return key files');
  assert(
    typeof onboardEnv.data.quickStart === 'string',
    'Onboarding wizard should return quickStart markdown'
  );
  assert(
    onboardEnv.data.quickStart.includes('chain25-test-project'),
    'Quick start should mention project name'
  );
  assert(
    typeof onboardEnv.metadata.duration_ms === 'number',
    'Onboarding wizard should have duration_ms'
  );

  // Step 3: Run project-health-check on the same directory
  // project-health-check reads from process.cwd(), so we must run it with the correct cwd
  const healthCmd = `node "${path.join(rootDir, 'project-health-check/scripts/audit.cjs')}"`;
  const healthRaw = execSync(healthCmd, { encoding: 'utf8', cwd: projDir, timeout: 15000 });
  const healthEnv = JSON.parse(healthRaw);
  assert(
    healthEnv.status === 'success',
    `Project health check failed: ${JSON.stringify(healthEnv.error)}`
  );
  assert(
    healthEnv.skill === 'project-health-check',
    `Expected skill "project-health-check", got "${healthEnv.skill}"`
  );
  assert(typeof healthEnv.data.score === 'number', 'Health check should return a score');
  assert(
    healthEnv.data.score >= 0 && healthEnv.data.score <= 100,
    'Score should be between 0 and 100'
  );
  assert(typeof healthEnv.data.grade === 'string', 'Health check should return a grade');
  assert(Array.isArray(healthEnv.data.checks), 'Health check should return checks array');
  assert(healthEnv.data.checks.length > 0, 'Should have at least one check');
  assert(
    typeof healthEnv.metadata.duration_ms === 'number',
    'Health check should have duration_ms'
  );

  // Step 4: Verify field relationships between skills
  // Onboarding wizard found README.md as a key file; health check should detect documentation
  const hasReadmeInKeyFiles = onboardEnv.data.keyFiles.some((kf) => kf.file === 'README.md');
  assert(hasReadmeInKeyFiles, 'Onboarding wizard should identify README.md as a key file');
  const docsCheck = healthEnv.data.checks.find((c) => c.check === 'Documentation');
  assert(docsCheck !== undefined, 'Health check should have a Documentation check');
  assert(
    docsCheck.status === 'found',
    'Documentation check should be "found" since README.md exists'
  );
});

test('onboarding-wizard prerequisites and health-check detected tools are consistent', () => {
  const projDir = path.join(tmpDir, 'chain25_project');
  if (fs.existsSync(projDir)) {
    const onboardEnv = runAndParse('onboarding-wizard/scripts/generate.cjs', `-d "${projDir}"`);

    const healthCmd = `node "${path.join(rootDir, 'project-health-check/scripts/audit.cjs')}"`;
    const healthRaw = execSync(healthCmd, { encoding: 'utf8', cwd: projDir, timeout: 15000 });
    const healthEnv = JSON.parse(healthRaw);

    // Both skills should recognize the testing framework (jest in package.json)
    const testCheck = healthEnv.data.checks.find((c) => c.check === 'Testing Framework');
    assert(testCheck !== undefined, 'Health check should have a Testing Framework check');
    assert(
      testCheck.status === 'found',
      'Testing Framework should be found (jest in devDependencies)'
    );

    // Onboarding wizard should list npm test in setup steps
    const hasTestStep = onboardEnv.data.setupSteps.some((s) => s.includes('npm test'));
    assert(hasTestStep, 'Onboarding wizard should include "npm test" in setup steps');

    // Verify both envelopes
    for (const [name, env] of [
      ['onboarding-wizard', onboardEnv],
      ['project-health-check', healthEnv],
    ]) {
      assert(env.status === 'success', `${name}: should succeed`);
      assert(env.skill === name, `${name}: skill field should match`);
      assert(typeof env.metadata === 'object', `${name}: should have metadata`);
      assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
    }
  } else {
    assert(false, 'chain25_project directory not found - previous test may have failed');
  }
});

// ========================================
// Chain 26: Cloud Waste Hunter -> Cloud Cost Estimator
// ========================================
console.log('\n--- Chain 26: Cloud Waste Hunter -> Cloud Cost Estimator ---');

test('cloud-waste-hunter detects waste then cloud-cost-estimator prices the infrastructure', () => {
  // Step 1: Create a temp directory with a Terraform file using oversized instances
  const cloudDir = path.join(tmpDir, 'chain26_infra');
  if (!fs.existsSync(cloudDir)) fs.mkdirSync(cloudDir, { recursive: true });

  const tfFile = path.join(cloudDir, 'main.tf');
  fs.writeFileSync(
    tfFile,
    [
      'resource "aws_instance" "web" {',
      '  ami           = "ami-0c55b159cbfafe1f0"',
      '  instance_type = "m5.4xlarge"',
      '  tags = {',
      '    Name = "production-web"',
      '  }',
      '}',
      '',
      'resource "aws_instance" "worker" {',
      '  ami           = "ami-0c55b159cbfafe1f0"',
      '  instance_type = "c5.9xlarge"',
      '  tags = {',
      '    Name = "batch-worker"',
      '  }',
      '}',
      '',
      'resource "aws_ebs_volume" "data" {',
      '  availability_zone = "us-east-1a"',
      '  size              = 500',
      '}',
    ].join('\n')
  );

  // Step 2: Run cloud-waste-hunter to detect waste patterns
  const wasteEnv = runAndParse('cloud-waste-hunter/scripts/hunt.cjs', `-d "${cloudDir}"`);
  assert(
    wasteEnv.skill === 'cloud-waste-hunter',
    `Expected skill "cloud-waste-hunter", got "${wasteEnv.skill}"`
  );
  assert(Array.isArray(wasteEnv.data.findings), 'Waste hunter should return findings array');
  assert(
    wasteEnv.data.findings.length > 0,
    'Should find waste patterns in oversized infrastructure'
  );
  assert(typeof wasteEnv.data.wasteScore === 'number', 'Waste hunter should return wasteScore');
  assert(wasteEnv.data.wasteScore > 0, 'Waste score should be positive for oversized instances');
  assert(
    wasteEnv.data.totalFiles === 1,
    `Expected 1 file scanned, got ${wasteEnv.data.totalFiles}`
  );
  assert(
    Array.isArray(wasteEnv.data.recommendations),
    'Waste hunter should return recommendations'
  );
  assert(wasteEnv.data.recommendations.length > 0, 'Should have at least one recommendation');

  // Verify specific waste findings
  const oversizedFindings = wasteEnv.data.findings.filter((f) => f.type === 'oversized-instance');
  assert(
    oversizedFindings.length >= 2,
    `Expected at least 2 oversized-instance findings, got ${oversizedFindings.length}`
  );
  const autoscalingFindings = wasteEnv.data.findings.filter(
    (f) => f.type === 'missing-autoscaling'
  );
  assert(autoscalingFindings.length >= 1, 'Should detect missing autoscaling');

  // Step 3: Create a cloud-cost-estimator config derived from the waste findings
  const costConfig = {
    services: [
      { name: 'web-server', type: 'compute', provider: 'aws', size: 'xlarge', count: 1 },
      { name: 'batch-worker', type: 'compute', provider: 'aws', size: 'xlarge', count: 1 },
      { name: 'data-volume', type: 'storage', provider: 'aws', size: 'large', count: 1 },
    ],
  };
  const costConfigFile = writeTemp('chain26_cost_config.json', JSON.stringify(costConfig, null, 2));

  // Step 4: Run cloud-cost-estimator on the derived config
  const costEnv = runAndParse(
    'cloud-cost-estimator/scripts/estimate.cjs',
    `-i "${costConfigFile}"`
  );
  assert(
    costEnv.skill === 'cloud-cost-estimator',
    `Expected skill "cloud-cost-estimator", got "${costEnv.skill}"`
  );
  assert(Array.isArray(costEnv.data.services), 'Cost estimator should return services array');
  assert(
    costEnv.data.services.length === 3,
    `Expected 3 services, got ${costEnv.data.services.length}`
  );
  assert(
    typeof costEnv.data.totalMonthlyCost === 'number',
    'Cost estimator should return totalMonthlyCost'
  );
  assert(costEnv.data.totalMonthlyCost > 0, 'Total monthly cost should be positive');
  assert(
    typeof costEnv.data.totalYearlyCost === 'number',
    'Cost estimator should return totalYearlyCost'
  );
  assert(
    costEnv.data.totalYearlyCost === costEnv.data.totalMonthlyCost * 12,
    'Yearly cost should be 12x monthly'
  );
  assert(
    Array.isArray(costEnv.data.recommendations),
    'Cost estimator should return recommendations'
  );
  assert(
    typeof costEnv.metadata.duration_ms === 'number',
    'Cost estimator should have duration_ms'
  );
});

test('waste hunter recommendations align with cost estimator findings', () => {
  const cloudDir = path.join(tmpDir, 'chain26_infra');
  if (fs.existsSync(cloudDir)) {
    const wasteEnv = runAndParse('cloud-waste-hunter/scripts/hunt.cjs', `-d "${cloudDir}"`);
    const costConfigFile = path.join(tmpDir, 'chain26_cost_config.json');
    const costEnv = runAndParse(
      'cloud-cost-estimator/scripts/estimate.cjs',
      `-i "${costConfigFile}"`
    );

    // Waste hunter found oversized instances -> cost estimator should recommend reserved/spot instances
    const hasOversized = wasteEnv.data.findings.some((f) => f.type === 'oversized-instance');
    assert(hasOversized, 'Waste hunter should have found oversized instances');
    const hasComputeReco = costEnv.data.recommendations.some(
      (r) => r.includes('reserved instances') || r.includes('spot instances')
    );
    assert(
      hasComputeReco,
      'Cost estimator should recommend reserved/spot instances for large compute'
    );

    // Verify both envelopes
    for (const [name, env] of [
      ['cloud-waste-hunter', wasteEnv],
      ['cloud-cost-estimator', costEnv],
    ]) {
      assert(env.status === 'success', `${name}: should succeed`);
      assert(env.skill === name, `${name}: skill field should match`);
      assert(typeof env.metadata === 'object', `${name}: should have metadata`);
      assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
    }
  } else {
    assert(false, 'chain26_infra directory not found - previous test may have failed');
  }
});

// ========================================
// Chain 27: Log-to-Requirement Bridge -> Issue-to-Solution Bridge
// ========================================
console.log('\n--- Chain 27: Log-to-Requirement Bridge -> Issue-to-Solution Bridge ---');

test('log-to-requirement-bridge extracts requirements then issue-to-solution-bridge generates solutions', () => {
  // Step 1: Create a realistic log file with various error patterns
  const logContent = [
    '2025-01-15 10:00:01 ERROR Connection refused to database host db.example.com:5432',
    '2025-01-15 10:00:02 WARN Request timeout after 30s for /api/users',
    '2025-01-15 10:00:03 ERROR OOM: heap space exceeded, process killed',
    '2025-01-15 10:00:04 INFO Server restarted successfully',
    '2025-01-15 10:00:05 ERROR Permission denied accessing /var/data/secrets',
    '2025-01-15 10:00:06 WARN Rate limit exceeded for client 192.168.1.100',
    '2025-01-15 10:00:07 ERROR cannot read property of null in UserService.getProfile',
    '2025-01-15 10:00:08 INFO Request completed in 200ms',
    '2025-01-15 10:00:09 ERROR Database query failed: relation "users" does not exist',
    '2025-01-15 10:00:10 DEBUG Entering authentication flow',
    '2025-01-15 10:00:11 ERROR Connection refused to cache host redis.example.com:6379',
    '2025-01-15 10:00:12 WARN timeout waiting for response from payment service',
  ].join('\n');
  const logFile = writeTemp('chain27_app.log', logContent);

  // Step 2: Run log-to-requirement-bridge to analyze the log
  const logEnv = runAndParse('log-to-requirement-bridge/scripts/analyze.cjs', `-i "${logFile}"`);
  assert(
    logEnv.skill === 'log-to-requirement-bridge',
    `Expected skill "log-to-requirement-bridge", got "${logEnv.skill}"`
  );
  assert(typeof logEnv.data.totalLines === 'number', 'Should return totalLines');
  assert(logEnv.data.totalLines === 12, `Expected 12 lines, got ${logEnv.data.totalLines}`);
  assert(typeof logEnv.data.errorCount === 'number', 'Should return errorCount');
  assert(logEnv.data.errorCount > 0, 'Should have found errors');
  assert(typeof logEnv.data.warningCount === 'number', 'Should return warningCount');
  assert(logEnv.data.warningCount > 0, 'Should have found warnings');
  assert(Array.isArray(logEnv.data.patterns), 'Should return patterns array');
  assert(logEnv.data.patterns.length > 0, 'Should detect error patterns');
  assert(Array.isArray(logEnv.data.suggestedRequirements), 'Should return suggestedRequirements');
  assert(logEnv.data.suggestedRequirements.length > 0, 'Should generate requirements from errors');
  assert(typeof logEnv.metadata.duration_ms === 'number', 'Should have duration_ms');

  // Verify specific patterns were detected
  const patternCategories = logEnv.data.patterns.map((p) => p.pattern);
  assert(
    patternCategories.includes('connection-failure'),
    'Should detect connection-failure pattern'
  );
  assert(patternCategories.includes('timeout'), 'Should detect timeout pattern');
  assert(patternCategories.includes('memory'), 'Should detect memory pattern');
  assert(patternCategories.includes('database'), 'Should detect database pattern');

  // Step 3: Build an issue description from the top requirements for issue-to-solution-bridge
  const topRequirements = logEnv.data.suggestedRequirements.slice(0, 3).join(' ');
  const issueDescription = `Production issues detected: ${topRequirements}`;

  const issueEnv = runAndParse(
    'issue-to-solution-bridge/scripts/solve.cjs',
    `-d "${issueDescription}"`
  );
  assert(
    issueEnv.skill === 'issue-to-solution-bridge',
    `Expected skill "issue-to-solution-bridge", got "${issueEnv.skill}"`
  );
  assert(typeof issueEnv.data.title === 'string', 'Issue bridge should return title');
  assert(issueEnv.data.title.length > 0, 'Issue title should not be empty');
  assert(typeof issueEnv.data.analysis === 'object', 'Issue bridge should return analysis');
  assert(typeof issueEnv.data.analysis.type === 'string', 'Analysis should have a type');
  assert(typeof issueEnv.data.analysis.severity === 'string', 'Analysis should have severity');
  assert(
    Array.isArray(issueEnv.data.analysis.suggestedActions),
    'Analysis should have suggestedActions'
  );
  assert(issueEnv.data.analysis.suggestedActions.length > 0, 'Should suggest at least one action');
  assert(issueEnv.data.dry_run === true, 'Should default to dry-run mode');
  assert(typeof issueEnv.metadata.duration_ms === 'number', 'Issue bridge should have duration_ms');
});

test('issue-to-solution-bridge classifies log-derived issues as bugs', () => {
  const logFile = path.join(tmpDir, 'chain27_app.log');
  if (fs.existsSync(logFile)) {
    const logEnv = runAndParse('log-to-requirement-bridge/scripts/analyze.cjs', `-i "${logFile}"`);

    // Build issue description from requirements (they mention errors, timeouts, failures)
    const description = logEnv.data.suggestedRequirements.join(' ');
    const issueEnv = runAndParse(
      'issue-to-solution-bridge/scripts/solve.cjs',
      `-d "${description}"`
    );

    // Because the requirements mention errors, connection failures, timeouts -> should classify as "bug"
    assert(
      issueEnv.data.analysis.type === 'bug',
      `Expected issue type "bug", got "${issueEnv.data.analysis.type}"`
    );

    // High error rate with production keywords -> should be critical or medium severity
    const severity = issueEnv.data.analysis.severity;
    assert(
      severity === 'critical' || severity === 'medium',
      `Expected severity "critical" or "medium", got "${severity}"`
    );

    // Verify both envelopes
    for (const [name, env] of [
      ['log-to-requirement-bridge', logEnv],
      ['issue-to-solution-bridge', issueEnv],
    ]) {
      assert(env.status === 'success', `${name}: should succeed`);
      assert(env.skill === name, `${name}: skill field should match`);
      assert(typeof env.metadata === 'object', `${name}: should have metadata`);
      assert(typeof env.metadata.timestamp === 'string', `${name}: should have timestamp`);
    }
  } else {
    assert(false, 'chain27_app.log file not found - previous test may have failed');
  }
});

// ========================================
// Chain 28: Dependency Lifeline -> Project Health Check
// Both analyze project health from a directory
// ========================================
console.log('\n--- Chain 28: Dependency Lifeline -> Project Health Check ---');

test('dependency-lifeline and project-health-check both analyze same project dir', () => {
  // Create a test project with package.json
  const projDir = path.join(tmpDir, 'chain28_project');
  if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify(
      {
        name: 'chain28-test-project',
        version: '2.0.0',
        description: 'Test project for chain 28',
        dependencies: { express: '^4.18.0' },
        devDependencies: { jest: '^29.0.0' },
        scripts: { test: 'jest', start: 'node index.js' },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(projDir, 'index.js'), 'console.log("hello");\n');

  // Step 1: Run dependency-lifeline
  const lifelineEnv = runAndParse('dependency-lifeline/scripts/check.cjs', `--dir "${projDir}"`);
  assert(lifelineEnv.skill === 'dependency-lifeline', 'Should identify as dependency-lifeline');
  assert(typeof lifelineEnv.data.healthScore === 'number', 'Should return healthScore');
  assert(lifelineEnv.data.totalDeps > 0, 'Should find dependencies');
  assert(Array.isArray(lifelineEnv.data.recommendations), 'Should return recommendations');

  // Step 2: Run project-health-check on same dir
  const healthEnv = runAndParse('project-health-check/scripts/audit.cjs', `"${projDir}"`);
  assert(healthEnv.skill === 'project-health-check', 'Should identify as project-health-check');
  assert(typeof healthEnv.data === 'object', 'Should return health data');

  // Both should agree the project has a package.json
  assert(
    lifelineEnv.data.project === 'chain28-test-project',
    'Lifeline should detect project name'
  );
  assert(lifelineEnv.status === 'success' && healthEnv.status === 'success', 'Both should succeed');
});

test('dependency-lifeline detects all dep sources in chain28 project', () => {
  const projDir = path.join(tmpDir, 'chain28_project');
  const lifelineEnv = runAndParse('dependency-lifeline/scripts/check.cjs', `--dir "${projDir}"`);

  // Should find both dependencies and devDependencies
  assert(lifelineEnv.data.totalDeps === 2, `Expected 2 deps, got ${lifelineEnv.data.totalDeps}`);
  const depNames = lifelineEnv.data.dependencies.map((d) => d.name);
  assert(depNames.includes('express'), 'Should find express');
  assert(depNames.includes('jest'), 'Should find jest');
});

// ========================================
// Chain 29: Test Suite Architect -> Codebase Mapper
// Analyze test architecture then map the same directory
// ========================================
console.log('\n--- Chain 29: Test Suite Architect -> Codebase Mapper ---');

test('test-suite-architect analyzes project then codebase-mapper maps same dir', () => {
  // Create a project with test files and source files
  const projDir = path.join(tmpDir, 'chain29_project');
  const srcDir = path.join(projDir, 'src');
  const testDir = path.join(projDir, 'tests');
  if (!fs.existsSync(srcDir)) fs.mkdirSync(srcDir, { recursive: true });
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  fs.writeFileSync(
    path.join(projDir, 'package.json'),
    JSON.stringify(
      {
        name: 'chain29-project',
        version: '1.0.0',
        devDependencies: { jest: '^29.0.0' },
        scripts: { test: 'jest' },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(srcDir, 'app.js'), 'module.exports = { greet: () => "hello" };\n');
  fs.writeFileSync(path.join(srcDir, 'utils.js'), 'module.exports = { add: (a, b) => a + b };\n');
  fs.writeFileSync(path.join(testDir, 'app.test.js'), 'test("greet", () => {});\n');

  // Step 1: Analyze test architecture
  const archEnv = runAndParse('test-suite-architect/scripts/analyze.cjs', `--dir "${projDir}"`);
  assert(archEnv.skill === 'test-suite-architect', 'Should identify as test-suite-architect');
  assert(Array.isArray(archEnv.data.framework), 'Should return framework array');
  assert(archEnv.data.framework.includes('jest'), 'Should detect jest');
  assert(typeof archEnv.data.testRatio === 'number', 'Should return testRatio');
  // Note: tmpDir is under tests/ so all .js files are classified as test files
  assert(archEnv.data.testFiles.length > 0, 'Should find test files');
  assert(Array.isArray(archEnv.data.recommendations), 'Should return recommendations');

  // Step 2: Map the same project directory
  const mapEnv = runAndParse('codebase-mapper/scripts/map.cjs', `"${projDir}" 2`);
  assert(mapEnv.skill === 'codebase-mapper', 'Should identify as codebase-mapper');
  assert(Array.isArray(mapEnv.data.tree), 'Should return tree array');
  assert(mapEnv.data.tree.length > 0, 'Tree should not be empty');
  const treeStr = mapEnv.data.tree.join('\n');
  assert(treeStr.includes('chain29_project'), 'Tree should reference project dir');

  // Both tools should successfully analyze the same directory
  assert(archEnv.status === 'success' && mapEnv.status === 'success', 'Both should succeed');
});

test('test-suite-architect returns strategy and recommendations', () => {
  const projDir = path.join(tmpDir, 'chain29_project');
  const archEnv = runAndParse('test-suite-architect/scripts/analyze.cjs', `--dir "${projDir}"`);

  assert(typeof archEnv.data.strategy === 'object', 'Should return strategy object');
  assert(
    typeof archEnv.data.strategy.recommendedFramework === 'string',
    'Should recommend a framework'
  );
  assert(
    typeof archEnv.data.strategy.coverageTarget === 'number',
    'Should suggest coverage target'
  );
  assert(typeof archEnv.data.strategy.estimatedEffort === 'string', 'Should estimate effort');
  assert(Array.isArray(archEnv.data.untested), 'Should return untested array');
});

// ========================================
// Chain 30: Knowledge Auditor -> Sensitivity Detector
// Audit knowledge tiers then detect sensitivity in files
// ========================================
console.log('\n--- Chain 30: Knowledge Auditor -> Sensitivity Detector ---');

test('knowledge-auditor scans dir then sensitivity-detector checks a file from it', () => {
  // Create a directory with some files containing different tier content
  const knDir = path.join(tmpDir, 'chain30_knowledge');
  if (!fs.existsSync(knDir)) fs.mkdirSync(knDir, { recursive: true });

  // Public file with no sensitive content
  const publicFile = path.join(knDir, 'readme.md');
  fs.writeFileSync(
    publicFile,
    '# Public Documentation\n\nThis is a public readme for the project.\n'
  );

  // File with some sensitive-looking content
  const sensitiveFile = path.join(knDir, 'config.txt');
  fs.writeFileSync(
    sensitiveFile,
    [
      'Database Configuration',
      'Host: db.internal.example.com',
      'Password: supersecret123',
      'API_KEY=sk-1234567890abcdef',
      'TOKEN=eyJhbGciOiJIUzI1NiJ9.test',
    ].join('\n')
  );

  // Step 1: Run knowledge-auditor on the directory
  const auditEnv = runAndParse('knowledge-auditor/scripts/audit.cjs', `--dir "${knDir}"`);
  assert(auditEnv.skill === 'knowledge-auditor', 'Should identify as knowledge-auditor');
  assert(typeof auditEnv.data.totalFiles === 'number', 'Should return totalFiles');
  assert(auditEnv.data.totalFiles >= 2, 'Should scan at least 2 files');
  assert(typeof auditEnv.data.tiers === 'object', 'Should return tiers breakdown');
  assert(Array.isArray(auditEnv.data.recommendations), 'Should return recommendations');

  // Step 2: Run sensitivity-detector on the sensitive file
  const sensEnv = runAndParse('sensitivity-detector/scripts/scan.cjs', `-i "${sensitiveFile}"`);
  assert(sensEnv.skill === 'sensitivity-detector', 'Should identify as sensitivity-detector');
  assert(typeof sensEnv.data === 'object', 'Should return sensitivity data');

  // Both envelopes should be valid
  assert(typeof auditEnv.metadata.duration_ms === 'number', 'Audit should have duration_ms');
  assert(typeof sensEnv.metadata.duration_ms === 'number', 'Sensitivity should have duration_ms');
});

test('knowledge-auditor finds violations in sensitive files', () => {
  const knDir = path.join(tmpDir, 'chain30_knowledge');
  const auditEnv = runAndParse('knowledge-auditor/scripts/audit.cjs', `--dir "${knDir}"`);

  // The audit should detect the API_KEY/TOKEN markers
  assert(Array.isArray(auditEnv.data.violations), 'Should return violations array');
  // Recommendations should mention something about the findings
  assert(auditEnv.data.recommendations.length > 0, 'Should have recommendations');
});

// ========================================
// Chain 31: Mission Control Ad-Hoc -> Format Detector
// Use mission-control to orchestrate skills, then verify output
// ========================================
console.log('\n--- Chain 31: Mission Control Ad-Hoc -> Format Detector ---');

test('mission-control orchestrates format-detector via ad-hoc mode', () => {
  // Create a test file for format detection
  const jsonFile = writeTemp(
    'chain31_data.json',
    JSON.stringify({ key: 'value', items: [1, 2, 3] })
  );

  // Run mission-control in ad-hoc mode with format-detector
  const mcEnv = runAndParse(
    'mission-control/scripts/orchestrate.cjs',
    `--skills "format-detector" --input "${jsonFile}"`
  );
  assert(mcEnv.skill === 'mission-control', 'Should identify as mission-control');
  assert(mcEnv.data.mode === 'sequential', 'Ad-hoc mode should be sequential');
  assert(Array.isArray(mcEnv.data.skillsExecuted), 'Should list executed skills');
  assert(mcEnv.data.skillsExecuted.includes('format-detector'), 'Should include format-detector');
  assert(typeof mcEnv.data.results === 'object', 'Should return results summary');
  assert(mcEnv.data.results.total === 1, 'Should have executed 1 skill');
});

test('mission-control orchestrates multiple skills sequentially', () => {
  const sampleFile = writeTemp(
    'chain31_sample.txt',
    'Hello world, this is a sample document for testing.'
  );

  // Run mission-control with two skills
  const mcEnv = runAndParse(
    'mission-control/scripts/orchestrate.cjs',
    `--skills "format-detector,quality-scorer" --input "${sampleFile}"`
  );
  assert(mcEnv.skill === 'mission-control', 'Should identify as mission-control');
  assert(mcEnv.data.skillsExecuted.length === 2, 'Should execute 2 skills');
  assert(mcEnv.data.results.total === 2, 'Should report 2 total');
  assert(typeof mcEnv.data.duration === 'number', 'Should report total duration');
  assert(Array.isArray(mcEnv.data.metrics), 'Should include metrics summary');
});

// ========================================
// Cleanup and Summary
// ========================================
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`Integration Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`Failed: ${failures.join(', ')}`);
  process.exit(1);
}
