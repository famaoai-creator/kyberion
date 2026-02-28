#!/bin/bash

# Gemini Skills Ecosystem: One-Click Setup Script
# Use this to prepare your corporate machine after cloning.

echo "🚀 Starting Gemini Skills Ecosystem Setup..."

# 1. Install Global Indexer Dependencies
npm install

# 2. Generate Global Skill Index
echo "📂 Indexing 130+ skills..."
node scripts/generate_skill_index.cjs

# 3. Ensure Sovereign Directories
echo "🛡️ Ensuring Sovereign Directories..."
mkdir -p knowledge/personal
mkdir -p knowledge/confidential
touch knowledge/personal/.gitkeep
touch knowledge/confidential/.gitkeep

# 4. Check Confidential Link
if [ ! -L "knowledge/confidential" ]; then
  echo "⚠️  Confidential Link missing. Creating local storage..."
  mkdir -p knowledge/confidential/skills
  mkdir -p knowledge/confidential/clients
  echo "✅ Local Confidential storage initialized."
else
  echo "✅ Confidential Link found."
fi

# 5. Final Verification
echo "🔍 Running self-audit..."
node scripts/test_all_skills.cjs || echo "⚠️ Some skills may require specific local tools (Xcode, etc.)"

echo "✨ Setup Complete! You are now powered by 130+ autonomous skills."
EOF
