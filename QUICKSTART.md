# Quick Start Guide: Gemini Skills Ecosystem

Welcome! This guide will help you set up the world's most advanced autonomous engineering platform in **less than 5 minutes**.

## Step 1: Install & Setup
Run the following commands in your terminal:

```bash
# 1. Clone the repository
git clone https://github.com/famaoai-creator/gemini-skills.git
cd gemini-skills

# 2. Run the Interactive Wizard (Recommended)
# This will install dependencies and configure the agent for your role.
node scripts/init_wizard.cjs
```

## Step 2: Verify Your Environment
Ensure everything is working correctly by running the self-diagnosis tool:

```bash
bash scripts/troubleshoot_doctor.sh
```

## Step 3: Your First Mission
Now, ask Gemini to perform a task. Here are some starter prompts based on your role:

### 👩‍💻 For Engineers
> "Analyze this repository structure and suggest a refactoring plan."
> (Uses: `codebase-mapper`, `refactoring-engine`)

### 💼 For CEOs / Managers
> "Draft a strategic roadmap for the next quarter based on current market trends."
> (Uses: `strategic-roadmap-planner`, `competitive-intel-strategist`)

### 🛡️ For Security / Audit
> "Perform a full security scan and generate a compliance report."
> (Uses: `security-scanner`, `compliance-officer`)

---
**Need Help?**
See `README.md` for the full list of 142 skills, or ask Gemini: "Help me find the right skill for [Task]."
