#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project directory' })
  .option('type', { alias: 't', type: 'string', default: 'faq', choices: ['faq', 'troubleshoot', 'chatbot', 'all'], description: 'Support asset type' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function extractFAQs(dir) {
  const faqs = [];
  // From README
  const readmePath = path.join(dir, 'README.md');
  if (fs.existsSync(readmePath)) {
    const content = fs.readFileSync(readmePath, 'utf8');
    const sections = content.split(/^##\s+/m).filter(Boolean);
    for (const s of sections) {
      const title = s.split('\n')[0].trim();
      if (/usage|getting.started|install|setup|quick.start/i.test(title)) {
        faqs.push({ q: `How do I ${title.toLowerCase()}?`, a: s.split('\n').slice(1, 5).join('\n').trim(), source: 'README.md' });
      }
    }
  }
  // From error patterns
  const errorPatterns = ['ENOENT', 'EACCES', 'MODULE_NOT_FOUND', 'ECONNREFUSED'];
  for (const err of errorPatterns) {
    faqs.push({ q: `What does ${err} mean?`, a: getErrorExplanation(err), source: 'common-errors' });
  }
  return faqs;
}

function getErrorExplanation(code) {
  const explanations = {
    ENOENT: 'File or directory not found. Check the path exists and is correctly spelled.',
    EACCES: 'Permission denied. Check file permissions or run with appropriate privileges.',
    MODULE_NOT_FOUND: 'A required dependency is missing. Run npm install to install dependencies.',
    ECONNREFUSED: 'Connection refused. The target service may not be running. Check if it is started.',
  };
  return explanations[code] || `Error code: ${code}`;
}

function generateTroubleshoot(dir) {
  const guides = [];
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    guides.push({ issue: 'Dependencies not installed', steps: ['Run `npm install` from the project root', 'Check Node.js version matches requirements', 'Delete node_modules and package-lock.json, then reinstall'], category: 'setup' });
    guides.push({ issue: 'Tests failing', steps: ['Run `npm test` to see failure details', 'Check for environment-specific issues', 'Ensure test data/fixtures are present'], category: 'testing' });
  }
  guides.push({ issue: 'Permission errors', steps: ['Check file ownership with `ls -la`', 'Ensure write permissions on target directories', 'On Linux/Mac: `chmod 755 <dir>`'], category: 'permissions' });
  guides.push({ issue: 'Out of memory', steps: ['Increase Node.js heap: `NODE_OPTIONS=--max-old-space-size=4096`', 'Check for memory leaks with --inspect', 'Process data in smaller batches'], category: 'performance' });
  return guides;
}

function generateChatbotKB(faqs, troubleshoot) {
  const intents = [];
  for (const faq of faqs) intents.push({ intent: faq.q.replace(/[?]/g, ''), response: faq.a, category: 'faq' });
  for (const guide of troubleshoot) intents.push({ intent: guide.issue, response: guide.steps.join('; '), category: 'troubleshoot' });
  return intents;
}

runSkill('automated-support-architect', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const faqs = extractFAQs(targetDir);
  const troubleshoot = generateTroubleshoot(targetDir);
  const chatbot = argv.type === 'chatbot' || argv.type === 'all' ? generateChatbotKB(faqs, troubleshoot) : null;
  const result = {
    directory: targetDir, type: argv.type,
    faqs: argv.type === 'faq' || argv.type === 'all' ? faqs : undefined,
    troubleshootingGuides: argv.type === 'troubleshoot' || argv.type === 'all' ? troubleshoot : undefined,
    chatbotKnowledgeBase: chatbot,
    totalAssets: faqs.length + troubleshoot.length + (chatbot ? chatbot.length : 0),
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
