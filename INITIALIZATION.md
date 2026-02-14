# Ecosystem Initialization Protocol

This document defines the procedure for initializing the Gemini Skills environment.

## 1. Trigger

This protocol is invoked when `knowledge/personal/role-config.json` is missing or when the user explicitly requests a reset.

## 2. Procedure

The agent MUST guide the user through the following steps via dialogue:

### Step 1: Domain Selection

Ask the user to select from the following domains:

1. Leadership & Strategy
2. Engineering & Operations
3. Business & Growth
4. Governance & Quality
5. Support & Stewardship

### Step 2: Role Selection

Based on the domain, present specific roles defined in `scripts/init_wizard.cjs`.

### Step 3: Environment Setup

Upon role selection, the agent MUST execute:

1. Save `knowledge/personal/role-config.json`.
2. Generate index: `node scripts/generate_skill_index.cjs`.
3. Create role-based bundle using `skill-bundle-packager`.

## 3. Victory Condition

The environment is considered initialized when:

- `role-config.json` exists.
- `global_skill_index.json` is updated.
- A starter bundle for the role is created in `work/bundles/`.
