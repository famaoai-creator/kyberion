---
name: github-skills-manager
description: Manage Gemini skills stored in GitHub repositories (monorepos or individual). Use this when you need to clone, update (pull), check status, or publish (push) skills.
---

# GitHub Skills Manager

## Overview
This skill helps you manage your collection of Gemini skills across one or more Git repositories. It supports both monorepos (multiple skills in one repo) and individual skill repositories.

## Quick Start
To see the status of all your skill repositories in the current directory:
1. Run `node scripts/git_status.cjs`
2. It will list all directories that are Git repositories, their current branch, and if they have uncommitted changes.

## Capabilities

### 1. List and Status
Check which skills are under Git control and if they need attention.
- Use `node scripts/git_status.cjs [path]` to see an overview.

### 2. Sync (Pull)
Keep your skills up to date with the remote repository.
- Run `git pull` inside the specific skill directory.
- To update all, loop through directories and run `git pull`.

### 3. Clone New Skills
Bring in new skills from GitHub.
- Use `git clone <url>` inside your skills directory.

### 4. Create New Skill
Initialize a new skill in the current monorepo.
- Run `node scripts/create_skill.cjs <skill-name>`
- This uses the standard `skill-creator` to set up the directory structure.

### 5. Publish Changes
To save your changes to GitHub:
1. `git add .`
2. `git commit -m "Update skills"`
3. `git push`
