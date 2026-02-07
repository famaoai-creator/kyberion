const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const { logger } = require('./lib/core.cjs');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

async function main() {
    console.clear();
    console.log("✨ Welcome to Gemini Skills Ecosystem Setup Wizard ✨\n");

    // 1. Role Selection
    console.log("Which role best describes you?");
    console.log("1. Software Engineer (Code, Test, DevOps)");
    console.log("2. CEO / Executive (Strategy, Finance, Org)");
    console.log("3. PM / Auditor (Management, Compliance, QA)");
    
    const roleChoice = await askQuestion("\nEnter number (1-3): ");
    
    logger.info("Initializing environment...");

    // 2. Base Setup (Install Dependencies)
    try {
        logger.info("Installing core dependencies (npm install)...");
        execSync('npm install', { stdio: 'inherit' });
        logger.success("Dependencies installed.");
    } catch (e) {
        logger.error("Failed to install dependencies. Check your Node.js version.");
    }

    // 3. Index Generation
    try {
        logger.info("Generating Global Skill Index...");
        execSync('node scripts/generate_skill_index.cjs', { stdio: 'inherit' });
    } catch (e) {
        logger.error("Failed to generate skill index.");
    }

    // 4. Role-Specific Configuration
    let roleName = "Engineer";
    if (roleChoice === '2') roleName = "CEO";
    if (roleChoice === '3') roleName = "PM/Auditor";

    logger.success(`Configuration complete for role: ${roleName}`);
    
    // 5. Create Local Secrets Directory
    const personalDir = path.resolve(__dirname, '../knowledge/personal');
    if (!fs.existsSync(personalDir)) {
        fs.mkdirSync(personalDir, { recursive: true });
        fs.writeFileSync(path.join(personalDir, 'README.md'), '# Personal Secrets\nStore your API keys here.');
        logger.info("Created 'knowledge/personal/' for your secrets.");
    }

    console.log("\n✅ Setup Finished! You are ready to go.");
    console.log(`Try asking: "Act as a ${roleName} and help me with..."`);
    
    rl.close();
}

main();
