#!/bin/bash

echo "🩺 Gemini Skills Doctor: System Diagnosis"
echo "========================================"

# 1. Node.js Check
NODE_VERSION=$(node -v 2>/dev/null)
if [ -z "$NODE_VERSION" ]; then
    echo "❌ Node.js not found. Please install Node.js v18+."
else
    echo "✅ Node.js found: $NODE_VERSION"
fi

# 2. Git Check
if git status > /dev/null 2>&1; then
    echo "✅ Git repository verified."
else
    echo "❌ Not a valid Git repository."
fi

# 3. Confidential Link Check
if [ -L "knowledge/confidential" ]; then
    echo "✅ Confidential Knowledge link active."
else
    echo "⚠️  Confidential Knowledge link missing. (Run scripts/setup_ecosystem.sh to fix)"
fi

# 4. Network Check (npm)
echo "🔍 Checking network connectivity..."
if npm ping > /dev/null 2>&1; then
    echo "✅ NPM Registry reachable."
else
    echo "❌ NPM Registry unreachable. Check your proxy settings."
fi

echo "========================================"
echo "Diagnosis Complete."
