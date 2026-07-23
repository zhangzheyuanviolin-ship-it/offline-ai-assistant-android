import fs from 'node:fs';

function replaceRequired(path, from, to) {
  const before = fs.readFileSync(path, 'utf8');
  if (!before.includes(from)) {
    if (before.includes(to)) return;
    throw new Error(`[build21] required pattern not found in ${path}: ${from}`);
  }
  fs.writeFileSync(path, before.replace(from, to), 'utf8');
}

// Quantized V cache requires flash attention in llama.cpp. The CPU-stable preset
// explicitly disables flash attention, therefore V must remain f16.
replaceRequired(
  'app/(tabs)/settings.tsx',
  "      cache_type_v: 'q8_0',",
  "      cache_type_v: 'f16',"
);
replaceRequired(
  'app/(tabs)/settings.tsx',
  'Q8 KV 缓存、mmap、no_extra_bufts 和 1.5 GB 内存保护',
  'Q8 K 缓存、F16 V 缓存、mmap、no_extra_bufts 和 1.5 GB 内存保护'
);

console.log('[build21] MoE preset patch applied');
