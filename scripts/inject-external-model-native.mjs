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
if (!mainApplicationPath) throw new Error('[external-model] MainApplication.kt not found after Expo prebuild');

let mainApplication = fs.readFileSync(mainApplicationPath, 'utf8');
const packageName = mainApplication.match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[external-model] Android package name not found');

if (!mainApplication.includes('ExternalModelFilePackage()')) {
  const applyPattern = /(PackageList\(this\)\.packages\.apply\s*\{)([\s\S]*?)(\n\s*\})/m;
  if (!applyPattern.test(mainApplication)) {
    throw new Error('[external-model] getPackages apply block not found');
  }
  mainApplication = mainApplication.replace(
    applyPattern,
    (_match, start, body, end) => `${start}${body}\n        add(ExternalModelFilePackage())${end}`
  );
  fs.writeFileSync(mainApplicationPath, mainApplication, 'utf8');
}

const packageDir = path.dirname(mainApplicationPath);
const modulePath = path.join(packageDir, 'ExternalModelFileModule.kt');
const packagePath = path.join(packageDir, 'ExternalModelFilePackage.kt');

const moduleSource = `package ${packageName}

import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.ConcurrentHashMap

class ExternalModelFileModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  companion object {
    private val handles = ConcurrentHashMap<String, ParcelFileDescriptor>()
  }

  override fun getName(): String = "ExternalModelFile"

  @ReactMethod
  fun open(uriString: String, promise: Promise) {
    try {
      val uri = Uri.parse(uriString)
      if (uri.scheme == "file") {
        val result = Arguments.createMap()
        result.putString("path", uriString)
        result.putDouble("size", -1.0)
        result.putBoolean("seekable", true)
        result.putBoolean("persisted", true)
        promise.resolve(result)
        return
      }
      if (uri.scheme != "content") {
        throw IllegalArgumentException("Unsupported model URI scheme: \${uri.scheme}")
      }

      var persisted = false
      try {
        context.contentResolver.takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION
        )
        persisted = true
      } catch (_: SecurityException) {
        // Some providers grant only session access. The descriptor remains valid while retained below.
      }

      val descriptor = context.contentResolver.openFileDescriptor(uri, "r")
        ?: throw IllegalStateException("Unable to open selected model file")
      val fd = descriptor.fd
      val fileDescriptor = descriptor.fileDescriptor
      val seekable = try {
        Os.lseek(fileDescriptor, 0L, OsConstants.SEEK_CUR)
        true
      } catch (_: Exception) {
        false
      }
      if (!seekable) {
        descriptor.close()
        throw IllegalStateException("The selected provider exposes a stream, not a seekable file. Use copy import instead.")
      }

      handles.remove(uriString)?.close()
      handles[uriString] = descriptor
      val size = if (descriptor.statSize >= 0L) descriptor.statSize else try {
        Os.fstat(fileDescriptor).st_size
      } catch (_: Exception) {
        -1L
      }

      val result = Arguments.createMap()
      result.putString("path", "/proc/self/fd/\$fd")
      result.putDouble("size", size.toDouble())
      result.putBoolean("seekable", true)
      result.putBoolean("persisted", persisted)
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("EXTERNAL_MODEL_OPEN_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun close(uriString: String, promise: Promise) {
    try {
      handles.remove(uriString)?.close()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("EXTERNAL_MODEL_CLOSE_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun closeAll(promise: Promise) {
    try {
      handles.values.forEach { descriptor ->
        try { descriptor.close() } catch (_: Exception) {}
      }
      handles.clear()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("EXTERNAL_MODEL_CLOSE_ALL_FAILED", error.message, error)
    }
  }
}
`;

const packageSource = `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class ExternalModelFilePackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(ExternalModelFileModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`;

fs.writeFileSync(modulePath, moduleSource, 'utf8');
fs.writeFileSync(packagePath, packageSource, 'utf8');

const verifiedMain = fs.readFileSync(mainApplicationPath, 'utf8');
if (!verifiedMain.includes('add(ExternalModelFilePackage())')) {
  throw new Error('[external-model] package registration validation failed');
}
console.log(`[external-model] injected native bridge into ${packageName}`);
