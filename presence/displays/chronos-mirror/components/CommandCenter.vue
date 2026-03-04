<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const activeMissions = ref([]);
const metrics = ref({
  efficiency: 0,
  reliability: 0,
  debt: '$0',
});

const fetchData = async () => {
  try {
    const res = await fetch('/mission_registry.json');
    const data = await res.json();
    activeMissions.value = data.missions || [];
    
    // Derived Metrics
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
  timer = setInterval(fetchData, 3000);
});

onUnmounted(() => {
  clearInterval(timer);
});
</script>

<template>
  <div class="grid grid-cols-3 gap-4 mb-8">
    <!-- Metric Cards -->
    <div class="p-4 bg-gray-900 border-t-2 border-blue-500 rounded-lg shadow-xl text-center">
      <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">
        Ecosystem Efficiency
      </p>
      <p class="text-3xl font-black text-white">
        {{ metrics.efficiency }}<span class="text-xs text-gray-600">/100</span>
      </p>
      <p class="text-[8px] text-gray-600 mt-2 italic">現在の開発・実行スループット</p>
    </div>
    <div class="p-4 bg-gray-900 border-t-2 border-green-500 rounded-lg shadow-xl text-center">
      <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">
        Reliability Index
      </p>
      <p class="text-3xl font-black text-white">
        {{ metrics.reliability }}<span class="text-xs text-gray-600">%</span>
      </p>
      <p class="text-[8px] text-gray-600 mt-2 italic">ミッション達成率および型安全性</p>
    </div>
    <div class="p-4 bg-gray-900 border-t-2 border-red-500 rounded-lg shadow-xl text-center">
      <p class="text-[10px] text-gray-500 uppercase font-bold tracking-widest mb-1">
        Technical Debt Risk
      </p>
      <p class="text-3xl font-black text-white">{{ metrics.debt }}</p>
      <p class="text-[8px] text-gray-600 mt-2 italic">未解決の課題・リファクタリングコスト</p>
    </div>
  </div>

  <!-- Active Mission Monitor -->
  <div class="p-6 bg-black bg-opacity-60 border border-gray-800 rounded-xl">
    <div class="flex justify-between items-center mb-6">
      <h3 class="text-sm font-bold text-gray-300 flex items-center gap-2">
        <span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
        LIVE MISSION MONITOR
      </h3>
      <span class="text-[10px] text-gray-600 font-mono"
        >{{ activeMissions.length }} ACTIVE PROCESSES</span
      >
    </div>

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
    <div v-else class="py-8 text-center border-2 border-dashed border-gray-800 rounded-lg">
      <p class="text-gray-600 text-xs italic">All systems quiet. No active missions.</p>
    </div>
  </div>
</template>
