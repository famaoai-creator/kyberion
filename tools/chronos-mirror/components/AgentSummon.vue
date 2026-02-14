<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  skill: string
  label: string
}>()

const status = ref('idle')
const result = ref('')

const summonAgent = async () => {
  status.value = 'running'
  // 実際の実装では、ここで API 経由で Gemini CLI スキルを叩く
  setTimeout(() => {
    status.value = 'success'
    result.value = `Agent ${props.skill} has completed the analysis.`
  }, 2000)
}
</script>

<template>
  <div class="p-4 border border-blue-500 rounded bg-blue-900 bg-opacity-20 my-4">
    <div class="flex justify-between items-center">
      <span class="font-bold">{{ label }}</span>
      <button 
        @click="summonAgent"
        :disabled="status === 'running'"
        class="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-white text-sm transition"
      >
        <span v-if="status === 'idle'">エージェント召喚</span>
        <span v-else-if="status === 'running'">分析中...</span>
        <span v-else>完了</span>
      </button>
    </div>
    <div v-if="result" class="mt-2 text-xs text-blue-300 font-mono italic">
      {{ result }}
    </div>
  </div>
</template>
