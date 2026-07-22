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
const mainApplicationPath = walk(javaRoot, 'MainApplication.kt');
if (!mainApplicationPath) throw new Error('[inference-process] MainApplication.kt not found');
const mainApplication = fs.readFileSync(mainApplicationPath, 'utf8');
const packageName = mainApplication.match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[inference-process] package name not found');
const packageDir = path.dirname(mainApplicationPath);

const serviceSource = `package ${packageName}

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class InferenceProcessService : HeadlessJsTaskService() {
  companion object {
    const val MSG_REGISTER_CLIENT = 1
    const val MSG_COMMAND = 2
    const val MSG_EVENT = 3
    const val EVENT_COMMAND = "OfflineInferenceCommand"
    @Volatile private var instance: InferenceProcessService? = null

    fun dispatchToClient(requestId: String, type: String, payloadJson: String) {
      instance?.dispatchEvent(requestId, type, payloadJson)
    }

    fun markWorkerReady() {
      instance?.onWorkerReady()
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var client: Messenger? = null
  private var workerReady = false
  private val queuedCommands = ArrayDeque<String>()
  private val incoming = Messenger(object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(message: Message) {
      when (message.what) {
        MSG_REGISTER_CLIENT -> client = message.replyTo
        MSG_COMMAND -> {
          val json = message.data.getString("json").orEmpty()
          if (workerReady) emitCommand(json) else queuedCommands.addLast(json)
        }
        else -> super.handleMessage(message)
      }
    }
  })

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onDestroy() {
    workerReady = false
    queuedCommands.clear()
    if (instance === this) instance = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent): IBinder = incoming.binder

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    super.onStartCommand(intent, flags, startId)
    return START_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig("OfflineInferenceWorker", Arguments.createMap(), 0, true)

  private fun onWorkerReady() {
    handler.post {
      workerReady = true
      while (queuedCommands.isNotEmpty()) emitCommand(queuedCommands.removeFirst())
    }
  }

  private fun emitCommand(json: String) {
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
  }

  private fun dispatchEvent(requestId: String, type: String, payloadJson: String) {
    val target = client ?: return
    val data = Bundle().apply {
      putString("requestId", requestId)
      putString("type", type)
      putString("payload", payloadJson)
    }
    val message = Message.obtain(null, MSG_EVENT).apply { this.data = data }
    try { target.send(message) } catch (_: Exception) { client = null }
  }
}
`;

const mainModuleSource = `package ${packageName}

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class InferenceProcessModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "InferenceProcess"

  private var remote: Messenger? = null
  private var bound = false
  private val waiting = mutableListOf<Promise>()

  private val receiver = Messenger(object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(message: Message) {
      if (message.what == InferenceProcessService.MSG_EVENT) {
        val map = Arguments.createMap().apply {
          putString("requestId", message.data.getString("requestId").orEmpty())
          putString("type", message.data.getString("type").orEmpty())
          putString("payload", message.data.getString("payload").orEmpty())
        }
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("OfflineInferenceEvent", map)
      } else super.handleMessage(message)
    }
  })

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      remote = Messenger(binder)
      bound = true
      try {
        remote?.send(Message.obtain(null, InferenceProcessService.MSG_REGISTER_CLIENT).apply {
          replyTo = receiver
        })
        waiting.toList().forEach { it.resolve(true) }
      } catch (error: Exception) {
        waiting.toList().forEach { it.reject("INFERENCE_PROCESS_CONNECT_FAILED", error.message, error) }
      } finally {
        waiting.clear()
      }
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      bound = false
      remote = null
    }
  }

  @ReactMethod
  fun start(promise: Promise) {
    if (bound && remote != null) {
      promise.resolve(true)
      return
    }
    try {
      val intent = Intent(context, InferenceProcessService::class.java)
      context.startService(intent)
      waiting.add(promise)
      if (!context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
        waiting.remove(promise)
        promise.reject("INFERENCE_PROCESS_BIND_FAILED", "无法绑定独立推理进程")
      }
    } catch (error: Exception) {
      waiting.remove(promise)
      promise.reject("INFERENCE_PROCESS_START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun send(commandJson: String, promise: Promise) {
    try {
      val target = remote ?: throw IllegalStateException("独立推理进程尚未连接")
      val message = Message.obtain(null, InferenceProcessService.MSG_COMMAND).apply {
        data = android.os.Bundle().apply { putString("json", commandJson) }
      }
      target.send(message)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("INFERENCE_PROCESS_SEND_FAILED", error.message, error)
    }
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}
}
`;

const workerModuleSource = `package ${packageName}

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
`;

fs.writeFileSync(path.join(packageDir, 'InferenceProcessService.kt'), serviceSource, 'utf8');
fs.writeFileSync(path.join(packageDir, 'InferenceProcessModule.kt'), mainModuleSource, 'utf8');
fs.writeFileSync(path.join(packageDir, 'InferenceWorkerBridgeModule.kt'), workerModuleSource, 'utf8');

const packagePath = path.join(packageDir, 'OfflineAiNativePackage.kt');
let packageFile = fs.readFileSync(packagePath, 'utf8');
if (!packageFile.includes('InferenceProcessModule(reactContext)')) {
  packageFile = packageFile.replace(
    'RuntimeMemoryModule(reactContext)',
    'RuntimeMemoryModule(reactContext),\n      InferenceProcessModule(reactContext),\n      InferenceWorkerBridgeModule(reactContext)'
  );
}
fs.writeFileSync(packagePath, packageFile, 'utf8');

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let manifest = fs.readFileSync(manifestPath, 'utf8');
manifest = manifest.replace(/\s*<service android:name="\.InferenceProcessService"[^>]*\/>/g, '');
manifest = manifest.replace(
  '</application>',
  '    <service android:name=".InferenceProcessService" android:process=":inference" android:exported="false" />\n  </application>'
);
fs.writeFileSync(manifestPath, manifest, 'utf8');

console.log('[inference-process] isolated worker readiness handshake injected');
