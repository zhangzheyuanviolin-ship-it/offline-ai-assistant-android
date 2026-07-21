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
if (!mainApplicationPath) throw new Error('[native-bridge] MainApplication.kt not found after Expo prebuild');

let mainApplication = fs.readFileSync(mainApplicationPath, 'utf8');
const packageName = mainApplication.match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[native-bridge] Android package name not found');

if (!mainApplication.includes('OfflineAiNativePackage()')) {
  const applyPattern = /(PackageList\(this\)\.packages\.apply\s*\{)([\s\S]*?)(\n\s*\})/m;
  if (!applyPattern.test(mainApplication)) {
    throw new Error('[native-bridge] getPackages apply block not found');
  }
  mainApplication = mainApplication.replace(
    applyPattern,
    (_match, start, body, end) => `${start}${body}\n        add(OfflineAiNativePackage())${end}`
  );
  fs.writeFileSync(mainApplicationPath, mainApplication, 'utf8');
}

const packageDir = path.dirname(mainApplicationPath);
const externalModulePath = path.join(packageDir, 'ExternalModelFileModule.kt');
const memoryModulePath = path.join(packageDir, 'RuntimeMemoryModule.kt');
const packagePath = path.join(packageDir, 'OfflineAiNativePackage.kt');

const externalModuleSource = `package ${packageName}

import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.system.Os
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class ExternalModelFileModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "ExternalModelFile"

  private fun readableFile(path: String?): File? {
    if (path.isNullOrBlank()) return null
    return try {
      val file = File(path.removeSuffix(" (deleted)")).canonicalFile
      if (file.exists() && file.isFile && file.canRead()) file else null
    } catch (_: Exception) {
      null
    }
  }

  private fun pathFromDocumentUri(uri: Uri): File? {
    return try {
      if (!DocumentsContract.isDocumentUri(context, uri)) return null
      val documentId = DocumentsContract.getDocumentId(uri)
      when (uri.authority) {
        "com.android.externalstorage.documents" -> {
          val parts = documentId.split(":", limit = 2)
          val volume = parts.firstOrNull() ?: return null
          val relative = parts.getOrNull(1).orEmpty()
          val root = if (volume.equals("primary", ignoreCase = true)) {
            Environment.getExternalStorageDirectory()
          } else {
            File("/storage/\$volume")
          }
          readableFile(File(root, relative).absolutePath)
        }
        "com.android.providers.downloads.documents" -> {
          if (documentId.startsWith("raw:")) readableFile(documentId.removePrefix("raw:")) else null
        }
        else -> null
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun pathFromDescriptor(descriptor: ParcelFileDescriptor): File? {
    return try {
      val target = Os.readlink("/proc/self/fd/\${descriptor.fd}")
      readableFile(target)
    } catch (_: Exception) {
      null
    }
  }

  @ReactMethod
  fun resolve(uriString: String, promise: Promise) {
    try {
      val uri = Uri.parse(uriString)
      if (uri.scheme == "file" || uri.scheme.isNullOrBlank()) {
        val file = readableFile(uri.path ?: uriString)
          ?: throw IllegalStateException("所选模型文件不存在或不可读取")
        val result = Arguments.createMap()
        result.putString("path", "file://\${file.absolutePath}")
        result.putDouble("size", file.length().toDouble())
        result.putBoolean("seekable", true)
        result.putBoolean("persisted", true)
        result.putBoolean("direct", true)
        promise.resolve(result)
        return
      }
      if (uri.scheme != "content") {
        throw IllegalArgumentException("不支持的模型 URI：\${uri.scheme}")
      }

      var persisted = false
      try {
        context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        persisted = true
      } catch (_: Exception) {
        // Expo DocumentPicker 不一定保留 FLAG_GRANT_PERSISTABLE_URI_PERMISSION。
      }

      val documentFile = pathFromDocumentUri(uri)
      val descriptorFile = context.contentResolver.openFileDescriptor(uri, "r")?.use { descriptor ->
        pathFromDescriptor(descriptor)
      }
      val file = documentFile ?: descriptorFile
      if (file == null) {
        throw IllegalStateException(
          "该文件来源只提供 content:// 代理流，llama.rn 无法把它作为普通 GGUF 路径进行 mmap。请使用“复制到应用”导入；本机内部存储或 SD 卡中的真实文件才能直接使用原文件。"
        )
      }

      val result = Arguments.createMap()
      result.putString("path", "file://\${file.absolutePath}")
      result.putDouble("size", file.length().toDouble())
      result.putBoolean("seekable", true)
      result.putBoolean("persisted", persisted)
      result.putBoolean("direct", true)
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("EXTERNAL_MODEL_DIRECT_UNAVAILABLE", error.message, error)
    }
  }

  @ReactMethod
  fun open(uriString: String, promise: Promise) = resolve(uriString, promise)

  @ReactMethod
  fun close(@Suppress("UNUSED_PARAMETER") uriString: String, promise: Promise) {
    promise.resolve(null)
  }

  @ReactMethod
  fun closeAll(promise: Promise) {
    promise.resolve(null)
  }
}
`;

const memoryModuleSource = `package ${packageName}

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

class RuntimeMemoryModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "RuntimeMemory"

  private fun bytesToMb(value: Long): Double = value.toDouble() / 1024.0 / 1024.0
  private fun kbToMb(value: Long): Double = value.toDouble() / 1024.0

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
    else -> "REASON_\$reason"
  }

  @ReactMethod
  fun getPreviousExit(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      promise.resolve(null)
      return
    }
    try {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val exit = manager.getHistoricalProcessExitReasons(context.packageName, 0, 5).firstOrNull()
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
}
`;

const packageSource = `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class OfflineAiNativePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      ExternalModelFileModule(reactContext),
      RuntimeMemoryModule(reactContext)
    )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;

fs.writeFileSync(externalModulePath, externalModuleSource, 'utf8');
fs.writeFileSync(memoryModulePath, memoryModuleSource, 'utf8');
fs.writeFileSync(packagePath, packageSource, 'utf8');

const verifiedMain = fs.readFileSync(mainApplicationPath, 'utf8');
if (!verifiedMain.includes('add(OfflineAiNativePackage())')) {
  throw new Error('[native-bridge] package registration validation failed');
}
console.log(`[native-bridge] injected external model resolver and memory diagnostics into ${packageName}`);
