<script setup lang="ts">
import { ref, onMounted } from 'vue';

const tree = ref({});

const fetchSkills = async () => {
  try {
    const res = await fetch('http://localhost:3030/skills-tree');
    tree.value = await res.json();
  } catch (e) {
    console.error('Failed to fetch skills tree');
  }
};

onMounted(() => {
  fetchSkills();
});

const getCategoryIcon = (cat: string) => {
  const icons = {
    core: 'carbon:chip',
    engineering: 'carbon:tool-kit',
    audit: 'carbon:security',
    connector: 'carbon:connect',
    media: 'carbon:document-view',
    intelligence: 'carbon:brain',
    ux: 'carbon:user-avatar-filled',
    business: 'carbon:chart-line',
    utilities: 'carbon:settings',
  };
  return icons[cat] || 'carbon:folder';
};
</script>

<template>
  <div
    class="grid grid-cols-3 gap-3 p-4 bg-black bg-opacity-40 rounded-xl max-h-[480px] overflow-y-auto custom-scrollbar"
  >
    <div
      v-for="(skills, cat) in tree"
      :key="cat"
      class="p-3 border border-gray-800 rounded-lg bg-gray-900 bg-opacity-30 hover:border-blue-900 transition-colors"
    >
      <div class="flex items-center gap-2 mb-3 border-b border-gray-800 pb-2">
        <component :is="getCategoryIcon(cat)" class="text-blue-400 text-sm" />
        <h4 class="text-[10px] font-black text-gray-400 uppercase tracking-widest">{{ cat }}</h4>
        <span class="ml-auto text-[8px] text-gray-600 bg-black px-1.5 py-0.5 rounded-full">{{
          skills.length
        }}</span>
      </div>
      <div class="flex flex-wrap gap-1">
        <span
          v-for="skill in skills"
          :key="skill"
          class="text-[7px] px-1.5 py-0.5 bg-black bg-opacity-60 text-gray-500 rounded border border-gray-900 hover:text-blue-300 hover:border-blue-900 cursor-pointer"
        >
          {{ skill }}
        </span>
      </div>
    </div>
  </div>
</template>
