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

### 4. Create and Publish
When creating a new skill, use `skill-creator` and then:
1. `git init` (if it's a new standalone repo)
2. `git add .`
3. `git commit -m "Initial commit"`
4. `git remote add origin <url>`
5. `git push -u origin main`
