<template>
  <div class="max-w-4xl mx-auto">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Step 1: WHY -->
      <div class="group p-6 bg-blue-900 bg-opacity-10 border border-blue-900 rounded-xl hover:bg-opacity-20 transition-all duration-500">
        <div class="w-12 h-12 bg-blue-600 bg-opacity-20 rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
          <carbon:idea class="text-blue-400 text-2xl" />
        </div>
        <h3 class="text-blue-300 font-bold text-lg mb-2 uppercase tracking-tighter">1. WHY? (利用シーン)</h3>
        <p class="text-gray-400 text-xs leading-relaxed text-left">
          「全体像を把握したい」「AIの判断根拠を知りたい」「自然な言葉で戦略を練りたい」時にここを開いてください。ここは、AIの内部状態を人間に映し出す「鏡」です。
        </p>
      </div>

      <!-- Step 2: WHEN -->
      <div class="group p-6 bg-purple-900 bg-opacity-10 border border-purple-900 rounded-xl hover:bg-opacity-20 transition-all duration-500">
        <div class="w-12 h-12 bg-purple-600 bg-opacity-20 rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
          <carbon:timer class="text-purple-400 text-2xl" />
        </div>
        <h3 class="text-purple-300 font-bold text-lg mb-2 uppercase tracking-tighter">2. WHEN? (タイミング)</h3>
        <p class="text-gray-400 text-xs leading-relaxed text-left">
          ターミナルのログが速すぎて追えない時や、重要な意思決定（ACE）を確認したい時。そして、AIに新しい大規模な「ミッション」を授けたい時に活用してください。
        </p>
      </div>

      <!-- Step 3: HOW -->
      <div class="group p-6 bg-green-900 bg-opacity-10 border border-green-900 rounded-xl hover:bg-opacity-20 transition-all duration-500">
        <div class="w-12 h-12 bg-green-600 bg-opacity-20 rounded-lg flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
          <carbon:rocket class="text-green-400 text-2xl" />
        </div>
        <h3 class="text-green-300 font-bold text-lg mb-2 uppercase tracking-tighter">3. HOW? (操作方法)</h3>
        <p class="text-gray-400 text-xs leading-relaxed text-left">
          コマンドを覚える必要はありません。<b>Pulse</b>で鼓動を確認し、<b>Agent Interaction Hub</b>で意図を伝えてください。意図は物理的なコードへと変換されます。
        </p>
      </div>
    </div>

    <div class="mt-12 flex flex-col items-center">
      <div class="px-8 py-3 bg-gradient-to-r from-blue-600 to-purple-600 rounded-full font-black text-white text-sm tracking-[0.2em] shadow-2xl animate-bounce cursor-pointer hover:scale-105 transition-transform uppercase" @click="$slidev.nav.next">
        Welcome to the Cockpit - Enter the Bridge
      </div>
      <p class="mt-4 text-[10px] text-gray-500 font-mono uppercase tracking-widest">Reality-Mirroring Interface v1.0 • Ready for Command</p>
    </div>
  </div>
</template>

<script setup>
// No logic needed for now, but Slidev will pass $slidev globally
</script>

<style scoped>
.tracking-tighter {
  letter-spacing: -0.05em;
}
</style>
