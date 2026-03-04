<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const activeMissions = ref([]);
const stimuli = ref([]);
const metrics = ref({ efficiency: 88, reliability: 100, debt: '$420/hr' });

const fetchData = async () => {
  try {
    const regRes = await fetch('/mission_registry.json');
    if (regRes.ok) {
      const regData = await regRes.json();
      activeMissions.value = regData.missions || [];
    }

    const stimRes = await fetch('/stimuli_feed.json');
    if (stimRes.ok) {
      stimuli.value = (await stimRes.json()).reverse(); // Newest first
    }
  } catch (e) {
    console.error('Dashboard sync failed');
  }
};

let timer;
onMounted(() => {
  fetchData();
  timer = setInterval(fetchData, 5000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="grid grid-cols-3 gap-4 mb-8">
    <div class="p-4 bg-gray-900 border-t-2 border-blue-500 rounded-lg shadow-xl text-center">
      <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Ecosystem Efficiency</p>
      <p class="text-3xl font-black text-white">{{ metrics.efficiency }}<span class="text-xs text-gray-600">/100</span></p>
    </div>
    <div class="p-4 bg-gray-900 border-t-2 border-green-500 rounded-lg shadow-xl text-center">
      <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Reliability Index</p>
      <p class="text-3xl font-black text-white">{{ metrics.reliability }}<span class="text-xs text-gray-600">%</span></p>
    </div>
    <div class="p-4 bg-gray-900 border-t-2 border-red-500 rounded-lg shadow-xl text-center">
      <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">Technical Debt</p>
      <p class="text-3xl font-black text-white">{{ metrics.debt }}</p>
    </div>
  </div>

  <div class="grid grid-cols-2 gap-6">
    <!-- Active Mission Monitor -->
    <div class="p-6 bg-black bg-opacity-60 border border-gray-800 rounded-xl">
      <h3 class="text-xs font-bold text-gray-400 mb-4 flex items-center gap-2">
        <span class="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
        ACTIVE MISSIONS
      </h3>
      <div v-if="activeMissions.length > 0" class="space-y-2">
        <div v-for="m in activeMissions" :key="m.id" class="p-3 bg-gray-900 border border-gray-800 rounded flex justify-between items-center">
          <div>
            <p class="text-[10px] font-mono text-blue-400">{{ m.id }}</p>
            <p class="text-xs font-bold text-gray-200">{{ m.persona }}</p>
          </div>
          <span class="text-[8px] px-2 py-0.5 bg-blue-900 text-blue-200 rounded font-bold">{{ m.status.toUpperCase() }}</span>
        </div>
      </div>
      <div v-else class="text-center py-4 text-gray-600 text-xs italic">No active missions</div>
    </div>

    <!-- Sensory Stimuli Feed -->
    <div class="p-6 bg-black bg-opacity-60 border border-gray-800 rounded-xl">
      <h3 class="text-xs font-bold text-gray-400 mb-4 flex items-center gap-2">
        <span class="w-2 h-2 bg-magenta-500 rounded-full animate-ping" style="background-color: #ff00ff;"></span>
        SENSORY FEED (GUSP v1.0)
      </h3>
      <div v-if="stimuli.length > 0" class="space-y-2 overflow-y-auto max-h-[300px]">
        <div v-for="s in stimuli" :key="s.id" class="p-2 bg-gray-900 border-l-2 border-magenta-500 rounded text-[10px]">
          <div class="flex justify-between text-gray-500 mb-1">
            <span class="font-mono">{{ s.origin.channel.toUpperCase() }}</span>
            <span>{{ new Date(s.ts).toLocaleTimeString() }}</span>
          </div>
          <p class="text-gray-200 truncate">{{ s.signal.payload }}</p>
          <div class="flex gap-2 mt-1">
            <span :class="{'text-yellow-500': s.control.status === 'pending', 'text-green-500': s.control.status === 'injected'}">
              ● {{ s.control.status }}
            </span>
          </div>
        </div>
      </div>
      <div v-else class="text-center py-4 text-gray-600 text-xs italic">Sensory silence</div>
    </div>
  </div>
</template>
