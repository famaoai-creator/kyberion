<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  skill: string
  label: string
  args?: string
}>()

const status = ref('idle')
const result = ref('')
const error = ref('')

const summonAgent = async () => {
  status.value = 'running'
  result.value = ''
  error.value = ''
  
  try {
    const response = await fetch('http://localhost:3030/summon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        skill: props.skill, 
        args: props.args ? props.args.split(' ') : [] 
      })
    })
    
    const data = await response.json()
    if (data.status === 'success') {
      status.value = 'success'
      result.value = data.output
    } else {
      throw new Error(data.message || 'Unknown error')
    }
  } catch (err) {
    status.value = 'error'
    error.value = err.message
  }
}
</script>

<template>
  <div class="p-4 border border-blue-500 rounded-lg bg-blue-900 bg-opacity-10 my-4 shadow-inner">
    <div class="flex justify-between items-center">
      <div class="flex items-center gap-3">
        <div :class="['w-3 h-3 rounded-full', 
                      status === 'running' ? 'bg-yellow-500 animate-ping' : 
                      status === 'success' ? 'bg-green-500' : 
                      status === 'error' ? 'bg-red-500' : 'bg-blue-500']"></div>
        <span class="font-bold text-sm tracking-wide uppercase">{{ label }}</span>
      </div>
      <button 
        @click="summonAgent"
        :disabled="status === 'running'"
        class="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 rounded text-white text-xs font-bold transition-all shadow-lg"
      >
        <span v-if="status === 'idle'">SUMMON AGENT</span>
        <span v-else-if="status === 'running'">PROCESSING...</span>
        <span v-else-if="status === 'success'">COMPLETE</span>
        <span v-else>RETRY</span>
      </div>
    </div>
    
    <!-- Result Area -->
    <div v-if="result" class="mt-4 p-3 bg-black bg-opacity-40 rounded text-[10px] font-mono text-blue-300 overflow-y-auto max-h-40 border border-blue-900">
      <pre>{{ result }}</pre>
    </div>
    
    <!-- Error Area -->
    <div v-if="error" class="mt-4 p-2 bg-red-900 bg-opacity-20 rounded text-[10px] text-red-400 font-mono italic border border-red-900">
      Error: {{ error }}
    </div>
  </div>
</template>
