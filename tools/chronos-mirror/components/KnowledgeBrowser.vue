<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { marked } from 'marked'

const files = ref([])
const selectedFile = ref(null)
const markdownContent = ref('')
const searchQuery = ref('')

onMounted(async () => {
  const res = await fetch('/knowledge_index.json')
  files.value = await res.json()
  if (files.value.length > 0) {
    selectFile(files.value[0])
  }
})

const filteredFiles = computed(() => {
  if (!searchQuery.value) return files.value
  const query = searchQuery.value.toLowerCase()
  return files.value.filter(f => 
    f.title.toLowerCase().includes(query) || f.id.toLowerCase().includes(query)
  )
})

const selectFile = async (file) => {
  selectedFile.value = file
  const res = await fetch(file.path)
  const text = await res.text()
  markdownContent.value = marked(text)
}
</script>

<template>
  <div class="flex h-[450px] border border-gray-700 rounded-lg overflow-hidden bg-gray-900 bg-opacity-50 shadow-2xl text-left">
    <!-- サイドバー: ファイルリスト -->
    <div class="w-1/3 border-r border-gray-700 flex flex-col bg-black bg-opacity-20">
      <div class="p-3 border-bottom border-gray-700">
        <input 
          v-model="searchQuery" 
          placeholder="Search knowledge..." 
          class="w-full bg-gray-800 text-xs p-2 rounded border border-gray-600 focus:border-blue-500 outline-none"
        />
      </div>
      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <div 
          v-for="file in filteredFiles" 
          :key="file.id"
          @click="selectFile(file)"
          :class="['p-2 cursor-pointer text-[10px] border-b border-gray-800 hover:bg-blue-900 hover:bg-opacity-30 transition', 
                   selectedFile?.id === file.id ? 'bg-blue-900 bg-opacity-40 border-l-4 border-blue-500' : '']"
        >
          <div class="font-bold text-gray-200 truncate">{{ file.title }}</div>
          <div class="text-[8px] text-gray-500 truncate">{{ file.id }}</div>
        </div>
      </div>
    </div>

    <!-- メインコンテンツ: Markdown表示 -->
    <div class="w-2/3 p-6 overflow-y-auto custom-scrollbar bg-white bg-opacity-[0.02]">
      <div v-if="selectedFile" class="prose prose-sm prose-invert max-w-none">
        <div class="mb-4 pb-2 border-b border-gray-800 flex justify-between items-center">
          <span class="text-[10px] font-mono text-blue-400 uppercase tracking-widest">{{ selectedFile.category }}</span>
          <span class="text-[8px] text-gray-600">ID: {{ selectedFile.id }}</span>
        </div>
        <div v-html="markdownContent" class="markdown-body"></div>
      </div>
      <div v-else class="h-full flex items-center justify-center text-gray-600 animate-pulse italic text-sm">
        Select a document to begin...
      </div>
    </div>
  </div>
</template>

<style>
.markdown-body {
  font-size: 11px;
  line-height: 1.6;
}
.markdown-body h1 { @apply text-xl font-bold mb-4 text-blue-400; }
.markdown-body h2 { @apply text-lg font-bold mt-6 mb-2 border-b border-gray-800 pb-1; }
.markdown-body h3 { @apply text-base font-bold mt-4 mb-1 text-gray-200; }
.markdown-body p { @apply mb-3 text-gray-300; }
.markdown-body ul { @apply list-disc list-inside mb-3 ml-2; }
.markdown-body code { @apply bg-gray-800 px-1 rounded text-pink-400 font-mono; }
.markdown-body pre { @apply bg-black p-3 rounded mb-4 overflow-x-auto border border-gray-800; }

.custom-scrollbar::-webkit-scrollbar { width: 4px; }
.custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
.custom-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 10px; }
.custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #444; }
</style>
