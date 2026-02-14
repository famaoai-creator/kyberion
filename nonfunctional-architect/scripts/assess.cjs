const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { prompt } = require('enquirer');
const chalk = require('chalk');
const ejs = require('ejs');

const ASSETS_DIR = path.join(__dirname, '../assets');
const REQUIREMENTS_FILE = path.join(ASSETS_DIR, 'requirements.yaml');
const OUTPUT_FILE = 'nonfunctional_requirements.md';

const { analyzeIaC } = require('./iac_analyzer.cjs');

// --- Load Data ---

let requirementsData;
// ... (Loading logic remains same) ...
try {
  const fileContents = fs.readFileSync(REQUIREMENTS_FILE, 'utf8');
  requirementsData = yaml.load(fileContents).nonfunctional_requirements;

  // Clean up data (remove extra whitespace/newlines from excel extraction)
  const cleanText = (str) => {
    if (!str) return '';
    return (
      str
        .replace(/\r?\n/g, '') // Remove newlines first (common in Excel merged cells)
        .replace(/\s+/g, ' ') // Collapse multiple spaces to one
        // Remove spaces between Japanese characters
        .replace(/([あ-んア-ン一-龠々])\s+([あ-んア-ン一-龠々])/g, '$1$2')
        // Remove spaces between Japanese characters and punctuation/brackets
        .replace(/([あ-んア-ン一-龠々])\s+([（）「」『』【】、。！？])/g, '$1$2')
        .replace(/([（）「」『』【】、。！？])\s+([あ-んア-ン一-龠々])/g, '$1$2')
        .trim()
    );
  };

  requirementsData.forEach((cat) => {
    cat.category = cleanText(cat.category); // Clean Category name
    cat.sub_categories.forEach((sub) => {
      sub.name = cleanText(sub.name); // Clean Sub-Category name
      sub.items.forEach((item) => {
        item.name = cleanText(item.name);
        item.metrics = cleanText(item.metrics);
        item.description = cleanText(item.description);

        if (item.levels) {
          Object.keys(item.levels).forEach((k) => {
            item.levels[k] = cleanText(item.levels[k]);
          });
        }
      });
    });
  });
} catch (_e) {
  console.error(chalk.red(`Error loading knowledge base: ${e.message}`));
  process.exit(1);
}

// --- Logic ---

