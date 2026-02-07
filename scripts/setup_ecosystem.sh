#!/bin/bash

# Gemini Skills Ecosystem: One-Click Setup Script
# Use this to prepare your corporate machine after cloning.

echo "🚀 Starting Gemini Skills Ecosystem Setup..."

# 1. Install Global Indexer Dependencies
npm install

# 2. Generate Global Skill Index
echo "📂 Indexing 130+ skills..."
node scripts/generate_skill_index.cjs

# 3. Check Confidential Link
if [ ! -L "knowledge/confidential" ]; then
  echo "⚠️  Confidential Link missing. Creating dummy placeholder..."
  mkdir -p ../gemini-confidential-knowledge/skills
  mkdir -p ../gemini-confidential-knowledge/clients
  ln -s "$(realpath ../gemini-confidential-knowledge)" knowledge/confidential
  echo "✅ Linked to ../gemini-confidential-knowledge"
else
  echo "✅ Confidential Link found."
fi

# 4. Final Verification
echo "🔍 Running self-audit..."
node scripts/test_all_skills.cjs || echo "⚠️ Some skills may require specific local tools (Xcode, etc.)"

echo "✨ Setup Complete! You are now powered by 130+ autonomous skills."
EOF
