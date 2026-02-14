<script setup lang="ts">
import { ref } from 'vue'

const command = ref('')
const history = ref([])
const isRunning = ref(false)

const execute = async () => {
  if (!command.value || isRunning.value) return
  
  const cmdText = command.value
  isRunning.value = true
  command.value = ''
  
  const entry = { cmd: cmdText, output: '...', status: 'running' }
  history.value.unshift(entry)

  try {
    const response = await fetch('http://localhost:3030/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmdText })
    })
    const data = await response.json()
    entry.output = data.output
    entry.status = 'done'
  } catch (err) {
    entry.output = 'Execution failed. Bridge server might be down.'
    entry.status = 'error'
  } finally {
    isRunning.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-[400px] border border-gray-700 rounded-lg overflow-hidden bg-black bg-opacity-80 font-mono shadow-2xl text-left">
    <!-- Header -->
    <div class="bg-gray-800 px-4 py-2 text-[10px] text-gray-400 flex justify-between items-center border-b border-gray-700">
      <span>GEMINI CLI - REMOTE CONSOLE</span>
      <div v-if="isRunning" class="flex gap-1">
        <span class="w-1 h-1 bg-blue-500 animate-ping rounded-full"></span>
        <span class="w-1 h-1 bg-blue-500 animate-ping rounded-full delay-75"></span>
        <span class="w-1 h-1 bg-blue-500 animate-ping rounded-full delay-150"></span>
      </div>
    </div>

    <!-- Output Area -->
    <div class="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-4">
      <div v-for="(entry, i) in history" :key="i" class="border-l-2" :class="entry.status === 'error' ? 'border-red-500' : 'border-blue-500'">
        <div class="pl-3 py-1 flex items-center gap-2">
          <span class="text-blue-400 text-xs">$ node scripts/cli.cjs</span>
          <span class="text-white text-xs font-bold">{{ entry.cmd }}</span>
        </div>
        <pre class="pl-3 mt-1 text-[9px] text-gray-400 whitespace-pre-wrap leading-tight">{{ entry.output }}</pre>
      </div>
      <div v-if="history.length === 0" class="h-full flex items-center justify-center text-gray-600 italic text-xs animate-pulse">
        Waiting for command input...
      </div>
    </div>

    <!-- Input Area -->
    <div class="p-3 bg-gray-900 border-t border-gray-700">
      <div class="flex items-center gap-2">
        <span class="text-blue-500 font-bold">$</span>
        <input 
          v-model="command" 
          @keyup.enter="execute"
          :disabled="isRunning"
          placeholder="e.g., run security-scanner --dir ." 
          class="flex-1 bg-transparent text-white text-xs outline-none"
          autofocus
        />
      </div>
    </div>
  </div>
</template>
