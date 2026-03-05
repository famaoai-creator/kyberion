<script setup lang="ts">
import { ref, onMounted } from 'vue';

const report = ref({
  timestamp: '',
  overall: 'PENDING',
  checks: [] as any[]
});

const fetchQualityData = async () => {
  try {
    const res = await fetch('/doctor_report.json');
    if (res.ok) {
      report.value = await res.json();
    }
  } catch (e) {
    console.log('Using mock quality data', e);
  }
};

onMounted(() => {
  fetchQualityData();
  setInterval(fetchQualityData, 5000);
});
</script>

<template>
  <div class="p-6 bg-black bg-opacity-80 border border-gray-700 rounded-2xl shadow-2xl text-white font-sans">
    <div class="flex justify-between items-center mb-8">
      <h2 class="text-2xl font-black tracking-tighter text-blue-400 flex items-center gap-3">
        <span class="w-3 h-3 bg-blue-500 rounded-full animate-ping"></span>
        SYSTEM INTEGRITY (DOCTOR)
      </h2>
      <div :class="{
        'px-4 py-1 border rounded-full text-xs font-bold': true,
        'bg-green-900 bg-opacity-30 border-green-500 text-green-400': report.overall === 'PASSED',
        'bg-red-900 bg-opacity-30 border-red-500 text-red-400': report.overall !== 'PASSED'
      }">
        Overall: {{ report.overall }}
      </div>
    </div>

    <div class="grid grid-cols-2 gap-6">
      <div v-for="(check, index) in report.checks" :key="index" 
           class="p-4 bg-gray-900 bg-opacity-50 border border-gray-800 rounded-xl">
        <p class="text-[10px] text-gray-500 font-bold uppercase mb-2">{{ check.name }}</p>
        <div class="flex justify-between items-end">
          <div>
            <p class="text-xl font-black flex items-center gap-2">
              <span>{{ check.icon }}</span> {{ check.status.toUpperCase() }}
            </p>
            <p class="text-[10px] text-gray-400 mt-1">{{ check.detail }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Last Updated -->
    <div class="mt-8 text-right">
      <span class="text-[10px] text-gray-600 font-mono italic">
        Last Scanned: {{ report.timestamp ? new Date(report.timestamp).toLocaleString() : 'N/A' }}
      </span>
    </div>
  </div>
</template>
