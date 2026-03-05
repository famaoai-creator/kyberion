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

    // Derived Metrics (Fixed/Hardcoded for now as per design)
    metrics.value.efficiency = 85; 
    metrics.value.reliability = 100;
    metrics.value.debt = '$420/hr';
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
      <div v-if="activeMissions.length > 0" class="space-y-3">
        <div
          v-for="mission in activeMissions"
          :key="mission.id"
          class="p-3 bg-gray-900 bg-opacity-40 rounded border border-gray-800 flex justify-between items-center"
        >
          <div>
            <p class="text-[10px] font-mono text-blue-400">{{ mission.id }}</p>
            <p class="text-xs font-bold text-gray-200 mt-1">
              {{ mission.persona || 'General Agent' }}
            </p>
          </div>
          <div class="text-right">
            <div class="flex items-center gap-2 justify-end">
              <span :class="{
                'px-2 py-0.5 rounded text-[8px] font-bold': true,
                'bg-blue-900 text-blue-200': mission.status === 'active',
                'bg-yellow-900 text-yellow-200': mission.status === 'paused',
                'bg-green-900 text-green-200': mission.status === 'done'
              }">{{ mission.status.toUpperCase() }}</span>
              <div class="w-12 h-1 bg-gray-800 rounded-full overflow-hidden">
                <div class="h-full bg-blue-500 w-full" :class="{'animate-pulse': mission.status === 'active'}"></div>
              </div>
            </div>
            <p class="text-[8px] text-gray-600 mt-1">
              Priority: {{ mission.priority }}/10
            </p>
          </div>
        </div>
      </div>
      <div v-else class="text-center py-4 text-gray-600 text-xs italic">No active missions</div>
      <div class="mt-4 pt-4 border-t border-gray-800">
        <span class="text-[10px] text-gray-600 font-mono"
          >{{ activeMissions.length }} ACTIVE PROCESSES</span
        >
      </div>
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
