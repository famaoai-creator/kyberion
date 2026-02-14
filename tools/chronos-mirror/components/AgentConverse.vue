<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

const intent = ref('')
const timeline = ref([])
const isSending = ref(false)

const sendToAgent = async () => {
  if (!intent.value) return
  isSending.value = true
  
  await fetch('http://localhost:3030/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: intent.value })
  })
  
  intent.value = ''
  isSending.value = false
}

const fetchTimeline = async () => {
  try {
    const res = await fetch('http://localhost:3030/responses')
    timeline.value = await res.json()
  } catch (e) {
    console.error("Failed to fetch timeline")
  }
}

let timer
onMounted(() => {
  fetchTimeline()
  timer = setInterval(fetchTimeline, 2000)
})

onUnmounted(() => {
  clearInterval(timer)
})
</script>

<template>
  <div class="p-6 bg-gray-900 border border-blue-500 rounded-xl shadow-2xl text-left font-sans flex flex-col h-[500px]">
    <h2 class="text-blue-400 font-black mb-4 tracking-tighter flex items-center gap-2 uppercase">
      <carbon:flow-connection class="animate-pulse"/> Gemini Omni-Queue
    </h2>

    <!-- Input -->
    <div class="relative mb-6">
      <input 
        v-model="intent" 
        @keyup.enter="sendToAgent"
        placeholder="命令をキューへ投入..."
        class="w-full bg-black border border-gray-700 p-3 rounded-lg text-sm text-white focus:border-blue-500 outline-none"
      />
      <button @click="sendToAgent" class="absolute right-2 top-1.5 p-2 text-blue-500">
        <carbon:add-alt v-if="!isSending"/><carbon:pending v-else class="animate-spin"/>
      </button>
    </div>

    <!-- Timeline Area -->
    <div class="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar">
      <div v-for="msg in timeline.slice().reverse()" :key="msg.id" 
           :class="['p-3 rounded-lg border border-gray-800 transition-all', 
                    msg.status === 'thinking' ? 'bg-blue-900 bg-opacity-10 border-blue-900' : 'bg-black bg-opacity-40']">
        <div class="flex justify-between items-center mb-2">
          <span class="text-[8px] font-mono text-gray-500 uppercase">{{ msg.id }}</span>
          <span :class="['text-[8px] px-2 py-0.5 rounded-full font-bold uppercase', 
                         msg.status === 'complete' ? 'bg-green-900 text-green-400' : 'bg-yellow-900 text-yellow-400 animate-pulse']">
            {{ msg.status }}
          </span>
        </div>
        <p class="text-[10px] text-blue-300 font-bold italic mb-1">{{ msg.thought }}</p>
        <pre v-if="msg.result" class="text-[9px] text-gray-400 mt-2 whitespace-pre-wrap">{{ msg.result }}</pre>
        <div class="text-[7px] text-gray-600 mt-2 text-right">{{ msg.timestamp }}</div>
      </div>
      
      <div v-if="timeline.length === 0" class="h-full flex items-center justify-center text-gray-600 italic text-sm animate-pulse">
        No active missions in queue.
      </div>
    </div>
  </div>
</template>
