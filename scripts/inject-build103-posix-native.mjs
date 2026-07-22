import fs from 'node:fs';
import path from 'node:path';

function walk(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'build' || entry.name === '.cxx') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = walk(full, predicate);
      if (found) return found;
    } else if (predicate(full, entry.name)) {
      return full;
    }
  }
  return null;
}

const javaRoot = 'android/app/src/main/java';
const mainApplicationPath = walk(javaRoot, (_full, name) => name === 'MainApplication.kt');
if (!mainApplicationPath) throw new Error('[build103-posix] MainApplication.kt not found');
const packageName = fs.readFileSync(mainApplicationPath, 'utf8').match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[build103-posix] package name not found');

const workerPath = walk(javaRoot, (_full, name) => name === 'InferenceWorkerBridgeModule.kt');
if (!workerPath) throw new Error('[build103-posix] InferenceWorkerBridgeModule.kt not found');
let worker = fs.readFileSync(workerPath, 'utf8');
worker = worker
  .replace('import android.system.Os\n', '')
  .replace('import android.system.OsConstants\n', '');

if (!worker.includes('System.loadLibrary("hyperosmemory")')) {
  worker = worker.replace(
    '  companion object {\n',
    '  companion object {\n    init { System.loadLibrary("hyperosmemory") }\n'
  );
}

if (!worker.includes('private external fun nativeDropFileCache')) {
  worker = worker.replace(
    '  private val diagnosticLock = Any()\n',
    '  private val diagnosticLock = Any()\n  private external fun nativeDropFileCache(fd: Int): Int\n'
  );
}

const dropFunction = /  @ReactMethod\n  fun dropFileCache\(modelPath: String, promise: Promise\) \{[\s\S]*?\n  \}\n\n  override fun invalidate\(\)/;
if (!dropFunction.test(worker)) {
  throw new Error('[build103-posix] old dropFileCache function not found');
}
worker = worker.replace(
  dropFunction,
  `  @ReactMethod
  fun dropFileCache(modelPath: String, promise: Promise) {
    try {
      val normalized = modelPath.removePrefix("file://").removeSuffix(" (deleted)")
      val modelFile = File(normalized).canonicalFile
      if (!modelFile.exists() || !modelFile.isFile || !modelFile.canRead()) {
        throw IllegalStateException("GGUF 文件不存在或不可读取")
      }
      val descriptor: ParcelFileDescriptor = ParcelFileDescriptor.open(
        modelFile,
        ParcelFileDescriptor.MODE_READ_ONLY
      )
      val status = try {
        nativeDropFileCache(descriptor.fd)
      } finally {
        descriptor.close()
      }
      val result = Arguments.createMap()
      result.putBoolean("success", status == 0)
      result.putString(
        "message",
        if (status == 0) "POSIX_FADV_DONTNEED 已由 JNI 发送" else "posix_fadvise 返回错误码 $status"
      )
      promise.resolve(result)
    } catch (error: Exception) {
      val result = Arguments.createMap()
      result.putBoolean("success", false)
      result.putString("message", error.message ?: error.javaClass.simpleName)
      promise.resolve(result)
    }
  }

  override fun invalidate()`
);
fs.writeFileSync(workerPath, worker, 'utf8');

const cmakePath = walk('android/app', (full, name) => {
  if (name !== 'CMakeLists.txt') return false;
  try {
    return fs.readFileSync(full, 'utf8').includes('ReactNative-application.cmake');
  } catch {
    return false;
  }
});
if (!cmakePath) throw new Error('[build103-posix] React Native application CMakeLists.txt not found');
const cppPath = path.join(path.dirname(cmakePath), 'hyperos_memory_jni.cpp');
const classPath = `${packageName.replaceAll('.', '/')}/InferenceWorkerBridgeModule`;
const cpp = `#define _GNU_SOURCE
#include <jni.h>
#include <cerrno>
#include <fcntl.h>

static jint native_drop_file_cache(JNIEnv *, jobject, jint fd) {
#if defined(POSIX_FADV_DONTNEED)
  return static_cast<jint>(posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED));
#else
  return static_cast<jint>(ENOSYS);
#endif
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  JNIEnv *env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK || env == nullptr) {
    return JNI_ERR;
  }
  jclass clazz = env->FindClass("${classPath}");
  if (clazz == nullptr) {
    return JNI_ERR;
  }
  JNINativeMethod methods[] = {
    {
      const_cast<char *>("nativeDropFileCache"),
      const_cast<char *>("(I)I"),
      reinterpret_cast<void *>(native_drop_file_cache)
    }
  };
  if (env->RegisterNatives(clazz, methods, 1) != JNI_OK) {
    return JNI_ERR;
  }
  return JNI_VERSION_1_6;
}
`;
fs.writeFileSync(cppPath, cpp, 'utf8');

let cmake = fs.readFileSync(cmakePath, 'utf8');
if (!cmake.includes('add_library(hyperosmemory')) {
  cmake += `\n# Build103: tiny JNI bridge for POSIX_FADV_DONTNEED.\nadd_library(hyperosmemory SHARED hyperos_memory_jni.cpp)\n`;
}
fs.writeFileSync(cmakePath, cmake, 'utf8');

const finalWorker = fs.readFileSync(workerPath, 'utf8');
const finalCmake = fs.readFileSync(cmakePath, 'utf8');
for (const required of [
  'System.loadLibrary("hyperosmemory")',
  'private external fun nativeDropFileCache(fd: Int): Int',
  'nativeDropFileCache(descriptor.fd)',
]) {
  if (!finalWorker.includes(required)) throw new Error(`[build103-posix] worker invariant missing: ${required}`);
}
if (!finalCmake.includes('add_library(hyperosmemory SHARED hyperos_memory_jni.cpp)')) {
  throw new Error('[build103-posix] CMake target invariant missing');
}
if (!fs.readFileSync(cppPath, 'utf8').includes('POSIX_FADV_DONTNEED')) {
  throw new Error('[build103-posix] native fadvise invariant missing');
}

console.log(`[build103-posix] JNI page-cache bridge injected at ${cppPath}`);
