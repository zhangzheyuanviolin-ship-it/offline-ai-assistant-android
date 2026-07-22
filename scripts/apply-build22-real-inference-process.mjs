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

const injector = 'scripts/inject-real-inference-process.mjs';
replaceRequired(injector, "import com.facebook.react.ReactApplication\\n", '');
replaceRequired(injector, "import com.facebook.react.modules.core.DeviceEventManagerModule\\n", '');
replaceRequired(injector, '    const val EVENT_COMMAND = "OfflineInferenceCommand"\\n', '');
replaceRequired(
  injector,
  `  private fun emitCommand(json: String) {
    val app = application as ReactApplication
    val reactContext = app.reactNativeHost.reactInstanceManager.currentReactContext
    if (reactContext == null) {
      queuedCommands.addFirst(json)
      workerReady = false
      return
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_COMMAND, json)
  }`,
  `  private fun emitCommand(json: String) {
    InferenceWorkerBridgeModule.enqueueCommand(json)
  }`
);

const oldWorkerModule = `const workerModuleSource = \`package \${packageName}

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class InferenceWorkerBridgeModule(
  context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "InferenceWorkerBridge"

  @ReactMethod
  fun ready() {
    InferenceProcessService.markWorkerReady()
  }

  @ReactMethod
  fun emit(requestId: String, type: String, payloadJson: String) {
    InferenceProcessService.dispatchToClient(requestId, type, payloadJson)
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
\`;`;

const newWorkerModule = `const workerModuleSource = \`package \${packageName}

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class InferenceWorkerBridgeModule(
  context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  companion object {
    @Volatile private var instance: InferenceWorkerBridgeModule? = null

    fun enqueueCommand(json: String) {
      val module = instance
        ?: throw IllegalStateException("独立推理 WorkerBridge 尚未初始化")
      module.deliverCommand(json)
    }
  }

  private val queuedCommands = ArrayDeque<String>()
  private var waitingPromise: Promise? = null

  init {
    instance = this
  }

  override fun getName(): String = "InferenceWorkerBridge"

  private fun deliverCommand(json: String) {
    val waiter = waitingPromise
    if (waiter != null) {
      waitingPromise = null
      waiter.resolve(json)
    } else {
      queuedCommands.addLast(json)
    }
  }

  @ReactMethod
  fun ready() {
    InferenceProcessService.markWorkerReady()
  }

  @ReactMethod
  fun waitForCommand(promise: Promise) {
    if (queuedCommands.isNotEmpty()) {
      promise.resolve(queuedCommands.removeFirst())
      return
    }
    waitingPromise?.reject(
      "INFERENCE_WORKER_WAITER_REPLACED",
      "独立推理进程出现重复命令等待器"
    )
    waitingPromise = promise
  }

  @ReactMethod
  fun emit(requestId: String, type: String, payloadJson: String) {
    InferenceProcessService.dispatchToClient(requestId, type, payloadJson)
  }

  override fun invalidate() {
    waitingPromise?.reject(
      "INFERENCE_WORKER_INVALIDATED",
      "独立推理 WorkerBridge 已失效"
    )
    waitingPromise = null
    queuedCommands.clear()
    if (instance === this) instance = null
    super.invalidate()
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
\`;`;
replaceRequired(injector, oldWorkerModule, newWorkerModule);

const patchedInjector = fs.readFileSync(injector, 'utf8');
if (patchedInjector.includes('currentReactContext') || !patchedInjector.includes('waitForCommand')) {
  throw new Error('[build95] native command queue patch invariant failed');
}

console.log('[build22/build95] model routing and native Promise command queue prepared');
