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
if (!mainApplicationPath) throw new Error('[build98-native] MainApplication.kt not found');
const mainApplication = fs.readFileSync(mainApplicationPath, 'utf8');
const packageName = mainApplication.match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[build98-native] package name not found');
const packageDir = path.dirname(mainApplicationPath);

const workerModuleSource = `package ${packageName}

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.ParcelFileDescriptor
import android.os.Process
import android.system.Os
import android.system.OsConstants
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class InferenceWorkerBridgeModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  companion object {
    @Volatile private var instance: InferenceWorkerBridgeModule? = null
    private const val DIAGNOSTIC_FILE = "inference-memory-diagnostics.jsonl"
    private const val MAX_DIAGNOSTIC_BYTES = 2L * 1024L * 1024L

    fun enqueueCommand(json: String) {
      val module = instance
        ?: throw IllegalStateException("独立推理 WorkerBridge 尚未初始化")
      module.deliverCommand(json)
    }
  }

  private val queuedCommands = ArrayDeque<String>()
  private var waitingPromise: Promise? = null
  private val diagnosticLock = Any()

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

  private fun bytesToMb(value: Long): Double = value.toDouble() / 1024.0 / 1024.0
  private fun kbToMb(value: Long): Double = value.toDouble() / 1024.0

  private fun readProcValues(file: File): Map<String, Long> {
    val result = mutableMapOf<String, Long>()
    if (!file.exists() || !file.canRead()) return result
    file.forEachLine { line ->
      val separator = line.indexOf(':')
      if (separator <= 0) return@forEachLine
      val key = line.substring(0, separator).trim()
      val value = Regex("""\\d+""").find(line.substring(separator + 1))
        ?.value
        ?.toLongOrNull()
        ?: return@forEachLine
      result[key] = value
    }
    return result
  }

  private fun diagnosticFile(): File = File(context.filesDir, DIAGNOSTIC_FILE)

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

  @ReactMethod
  fun getMemorySnapshot(promise: Promise) {
    try {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val system = ActivityManager.MemoryInfo()
      manager.getMemoryInfo(system)
      val smaps = readProcValues(File("/proc/self/smaps_rollup"))
      val status = readProcValues(File("/proc/self/status"))
      val process = Debug.MemoryInfo()
      Debug.getMemoryInfo(process)

      val result = Arguments.createMap()
      result.putDouble("timestamp", System.currentTimeMillis().toDouble())
      result.putInt("pid", Process.myPid())
      result.putString(
        "processName",
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          Application.getProcessName()
        } else {
          context.applicationInfo.processName ?: context.packageName + ":inference"
        }
      )
      result.putDouble("totalPssMb", kbToMb(smaps["Pss"] ?: process.totalPss.toLong()))
      result.putDouble("pssAnonMb", kbToMb(smaps["Pss_Anon"] ?: 0L))
      result.putDouble("pssFileMb", kbToMb(smaps["Pss_File"] ?: 0L))
      result.putDouble("pssShmemMb", kbToMb(smaps["Pss_Shmem"] ?: 0L))
      result.putDouble("rssMb", kbToMb(smaps["Rss"] ?: status["VmRSS"] ?: 0L))
      result.putDouble("swapPssMb", kbToMb(smaps["SwapPss"] ?: status["VmSwap"] ?: 0L))
      result.putDouble("privateCleanMb", kbToMb(smaps["Private_Clean"] ?: 0L))
      result.putDouble("privateDirtyMb", kbToMb(smaps["Private_Dirty"] ?: 0L))
      result.putDouble("sharedCleanMb", kbToMb(smaps["Shared_Clean"] ?: 0L))
      result.putDouble("nativeHeapAllocatedMb", bytesToMb(Debug.getNativeHeapAllocatedSize()))
      result.putDouble("nativeHeapSizeMb", bytesToMb(Debug.getNativeHeapSize()))
      result.putDouble("availMemMb", bytesToMb(system.availMem))
      result.putDouble("thresholdMb", bytesToMb(system.threshold))
      result.putBoolean("lowMemory", system.lowMemory)
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("INFERENCE_MEMORY_SNAPSHOT_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun appendMemoryDiagnostic(json: String, promise: Promise) {
    try {
      synchronized(diagnosticLock) {
        val file = diagnosticFile()
        if (file.exists() && file.length() >= MAX_DIAGNOSTIC_BYTES) {
          val rollover = file.useLines { lines ->
            lines.filter { it.isNotBlank() }.takeLast(200).joinToString("\\n")
          }
          file.writeText(if (rollover.isBlank()) "" else rollover + "\\n")
        }
        file.appendText(json + "\\n")
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("INFERENCE_DIAGNOSTIC_WRITE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun dropFileCache(modelPath: String, promise: Promise) {
    try {
      val normalized = modelPath.removePrefix("file://").removeSuffix(" (deleted)")
      val modelFile = File(normalized).canonicalFile
      if (!modelFile.exists() || !modelFile.isFile || !modelFile.canRead()) {
        throw IllegalStateException("GGUF 文件不存在或不可读取")
      }
      ParcelFileDescriptor.open(modelFile, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        Os.posix_fadvise(
          descriptor.fileDescriptor,
          0L,
          0L,
          OsConstants.POSIX_FADV_DONTNEED
        )
      }
      val result = Arguments.createMap()
      result.putBoolean("success", true)
      result.putString("message", "POSIX_FADV_DONTNEED 已发送")
      promise.resolve(result)
    } catch (error: Exception) {
      val result = Arguments.createMap()
      result.putBoolean("success", false)
      result.putString("message", error.message ?: error.javaClass.simpleName)
      promise.resolve(result)
    }
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

const runtimeMemorySource = `package ${packageName}

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Debug
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class RuntimeMemoryModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  companion object {
    private const val DIAGNOSTIC_FILE = "inference-memory-diagnostics.jsonl"
  }

  override fun getName(): String = "RuntimeMemory"

  private fun bytesToMb(value: Long): Double = value.toDouble() / 1024.0 / 1024.0
  private fun kbToMb(value: Long): Double = value.toDouble() / 1024.0
  private fun diagnosticFile(): File = File(context.filesDir, DIAGNOSTIC_FILE)

  @ReactMethod
  fun getSnapshot(promise: Promise) {
    try {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val system = ActivityManager.MemoryInfo()
      manager.getMemoryInfo(system)
      val process = Debug.MemoryInfo()
      Debug.getMemoryInfo(process)
      val result = Arguments.createMap()
      result.putDouble("totalMemMb", bytesToMb(system.totalMem))
      result.putDouble("availMemMb", bytesToMb(system.availMem))
      result.putDouble("thresholdMb", bytesToMb(system.threshold))
      result.putBoolean("lowMemory", system.lowMemory)
      result.putDouble("totalPssMb", process.totalPss.toDouble() / 1024.0)
      result.putDouble("nativeHeapAllocatedMb", bytesToMb(Debug.getNativeHeapAllocatedSize()))
      result.putDouble("nativeHeapSizeMb", bytesToMb(Debug.getNativeHeapSize()))
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("MEMORY_SNAPSHOT_FAILED", error.message, error)
    }
  }

  private fun reasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
    ApplicationExitInfo.REASON_CRASH -> "JAVA_CRASH"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "NATIVE_CRASH"
    ApplicationExitInfo.REASON_ANR -> "ANR"
    ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
    ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
    ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "PACKAGE_UPDATED"
    else -> "REASON_$reason"
  }

  @ReactMethod
  fun getPreviousExit(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      promise.resolve(null)
      return
    }
    try {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val exit = manager.getHistoricalProcessExitReasons(context.packageName, 0, 10).firstOrNull()
      if (exit == null) {
        promise.resolve(null)
        return
      }
      val result = Arguments.createMap()
      result.putString("reason", reasonName(exit.reason))
      result.putString("description", exit.description ?: "")
      result.putDouble("timestamp", exit.timestamp.toDouble())
      result.putDouble("pssMb", kbToMb(exit.pss))
      result.putDouble("rssMb", kbToMb(exit.rss))
      result.putInt("status", exit.status)
      result.putInt("importance", exit.importance)
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("PREVIOUS_EXIT_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun getLatestInferenceDiagnostic(promise: Promise) {
    try {
      val file = diagnosticFile()
      if (!file.exists() || file.length() == 0L) {
        promise.resolve(null)
        return
      }
      val latest = file.useLines { lines ->
        lines.filter { it.isNotBlank() }.lastOrNull()
      }
      promise.resolve(latest)
    } catch (error: Exception) {
      promise.reject("INFERENCE_DIAGNOSTIC_READ_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun clearInferenceDiagnosticLog(promise: Promise) {
    try {
      val file = diagnosticFile()
      if (file.exists() && !file.delete()) {
        file.writeText("")
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("INFERENCE_DIAGNOSTIC_CLEAR_FAILED", error.message, error)
    }
  }
}
`;

fs.writeFileSync(path.join(packageDir, 'InferenceWorkerBridgeModule.kt'), workerModuleSource, 'utf8');
fs.writeFileSync(path.join(packageDir, 'RuntimeMemoryModule.kt'), runtimeMemorySource, 'utf8');

const workerPath = path.join(packageDir, 'InferenceWorkerBridgeModule.kt');
const memoryPath = path.join(packageDir, 'RuntimeMemoryModule.kt');
const worker = fs.readFileSync(workerPath, 'utf8');
const memory = fs.readFileSync(memoryPath, 'utf8');

for (const required of [
  'getMemorySnapshot',
  'Pss_File',
  'POSIX_FADV_DONTNEED',
  'appendMemoryDiagnostic',
  'waitForCommand',
]) {
  if (!worker.includes(required)) {
    throw new Error(`[build98-native] worker invariant missing: ${required}`);
  }
}
for (const required of ['getLatestInferenceDiagnostic', 'clearInferenceDiagnosticLog']) {
  if (!memory.includes(required)) {
    throw new Error(`[build98-native] memory invariant missing: ${required}`);
  }
}

console.log('[build98-native] inference PSS diagnostics and file-cache experiment injected');
