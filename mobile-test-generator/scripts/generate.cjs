#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { execSync } = require('child_process');
const { runAsyncSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const pathResolver = require('../../scripts/lib/path-resolver.cjs');

const argv = createStandardYargs()
  .option('app-id', { alias: 'a', type: 'string', demandOption: true })
  .option('scenario', { alias: 's', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .argv;

runAsyncSkill('mobile-test-generator', async () => {
  const appId = argv['app-id'];
  const scenario = argv.scenario;
  const outPath = argv.out || path.join(pathResolver.activeRoot(), `test-${Date.now()}.yaml`);

  console.log(chalk.cyan(`\n\ud83d\udcf1 Generating Mobile Test Flow for: "${scenario}"`));

  // 1. AI を使って YAML を生成 (Prompting Gemini)
  const systemPrompt = `
あなたはモバイルテスト自動化の専門家（Rigorous Validator）です。
以下のシナリオに基づき、Maestro (https://maestro.mobile.dev/) 用のテストYAMLを生成せよ。

【App ID】: ${appId}
【シナリオ】: ${scenario}

【規程】:
1. 'appId: ${appId}' で開始せよ。
2. '---' の後にアクションを記述せよ。
3. Accessibility ID を優先したセレクタを使用せよ。
4. 各ステップの間に必要に応じて 'assertVisible' を入れ、安定性を確保せよ。
5. 出力は YAML コードのみとせよ。
`.trim();

  let yamlOutput = "";
  try {
    // 既存の gemini CLI を呼び出して生成
    yamlOutput = execSync(`gemini --prompt "${systemPrompt.replace(/"/g, '\\"')}"`, { 
      encoding: 'utf8', env: { ...process.env, GEMINI_FORMAT: 'text' } 
    });
    
    // コードブロックのみ抽出
    const match = yamlOutput.match(/appId:[\s\S]+/);
    if (match) yamlOutput = match[0].replace(/```yaml|```/g, '').trim();

    fs.writeFileSync(outPath, yamlOutput);
    console.log(chalk.green(`  \u2714 Maestro YAML created: ${outPath}`));
    console.log(chalk.dim(`\n---\n${yamlOutput}\n---`));

  } catch (e) {
    throw new Error(`Failed to generate YAML: ${e.message}`);
  }

  return { appId, scenario, output: outPath };
});
