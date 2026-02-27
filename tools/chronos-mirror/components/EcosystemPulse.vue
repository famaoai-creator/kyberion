<template>
  <div class="bg-blue-900 bg-opacity-10 border border-blue-900 rounded-lg p-6 backdrop-blur-sm">
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold text-blue-400 tracking-tighter uppercase">Ecosystem Pulse</h2>
      <div class="flex items-center gap-2">
        <span class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></span>
        <span class="text-[10px] text-gray-400 font-mono uppercase">Live Link Active</span>
      </div>
    </div>

    <div class="grid grid-cols-4 gap-4">
      <!-- Total Skills -->
      <div class="p-4 bg-black bg-opacity-40 border border-blue-900 rounded">
        <p class="text-[9px] text-gray-500 uppercase font-bold mb-1">Active Skills</p>
        <p class="text-2xl font-mono text-blue-300">{{ stats.totalSkills }}</p>
      </div>

      <!-- Active Missions -->
      <div class="p-4 bg-black bg-opacity-40 border border-blue-900 rounded">
        <p class="text-[9px] text-gray-500 uppercase font-bold mb-1">In Flight</p>
        <p class="text-2xl font-mono text-green-400">{{ stats.activeMissions }}</p>
      </div>

      <!-- Archived Missions -->
      <div class="p-4 bg-black bg-opacity-40 border border-blue-900 rounded">
        <p class="text-[9px] text-gray-500 uppercase font-bold mb-1">Archived</p>
        <p class="text-2xl font-mono text-purple-400">{{ stats.archivedMissions }}</p>
      </div>

      <!-- Health Score -->
      <div class="p-4 bg-black bg-opacity-40 border border-blue-900 rounded">
        <p class="text-[9px] text-gray-500 uppercase font-bold mb-1">Ecosystem Health</p>
        <p class="text-2xl font-mono text-cyan-400">{{ stats.healthScore }}%</p>
      </div>
    </div>

    <div class="mt-6 p-4 border-t border-blue-900 pt-4">
      <div class="flex justify-between items-center mb-2">
        <p class="text-[10px] text-gray-400 uppercase font-bold">Recent Intelligence Distillation</p>
        <button @click="fetchStats" class="text-[9px] text-blue-500 hover:text-blue-300 transition-colors uppercase font-bold">Refresh Data</button>
      </div>
      <div class="space-y-2">
        <div v-for="i in 3" :key="i" class="flex items-center gap-3 text-[10px] text-gray-500 font-mono py-1 border-b border-blue-900 border-opacity-30">
          <span class="text-blue-700">[{{ stats.lastUpdated.split('T')[1].slice(0, 8) }}]</span>
          <span class="text-gray-400">WISDOM_CORE: New success-pattern distilled from Mission MSN-X{{ i }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const stats = ref({
  totalSkills: 0,
  activeMissions: 0,
  archivedMissions: 0,
  healthScore: 0,
  lastUpdated: new Date().toISOString()
});

async function fetchStats() {
  try {
    const res = await fetch('http://localhost:3031/ecosystem-stats');
    if (res.ok) {
      stats.value = await res.json();
    }
  } catch (err) {
    console.error('Failed to fetch ecosystem stats:', err);
  }
}

onMounted(() => {
  fetchStats();
  setInterval(fetchStats, 5000);
});
</script>
