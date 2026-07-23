import fs from 'node:fs';

const checks = [
  ['package.json', '"main": "index.js"'],
  ['lib/services/model-service.ts', 'createRemoteLlamaContext'],
  ['app/(tabs)/settings.tsx', "cache_type_v: 'f16'"],
  ['index.js', "registerHeadlessTask('OfflineInferenceWorker'"],
  ['lib/types.ts', 'low_residency_enabled'],
  ['lib/services/runtime-memory.ts', 'getInferenceDiagnosticLog'],
  ['lib/services/inference-worker.ts', 'performLowResidencyDrop'],
  ['app/(tabs)/settings.tsx', 'low_residency_interval_tokens: 128'],
  ['app/(tabs)/settings.tsx', '分享完整推理日志'],
];

for (const [file, marker] of checks) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(marker)) {
    throw new Error(`[build118-verify] missing marker in ${file}: ${marker}`);
  }
  console.log(`[build118-verify] ok ${file}: ${marker}`);
}
