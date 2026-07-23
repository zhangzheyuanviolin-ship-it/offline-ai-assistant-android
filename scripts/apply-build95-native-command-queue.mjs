import fs from 'node:fs';
import path from 'node:path';

function walk(dir, target) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = walk(full, target);
      if (found) return found;
    } else if (entry.name === target) {
      return full;
    }
  }
  return null;
}

const javaRoot = 'android/app/src/main/java';
const servicePath = walk(javaRoot, 'InferenceProcessService.kt');
const bridgePath = walk(javaRoot, 'InferenceWorkerBridgeModule.kt');
if (!servicePath || !bridgePath) {
  throw new Error('[build95] generated inference process files not found');
}

let service = fs.readFileSync(servicePath, 'utf8');
service = service
  .replace('import com.facebook.react.ReactApplication\n', '')
  .replace('import com.facebook.react.modules.core.DeviceEventManagerModule\n', '')
  .replace('    const val EVENT_COMMAND = "OfflineInferenceCommand"\n', '');

const oldEmitCommand = `  private fun emitCommand(json: String) {
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
  }`;

const newEmitCommand = `  private fun emitCommand(json: String) {
    InferenceWorkerBridgeModule.enqueueCommand(json)
  }`;

if (!service.includes(oldEmitCommand)) {
  throw new Error('[build95] legacy DeviceEventEmitter command bridge not found');
}
service = service.replace(oldEmitCommand, newEmitCommand);
fs.writeFileSync(servicePath, service, 'utf8');

const bridge = fs.readFileSync(bridgePath, 'utf8');
const packageName = bridge.match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[build95] package name not found');

const replacement = `package ${packageName}

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
`;

fs.writeFileSync(bridgePath, replacement, 'utf8');
console.log('[build95] native Promise command queue replaced cross-context DeviceEventEmitter delivery');
