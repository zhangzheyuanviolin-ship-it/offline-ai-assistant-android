import fs from 'node:fs';
import path from 'node:path';

function walk(dir, predicate) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'build' || entry.name === '.cxx' || entry.name === '.git') continue;
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
if (!mainApplicationPath) throw new Error('[build118-native] MainApplication.kt not found');
const packageName = fs.readFileSync(mainApplicationPath, 'utf8').match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[build118-native] package name not found');

const runtimePath = walk(javaRoot, (_full, name) => name === 'RuntimeMemoryModule.kt');
if (!runtimePath) throw new Error('[build118-native] RuntimeMemoryModule.kt not found');
let runtime = fs.readFileSync(runtimePath, 'utf8');

const previousExitPattern = /  @ReactMethod\n  fun getPreviousExit\(promise: Promise\) \{[\s\S]*?\n  \}\n\n  @ReactMethod\n  fun getLatestInferenceDiagnostic/;
if (!previousExitPattern.test(runtime)) {
  throw new Error('[build118-native] getPreviousExit function not found');
}
runtime = runtime.replace(
  previousExitPattern,
  `  @ReactMethod
  fun getPreviousExit(promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      promise.resolve(null)
      return
    }
    try {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val exits = manager.getHistoricalProcessExitReasons(context.packageName, 0, 20)
      val inferenceExit = exits.firstOrNull { info ->
        info.processName == context.packageName + ":inference" || info.processName.endsWith(":inference")
      }
      val exit = inferenceExit ?: exits.firstOrNull()
      if (exit == null) {
        promise.resolve(null)
        return
      }
      val result = Arguments.createMap()
      result.putString("processName", exit.processName)
      result.putBoolean("isInferenceProcess", inferenceExit != null && exit === inferenceExit)
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
  fun getLatestInferenceDiagnostic`
);

const clearMarker = `  @ReactMethod
  fun clearInferenceDiagnosticLog(promise: Promise) {`;
if (!runtime.includes(clearMarker)) {
  throw new Error('[build118-native] clearInferenceDiagnosticLog marker not found');
}
runtime = runtime.replace(
  clearMarker,
  `  @ReactMethod
  fun getInferenceDiagnosticLog(promise: Promise) {
    try {
      val file = diagnosticFile()
      promise.resolve(if (file.exists() && file.length() > 0L) file.readText() else "")
    } catch (error: Exception) {
      promise.reject("INFERENCE_DIAGNOSTIC_LOG_READ_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun clearInferenceDiagnosticLog(promise: Promise) {`
);
fs.writeFileSync(runtimePath, runtime, 'utf8');

const workerPath = walk(javaRoot, (_full, name) => name === 'InferenceWorkerBridgeModule.kt');
if (!workerPath) throw new Error('[build118-native] InferenceWorkerBridgeModule.kt not found');
let worker = fs.readFileSync(workerPath, 'utf8');
worker = worker.replace(
  'private external fun nativeDropFileCache(fd: Int): Int',
  'private external fun nativeDropFileCache(fd: Int, modelPath: String): Int'
);
worker = worker.replace(
  'nativeDropFileCache(descriptor.fd)',
  'nativeDropFileCache(descriptor.fd, modelFile.absolutePath)'
);
worker = worker.replace(
  `      result.putBoolean("success", status == 0)
      result.putString(
        "message",
        if (status == 0) "POSIX_FADV_DONTNEED 已由 JNI 发送" else "posix_fadvise 返回错误码 $status"
      )`,
  `      result.putBoolean("success", status >= 0)
      result.putString(
        "message",
        when {
          status > 0 -> "已对 $status 个 GGUF mmap 区段执行 MADV_DONTNEED，并发送文件缓存回收提示"
          status == 0 -> "已发送 POSIX_FADV_DONTNEED；当前未匹配到可回收的 GGUF mmap 区段"
          else -> "原生页缓存回收返回错误码 $status"
        }
      )`
);
fs.writeFileSync(workerPath, worker, 'utf8');

const cppPath = walk('android/app', (_full, name) => name === 'hyperos_memory_jni.cpp');
if (!cppPath) throw new Error('[build118-native] hyperos_memory_jni.cpp not found');
const classPath = `${packageName.replaceAll('.', '/')}/InferenceWorkerBridgeModule`;
const cpp = `#include <jni.h>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <fstream>
#include <string>
#include <sys/mman.h>

static jint native_drop_file_cache(JNIEnv *env, jobject, jint fd, jstring model_path) {
  int fadvise_status = ENOSYS;
#if defined(POSIX_FADV_DONTNEED)
  fadvise_status = posix_fadvise(fd, 0, 0, POSIX_FADV_DONTNEED);
#endif

  const char *raw_path = model_path == nullptr ? nullptr : env->GetStringUTFChars(model_path, nullptr);
  const std::string path = raw_path == nullptr ? std::string() : std::string(raw_path);
  int advised_ranges = 0;
  int last_error = 0;

  if (!path.empty()) {
    std::ifstream maps("/proc/self/maps");
    std::string line;
    while (std::getline(maps, line)) {
      if (line.find(path) == std::string::npos) continue;
      unsigned long start = 0;
      unsigned long end = 0;
      if (std::sscanf(line.c_str(), "%lx-%lx", &start, &end) != 2 || end <= start) continue;
      const auto length = static_cast<size_t>(end - start);
      if (madvise(reinterpret_cast<void *>(start), length, MADV_DONTNEED) == 0) {
        advised_ranges += 1;
      } else {
        last_error = errno;
      }
    }
  }

  if (raw_path != nullptr) env->ReleaseStringUTFChars(model_path, raw_path);
  if (advised_ranges > 0) return static_cast<jint>(advised_ranges);
  if (fadvise_status == 0) return 0;
  if (last_error != 0) return static_cast<jint>(-last_error);
  return static_cast<jint>(-fadvise_status);
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *) {
  JNIEnv *env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK || env == nullptr) {
    return JNI_ERR;
  }
  jclass clazz = env->FindClass("${classPath}");
  if (clazz == nullptr) return JNI_ERR;
  JNINativeMethod methods[] = {
    {
      const_cast<char *>("nativeDropFileCache"),
      const_cast<char *>("(ILjava/lang/String;)I"),
      reinterpret_cast<void *>(native_drop_file_cache)
    }
  };
  if (env->RegisterNatives(clazz, methods, 1) != JNI_OK) return JNI_ERR;
  return JNI_VERSION_1_6;
}
`;
fs.writeFileSync(cppPath, cpp, 'utf8');

for (const [file, markers] of [
  [runtimePath, ['info.processName.endsWith(":inference")', 'isInferenceProcess', 'getInferenceDiagnosticLog']],
  [workerPath, ['nativeDropFileCache(fd: Int, modelPath: String)', 'status >= 0', 'MADV_DONTNEED']],
  [cppPath, ['madvise(', '/proc/self/maps', '(ILjava/lang/String;)I']],
]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of markers) {
    if (!text.includes(marker)) throw new Error(`[build118-native] invariant missing in ${file}: ${marker}`);
  }
}

console.log('[build118-native] inference-exit selection, full log access and mapped-page madvise injected');
