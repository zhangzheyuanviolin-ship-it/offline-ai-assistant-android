import fs from 'node:fs';

function replaceRequired(file, from, to) {
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    if (before.includes(to)) return;
    throw new Error(`[build22] required pattern missing in ${file}`);
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
}

const packagePath = 'package.json';
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.main = 'index.js';
fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

const modelService = 'lib/services/model-service.ts';
replaceRequired(
  modelService,
  "import { initLlama, LlamaContext, releaseAllLlama } from 'llama.rn';",
  "import type { LlamaContext } from 'llama.rn';\nimport { createRemoteLlamaContext, releaseRemoteLlamaAll } from './inference-process-client';"
);

const oldInit = `    const context = await initLlama(
      {
        model: resolvedPath,
        n_ctx: params.n_ctx,
        n_batch: params.n_batch,
        n_ubatch: Math.max(1, Math.min(params.n_ubatch, params.n_batch)),
        n_threads: params.n_threads,
        n_gpu_layers: params.n_gpu_layers,
        use_mlock: params.use_mlock,
        use_mmap: params.use_mmap,
        cache_type_k: params.cache_type_k,
        cache_type_v: params.cache_type_v,
        n_parallel: 1,
        kv_unified: true,
        no_extra_bufts: params.no_extra_bufts,
        flash_attn_type: params.n_gpu_layers > 0 ? 'auto' : 'off',
        swa_full: false,
      } as Parameters<typeof initLlama>[0],
      (progress) => onProgress?.(progress)
    );
    _activeInferenceParams = { ...params };
    _activeContext = installCompletionGuard(context);`;
const newInit = `    const context = await createRemoteLlamaContext(
      model,
      resolvedPath,
      params,
      (progress) => onProgress?.(progress)
    );
    _activeInferenceParams = { ...params };
    _activeContext = installCompletionGuard(context);`;
replaceRequired(modelService, oldInit, newInit);
replaceRequired(modelService, '  await releaseAllLlama();', '  await releaseRemoteLlamaAll();');

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

console.log('[build22] model load, completion, stop and release routed to :inference');
