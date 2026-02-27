<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const reports = ref([]);

const fetchReports = async () => {
  try {
    const res = await fetch('http://localhost:3030/ace-reports');
    reports.value = await res.json();
  } catch (e) {
    console.error('Failed to fetch ACE reports');
  }
};

let timer;
onMounted(() => {
  fetchReports();
  timer = setInterval(fetchReports, 3000);
});

onUnmounted(() => {
  clearInterval(timer);
});

const getScoreColor = (score: string) => {
  if (score.includes('S1')) return 'text-red-500 font-bold';
  if (score.includes('S2')) return 'text-orange-500';
  if (score.includes('U1')) return 'text-blue-400 font-black';
  return 'text-green-400';
};
</script>

<template>
  <div
    class="p-4 bg-black border border-gray-800 rounded-xl text-left h-[450px] flex flex-col overflow-hidden"
  >
    <h3 class="text-xs font-bold text-gray-500 mb-4 flex items-center gap-2">
      <carbon:task-star class="text-yellow-500" /> ACE CONSENSUS AUDIT TRAIL
    </h3>

    <div class="flex-1 overflow-y-auto space-y-6 pr-2 custom-scrollbar">
      <div
        v-for="report in reports"
        :key="report.mission_id"
        class="border-l-2 border-blue-500 pl-4 py-2"
      >
        <div class="flex justify-between items-start mb-2">
          <div>
            <h4 class="text-sm font-black text-white leading-tight">{{ report.topic }}</h4>
            <p class="text-[9px] text-gray-500 font-mono">
              {{ report.mission_id }} | {{ report.timestamp }}
            </p>
          </div>
          <span
            :class="[
              'text-[10px] px-2 py-0.5 rounded font-black',
              report.decision === 'GO' ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300',
            ]"
          >
            {{ report.decision }}
          </span>
        </div>

        <!-- Participants -->
        <div class="grid grid-cols-1 gap-2 mt-3">
          <div
            v-for="p in report.participants"
            :key="p.role"
            class="bg-gray-900 bg-opacity-50 p-2 rounded border border-gray-800"
          >
            <div class="flex justify-between items-center mb-1">
              <span class="text-[9px] font-bold text-blue-300 uppercase">{{ p.role }}</span>
              <span :class="['text-[9px] font-mono', getScoreColor(p.score)]">{{ p.score }}</span>
            </div>
            <p class="text-[10px] text-gray-400 leading-relaxed">{{ p.analysis }}</p>
          </div>
        </div>
      </div>

      <div
        v-if="reports.length === 0"
        class="h-full flex items-center justify-center text-gray-700 italic text-xs animate-pulse"
      >
        Waiting for ACE deliberation evidence...
      </div>
    </div>
  </div>
</template>
