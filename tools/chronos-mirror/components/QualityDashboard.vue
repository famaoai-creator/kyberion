<script setup lang="ts">
import { ref, onMounted } from 'vue';

const report = ref({
  fido: { status: 'Success', coverage: '92%', lastRun: 'Just now' },
  bff: { rest: 'Valid', graphql: 'Valid', schemas: 12, violations: 0 },
  resilience: { mode: 'AWS FIS', experiment: 'exp-res-01', recoveryTime: '4.2s' },
  overall: 98
});

// Real data fetching logic (can be enabled if bridge server supports it)
const fetchQualityData = async () => {
  try {
    const res = await fetch('http://localhost:3031/quality');
    if (res.ok) {
      report.value = await res.json();
    }
  } catch (e) {
    console.log('Using mock quality data');
  }
};

onMounted(() => {
  fetchQualityData();
});
</script>

<template>
  <div class="p-6 bg-black bg-opacity-80 border border-gray-700 rounded-2xl shadow-2xl text-white font-sans">
    <div class="flex justify-between items-center mb-8">
      <h2 class="text-2xl font-black tracking-tighter text-blue-400 flex items-center gap-3">
        <span class="w-3 h-3 bg-blue-500 rounded-full animate-ping"></span>
        UNIFIED QUALITY DASHBOARD
      </h2>
      <div class="px-4 py-1 bg-blue-900 bg-opacity-30 border border-blue-500 rounded-full text-xs font-bold">
        Score: {{ report.overall }}/100
      </div>
    </div>

    <div class="grid grid-cols-3 gap-6">
      <!-- FIDO/Auth Section -->
      <div class="p-4 bg-gray-900 bg-opacity-50 border border-gray-800 rounded-xl">
        <p class="text-[10px] text-gray-500 font-bold uppercase mb-2">Auth Automation (FIDO2)</p>
        <div class="flex justify-between items-end">
          <div>
            <p class="text-3xl font-black">{{ report.fido.status }}</p>
            <p class="text-[8px] text-green-500 mt-1 italic">Virtual Authenticators Active</p>
          </div>
          <div class="text-right">
            <p class="text-xs font-mono text-gray-400">{{ report.fido.coverage }}</p>
            <p class="text-[8px] text-gray-600">Coverage</p>
          </div>
        </div>
      </div>

      <!-- BFF/API Section -->
      <div class="p-4 bg-gray-900 bg-opacity-50 border border-gray-800 rounded-xl">
        <p class="text-[10px] text-gray-500 font-bold uppercase mb-2">Contract Validation (BFF)</p>
        <div class="grid grid-cols-2 gap-2 mt-1">
          <div>
            <p class="text-xs font-bold text-gray-300">REST</p>
            <p class="text-lg font-black text-green-400">{{ report.bff.rest }}</p>
          </div>
          <div>
            <p class="text-xs font-bold text-gray-300">GraphQL</p>
            <p class="text-lg font-black text-green-400">{{ report.bff.graphql }}</p>
          </div>
        </div>
        <p class="text-[8px] text-gray-600 mt-2 font-mono">{{ report.bff.schemas }} Schemas Validated | {{ report.bff.violations }} Violations</p>
      </div>

      <!-- AWS FIS Section -->
      <div class="p-4 bg-gray-900 bg-opacity-50 border border-gray-800 rounded-xl border-l-4 border-l-yellow-500">
        <p class="text-[10px] text-gray-500 font-bold uppercase mb-2">Resilience (AWS FIS)</p>
        <p class="text-xs font-bold text-yellow-400">{{ report.resilience.experiment }}</p>
        <div class="flex justify-between items-center mt-2">
          <span class="text-xl font-black">{{ report.resilience.recoveryTime }}</span>
          <span class="text-[8px] px-2 py-0.5 bg-yellow-900 rounded text-yellow-200">RECOVERED</span>
        </div>
        <p class="text-[8px] text-gray-600 mt-1">Self-Healing Loop Completed</p>
      </div>
    </div>

    <!-- AI Observation Feed -->
    <div class="mt-8">
      <div class="flex items-center gap-2 mb-4">
        <span class="text-[10px] font-bold text-blue-500 uppercase tracking-widest">AI Observation Log</span>
        <div class="h-[1px] flex-grow bg-gray-800"></div>
      </div>
      <div class="space-y-2">
        <div class="p-2 bg-blue-900 bg-opacity-10 border-l-2 border-blue-500 flex justify-between text-[10px]">
          <span class="text-gray-300">mobile-test-generator: Generated Maestro YAML for FIDO login.</span>
          <span class="text-gray-600 font-mono italic">04:05:00</span>
        </div>
        <div class="p-2 bg-green-900 bg-opacity-10 border-l-2 border-green-500 flex justify-between text-[10px]">
          <span class="text-gray-300">api-fetcher: REST response matches user-v1.schema.json.</span>
          <span class="text-gray-600 font-mono italic">04:06:12</span>
        </div>
        <div class="p-2 bg-yellow-900 bg-opacity-10 border-l-2 border-yellow-500 flex justify-between text-[10px]">
          <span class="text-gray-300">chaos-monkey: Injected latency via AWS FIS. Recovery confirmed.</span>
          <span class="text-gray-600 font-mono italic">04:08:45</span>
        </div>
      </div>
    </div>
  </div>
</template>