async function main() {
  console.log(chalk.bold.cyan('\n🏗️  Non-Functional Architect (IPA Grade 2018)\n'));
  console.log(
    chalk.gray(
      'This tool will guide you through defining the non-functional requirements for your system.'
    )
  );

  console.log(chalk.yellow('\n【使用条件について】'));
  console.log(chalk.gray('本ツールはIPA「非機能要求グレード2018」を利用しています。'));
  console.log(
    chalk.gray('ご利用にあたっては、以下のIPA公式サイトの使用条件を必ずご確認ください：')
  );
  console.log(
    chalk.blue.underline(
      'https://www.ipa.go.jp/archive/digital/iot-en-ci/jyouryuu/hikinou/ent03-b-1.html\n'
    )
  );

  // 0. IaC Analysis
  console.log(chalk.gray('Scanning codebase for infrastructure configurations...'));
  const iacFindings = analyzeIaC(process.cwd());
  const findingsCount = Object.keys(iacFindings).length;
  if (findingsCount > 0) {
    console.log(chalk.green(`✔ Detected ${findingsCount} configurations from IaC files.\n`));
  } else {
    console.log(chalk.gray('  No relevant IaC configurations found.\n'));
  }

  // 1. Initial Assessment (Model Case Selection)
  const modelResponse = await prompt({
    type: 'select',
    name: 'model',
    message: 'Select the social impact level of your system (Model Case):',
    choices: [
      {
        name: 'low_impact',
        message: 'Low Impact (Internal/Departmental systems, negligible social impact)',
      },
      {
        name: 'mid_impact',
        message: 'Mid Impact (Standard enterprise systems, limited social impact)',
      },
      {
        name: 'high_impact',
        message: 'High Impact (Critical infrastructure, public systems, large social impact)',
      },
    ],
  });

  const selectedModel = modelResponse.model;
  console.log(chalk.green(`\nSelected Model: ${selectedModel}\n`));

  // 2. Category Selection (Scope)
  const categories = requirementsData.map((r) => r.category);
  const scopeResponse = await prompt({
    type: 'multiselect',
    name: 'categories',
    message: 'Which categories do you want to define?',
    choices: categories,
    initial: categories, // Select all by default
  });

  if (scopeResponse.categories.length === 0) {
    console.log(chalk.yellow('No categories selected. Exiting.'));
    process.exit(0);
  }

  const decisions = {};

  // 3. Interactive Definition
  for (const categoryName of scopeResponse.categories) {
    console.log(chalk.bold.yellow(`\n--- ${categoryName} ---`));
    decisions[categoryName] = [];

    const categoryData = requirementsData.find((r) => r.category === categoryName);

    for (const subCat of categoryData.sub_categories) {
      console.log(chalk.cyan(`\n[${subCat.name}]`));

      for (const item of subCat.items) {
        // Filter items that don't have levels defined (headers or descriptions only)
        if (!item.levels || Object.keys(item.levels).length === 0) continue;

        // Determine suggested level from model case
        let suggestedLevel = item.model_case_levels ? item.model_case_levels[selectedModel] : 'N/A';
        let sourceNote = '';

        // Override with IaC finding if available
        if (iacFindings[item.id]) {
          suggestedLevel = iacFindings[item.id].level;
          sourceNote = chalk.green(` (Detected from ${iacFindings[item.id].source})`);
        }

        // Build choices
        const choices = Object.entries(item.levels).map(([lvl, desc]) => {
          const isSuggested = String(lvl) === String(suggestedLevel);
          return {
            name: lvl,
            message: `Level ${lvl}: ${desc} ${isSuggested ? chalk.green('(Recommended)') : ''}`,
            value: lvl,
          };
        });

        // Ask user
        const question = {
          type: 'select',
          name: 'level',
          message: `${item.name} (${item.metrics || item.id})${sourceNote}`,
          choices: choices,
          initial: choices.findIndex((c) => String(c.name) === String(suggestedLevel)),
        };

        // Add "Skip" option if needed, but for now we force selection or use default
        // Showing description before prompt
        if (item.description) {
          console.log(chalk.gray(`  > ${item.description}`));
        }

        try {
          const answer = await prompt(question);
          decisions[categoryName].push({
            item: item,
            selected_level: answer.level,
            selected_desc: item.levels[answer.level],
          });
        } catch (_e) {
          console.log('\nOperation cancelled.');
          process.exit(0);
        }
      }
    }
  }

  // 4. Generate Report
  console.log(chalk.cyan('\nGenerating report...'));
  generateReport(decisions, selectedModel);
}

function generateReport(decisions, model) {
  // Pre-process data to handle newlines for Markdown/HTML
  const processedDecisions = {};
  Object.keys(decisions).forEach((category) => {
    processedDecisions[category] = decisions[category].map((d) => {
      return {
        ...d,
        selected_desc: d.selected_desc.replace(/\r?\n/g, '<br>'),
        item: {
          ...d.item,
          name: d.item.name.replace(/\r?\n/g, '<br>'),
          metrics: d.item.metrics.replace(/\r?\n/g, '<br>'),
        },
      };
    });
  });

  const template = `
# Non-Functional Requirements Definition

**Date:** <%= new Date().toLocaleDateString() %>
**System Impact Model:** <%= model %>

<% Object.keys(processedDecisions).forEach(category => { %>
## <%= category %>

| ID | Item | Metrics | Level | Description |
| :--- | :--- | :--- | :---: | :--- |
<% processedDecisions[category].forEach(d => { %>| <%= d.item.id %> | <%= d.item.name %> | <%= d.item.metrics %> | **<%= d.selected_level %>** | <%= d.selected_desc %> |
<% }); %>
<% }); %>

---
*Generated by Gemini Non-Functional Architect*
    `;

  const markdown = ejs.render(template, { processedDecisions, model });
  safeWriteFile(OUTPUT_FILE, markdown.trim());
  console.log(chalk.green(`\n✔ Report saved to: ${process.cwd()}/${OUTPUT_FILE}`));
}

main();
