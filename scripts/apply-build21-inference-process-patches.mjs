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

// Extend the generated Android bridge with a real secondary Android process.
// This build intentionally adds only process lifecycle/IPC plumbing; model calls
// remain unchanged until the llama.rn JSI bridge is made service-safe.
const injectPath = 'scripts/inject-external-model-native.mjs';
let inject = fs.readFileSync(injectPath, 'utf8');

replaceRequired(
  injectPath,
  "const packagePath = path.join(packageDir, 'OfflineAiNativePackage.kt');",
  "const packagePath = path.join(packageDir, 'OfflineAiNativePackage.kt');\nconst inferenceServicePath = path.join(packageDir, 'InferenceProcessService.kt');\nconst inferenceProcessModulePath = path.join(packageDir, 'InferenceProcessModule.kt');"
);
inject = fs.readFileSync(injectPath, 'utf8');

const packageMarker = 'const packageSource = `package ${packageName}';
if (!inject.includes('const inferenceServiceSource = `package ${packageName}')) {
  const insertion = String.raw`
const inferenceServiceSource = \`package \${packageName}

import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.Process

class InferenceProcessService : Service() {
  inner class LocalBinder : Binder() {
    fun processId(): Int = Process.myPid()
    fun processName(): String = applicationInfo.processName ?: "\${packageName}:inference"
  }

  private val binder = LocalBinder()

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
}
\`;

const inferenceProcessModuleSource = \`package \${packageName}

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class InferenceProcessModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "InferenceProcess"

  private var service: InferenceProcessService? = null
  private var bound = false
  private val pending = mutableListOf<Promise>()

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      service = (binder as? InferenceProcessService.LocalBinder)?.let { local ->
        val field = local.javaClass.enclosingClass
        null
      }
      bound = true
      val result = Arguments.createMap().apply {
        putBoolean("running", true)
        putInt("uiPid", android.os.Process.myPid())
        putString("process", "\${context.packageName}:inference")
      }
      pending.toList().forEach { it.resolve(result) }
      pending.clear()
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      bound = false
      service = null
    }
  }

  @ReactMethod
  fun start(promise: Promise) {
    try {
      val intent = Intent(context, InferenceProcessService::class.java)
      context.startService(intent)
      if (bound) {
        val result = Arguments.createMap().apply {
          putBoolean("running", true)
          putInt("uiPid", android.os.Process.myPid())
          putString("process", "\${context.packageName}:inference")
        }
        promise.resolve(result)
      } else {
        pending.add(promise)
        context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
      }
    } catch (error: Exception) {
      promise.reject("INFERENCE_PROCESS_START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      if (bound) context.unbindService(connection)
      bound = false
      service = null
      context.stopService(Intent(context, InferenceProcessService::class.java))
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("INFERENCE_PROCESS_STOP_FAILED", error.message, error)
    }
  }
}
\`;

`;
  const index = inject.indexOf(packageMarker);
  if (index < 0) throw new Error('[build21] package source marker not found');
  inject = inject.slice(0, index) + insertion + inject.slice(index);
}

inject = inject.replace(
  'RuntimeMemoryModule(reactContext)\n    )',
  'RuntimeMemoryModule(reactContext),\n      InferenceProcessModule(reactContext)\n    )'
);

inject = inject.replace(
  "fs.writeFileSync(packagePath, packageSource, 'utf8');",
  "fs.writeFileSync(packagePath, packageSource, 'utf8');\nfs.writeFileSync(inferenceServicePath, inferenceServiceSource, 'utf8');\nfs.writeFileSync(inferenceProcessModulePath, inferenceProcessModuleSource, 'utf8');"
);

inject = inject.replace(
  "fs.writeFileSync(manifestPath, manifest, 'utf8');",
  `if (!manifest.includes('android:name=".InferenceProcessService"')) {\n  manifest = manifest.replace(\n    '</application>',\n    '  <service android:name=".InferenceProcessService" android:process=":inference" android:exported="false" />\\n  </application>'\n  );\n}\nfs.writeFileSync(manifestPath, manifest, 'utf8');`
);

fs.writeFileSync(injectPath, inject, 'utf8');
console.log('[build21] preset and inference-process patches applied');
