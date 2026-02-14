<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

const history = ref([])
const currentIndex = ref(2) // デフォルトは最新

onMounted(async () => {
  const res = await fetch('/history.json')
  history.value = await res.json()
  currentIndex.value = history.value.length - 1
})

const currentState = computed(() => {
  return history.value[currentIndex.value] || { efficiency: 0, reliability: 0, date: '', note: '' }
})
</script>

<template>
  <div class="p-6 border border-gray-700 rounded-xl bg-gray-900 bg-opacity-50 shadow-2xl">
    <div class="flex justify-between items-center mb-6">
      <h2 class="text-xl font-bold text-blue-400">Temporal Reality Mirror</h2>
      <span class="px-3 py-1 bg-blue-900 text-blue-200 rounded-full text-xs font-mono">
        {{ currentState.date }}
      </span>
    </div>

    <!-- スライダー -->
    <input 
      type="range" 
      min="0" 
      :max="history.length - 1" 
      v-model="currentIndex" 
      class="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500 mb-8"
    />

    <div class="grid grid-cols-2 gap-6">
      <div class="text-center">
        <p class="text-xs text-gray-500 uppercase tracking-widest mb-1">Efficiency</p>
        <p class="text-5xl font-black text-white transition-all duration-500 transform scale-110" :style="{ color: currentState.efficiency > 50 ? '#4ade80' : '#fbbf24' }">
          {{ currentState.efficiency }}<span class="text-sm font-normal text-gray-500">/100</span>
        </p>
      </div>
      <div class="text-center border-l border-gray-800">
        <p class="text-xs text-gray-500 uppercase tracking-widest mb-1">Reliability</p>
        <p class="text-5xl font-black text-white">
          {{ currentState.reliability }}<span class="text-sm font-normal text-gray-500">%</span>
        </p>
      </div>
    </div>

    <div class="mt-8 p-4 bg-black bg-opacity-30 rounded border-l-4 border-blue-500 text-left">
      <p class="text-xs text-blue-300 font-bold mb-1 uppercase italic">Architect's Log:</p>
      <p class="text-sm text-gray-300 italic">"{{ currentState.note }}"</p>
    </div>
  </div>
</template>

<style scoped>
input[type='range']::-webkit-slider-thumb {
  width: 20px;
  height: 20px;
  background: #3b82f6;
  border-radius: 50%;
  box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);
}
</style>
