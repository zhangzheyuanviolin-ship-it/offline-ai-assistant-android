import fs from 'node:fs';
import path from 'node:path';

function walk(dir, target) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'build' || entry.name === '.cxx' || entry.name === '.git') continue;
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

function replaceRequired(file, from, to) {
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    if (before.includes(to)) return;
    throw new Error(`[build153-native] missing pattern in ${file}: ${from.slice(0, 120)}`);
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
}

const llamaRoot = 'node_modules/llama.rn';
const loaderPath = path.join(llamaRoot, 'cpp/llama-model-loader.cpp');
const mmapPath = path.join(llamaRoot, 'cpp/llama-mmap.cpp');
const androidCmakePath = path.join(llamaRoot, 'android/src/main/CMakeLists.txt');
const coreCmakePath = path.join(llamaRoot, 'android/src/main/rnllama/CMakeLists.txt');
for (const file of [loaderPath, mmapPath, androidCmakePath, coreCmakePath]) {
  if (!fs.existsSync(file)) throw new Error(`[build153-native] llama.rn source missing: ${file}`);
}

// Root cause fix: llama.cpp passes prefetch=-1 into llama_mmap, which enables
// MAP_POPULATE and MADV_WILLNEED for the entire GGUF. On a 14 GB MoE model that
// eagerly faults virtually every weight page into RSS before the first token.
replaceRequired(
  loaderPath,
  'std::unique_ptr<llama_mmap> mapping = std::make_unique<llama_mmap>(file.get(), prefetch ? -1 : 0, is_numa);',
  'std::unique_ptr<llama_mmap> mapping = std::make_unique<llama_mmap>(file.get(), 0, is_numa); // Build153 Android demand paging'
);

let mmapSource = fs.readFileSync(mmapPath, 'utf8');
mmapSource = mmapSource.replaceAll('POSIX_FADV_SEQUENTIAL', 'POSIX_FADV_RANDOM');
const mmapMarker = '        if (numa) { prefetch = 0; }\n#ifdef __linux__';
if (!mmapSource.includes(mmapMarker)) {
  throw new Error('[build153-native] llama mmap prefetch marker not found');
}
mmapSource = mmapSource.replace(
  mmapMarker,
  `        if (numa) { prefetch = 0; }
#if defined(__ANDROID__)
        // Build153: never populate the complete model on Android. MoE layers
        // fault in only when their routed experts are actually used.
        prefetch = 0;
#endif
#ifdef __linux__`
);
fs.writeFileSync(mmapPath, mmapSource, 'utf8');

// Source-building every CPU/GPU variant multiplies compile time and APK size.
// The target phone is Snapdragon 8 Gen 3 (arm64 + dotprod + i8mm), while the
// generic pair is retained as a safe loader fallback.
replaceRequired(
  androidCmakePath,
  `# Default target (no specific CPU features)
build_rnllama_jni("rnllama_jni" "rnllama" "generic" "")

if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    # ARM64 targets
    # Removing fp16 for now as it leads to issues with some models like deepseek r1 distills
    # https://github.com/mybigday/llama.rn/pull/110#issuecomment-2609918310
    build_rnllama_jni("rnllama_jni_v8" "rnllama_v8" "arm" "-march=armv8-a")
    build_rnllama_jni("rnllama_jni_v8_2" "rnllama_v8_2" "arm" "-march=armv8.2-a")
    build_rnllama_jni("rnllama_jni_v8_2_dotprod" "rnllama_v8_2_dotprod" "arm" "-march=armv8.2-a+dotprod")
    build_rnllama_jni("rnllama_jni_v8_2_i8mm" "rnllama_v8_2_i8mm" "arm" "-march=armv8.2-a+i8mm")
    build_rnllama_jni("rnllama_jni_v8_2_dotprod_i8mm" "rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
    build_rnllama_jni("rnllama_jni_v8_2_dotprod_i8mm_hexagon_opencl" "rnllama_v8_2_dotprod_i8mm_hexagon_opencl" "arm" "-march=armv8.2-a+dotprod+i8mm")

    # https://github.com/ggerganov/llama.cpp/blob/master/docs/android.md#cross-compile-using-android-ndk
    # llama.cpp will deal with the cpu features
    # build_rnllama_jni("rnllama_jni_v8_7" "rnllama_v8_7" "arm" "-march=armv8.7-a")
    # TODO: Add support runtime check for cpu features
    # At the moment runtime check is failing.

elseif (ANDROID_ABI AND ANDROID_ABI STREQUAL "x86_64")
    # x86_64 target
    build_rnllama_jni("rnllama_jni_x86_64" "rnllama_x86_64" "x86" "-march=x86-64;-mtune=generic;-msse4.2;-mpopcnt")
endif ()`,
  `# Build153: generic fallback plus the Snapdragon 8 Gen 3 optimized target.
build_rnllama_jni("rnllama_jni" "rnllama" "generic" "")
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_jni("rnllama_jni_v8_2_dotprod_i8mm" "rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()`
);

replaceRequired(
  coreCmakePath,
  `# Default target (no specific CPU features)
build_rnllama_library("rnllama" "generic" "")

if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    # ARM64 targets
    build_rnllama_library("rnllama_v8" "arm" "-march=armv8-a")
    build_rnllama_library("rnllama_v8_2" "arm" "-march=armv8.2-a")
    build_rnllama_library("rnllama_v8_2_dotprod" "arm" "-march=armv8.2-a+dotprod")
    build_rnllama_library("rnllama_v8_2_i8mm" "arm" "-march=armv8.2-a+i8mm")
    build_rnllama_library("rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
    build_rnllama_library("rnllama_v8_2_dotprod_i8mm_hexagon_opencl" "arm" "-march=armv8.2-a+dotprod+i8mm")

elseif (ANDROID_ABI AND ANDROID_ABI STREQUAL "x86_64")
    # x86_64 target
    build_rnllama_library("rnllama_x86_64" "x86" "-march=x86-64;-mtune=generic;-msse4.2;-mpopcnt")

endif ()`,
  `# Build153: generic fallback plus the Snapdragon 8 Gen 3 optimized target.
build_rnllama_library("rnllama" "generic" "")
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_library("rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()`
);

const gradleProperties = 'android/gradle.properties';
let props = fs.readFileSync(gradleProperties, 'utf8');
for (const line of ['rnllamaBuildFromSource=true', 'reactNativeArchitectures=arm64-v8a']) {
  const key = line.split('=')[0];
  const regex = new RegExp(`^${key}=.*$`, 'm');
  props = regex.test(props) ? props.replace(regex, line) : `${props.trimEnd()}\n${line}\n`;
}
fs.writeFileSync(gradleProperties, props, 'utf8');

const javaRoot = 'android/app/src/main/java';
const servicePath = walk(javaRoot, 'InferenceProcessService.kt');
const modulePath = walk(javaRoot, 'InferenceProcessModule.kt');
if (!servicePath || !modulePath) throw new Error('[build153-native] inference service files not found');

let service = fs.readFileSync(servicePath, 'utf8');
service = service.replace(
  'import android.content.Intent\n',
  `import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
`
);
replaceRequired(
  servicePath,
  `  override fun onCreate() {
    super.onCreate()
    instance = this
  }`,
  `  override fun onCreate() {
    super.onCreate()
    instance = this
    promoteToForeground()
  }

  private fun promoteToForeground() {
    val channelId = "offline_ai_inference"
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        channelId,
        "离线 AI 推理",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "保持本地模型推理进程运行"
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
    }

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        153,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, channelId)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    val notification = builder
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentTitle("离线 AI 推理正在运行")
      .setContentText("30B MoE 模型使用按需分页引擎")
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .apply { if (pendingIntent != null) setContentIntent(pendingIntent) }
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(153, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(153, notification)
    }
  }`
);
service = fs.readFileSync(servicePath, 'utf8');
service = service.replace(
  `  override fun onDestroy() {
    workerReady = false;`,
  `  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    workerReady = false;`
);
if (!service.includes('promoteToForeground')) {
  throw new Error('[build153-native] foreground service insertion failed');
}
fs.writeFileSync(servicePath, service, 'utf8');

let module = fs.readFileSync(modulePath, 'utf8');
module = module.replace(
  '      context.startService(intent)',
  `      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }`
);
module = module.replace(
  '      if (!context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {',
  '      val bindFlags = Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT or Context.BIND_ABOVE_CLIENT\n      if (!context.bindService(intent, connection, bindFlags)) {'
);
if (!module.includes('Build.VERSION_CODES.O')) {
  module = module.replace('import android.os.Handler\n', 'import android.os.Build\nimport android.os.Handler\n');
}
if (!module.includes('startForegroundService') || !module.includes('BIND_ABOVE_CLIENT')) {
  throw new Error('[build153-native] service priority patch failed');
}
fs.writeFileSync(modulePath, module, 'utf8');

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let manifest = fs.readFileSync(manifestPath, 'utf8');
for (const permission of [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
]) {
  if (!manifest.includes(permission)) {
    manifest = manifest.replace(
      '<application',
      `  <uses-permission android:name="${permission}" />\n  <application`
    );
  }
}
manifest = manifest.replace(
  /<service android:name="\.InferenceProcessService"[^>]*\/>/,
  `<service
      android:name=".InferenceProcessService"
      android:process=":inference"
      android:exported="false"
      android:stopWithTask="false"
      android:foregroundServiceType="specialUse">
      <property
        android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"
        android:value="Long-running user-initiated on-device AI model inference" />
    </service>`
);
if (!manifest.includes('foregroundServiceType="specialUse"')) {
  throw new Error('[build153-native] manifest foreground service patch failed');
}
fs.writeFileSync(manifestPath, manifest, 'utf8');

for (const [file, markers] of [
  [loaderPath, ['Build153 Android demand paging', 'file.get(), 0, is_numa']],
  [mmapPath, ['POSIX_FADV_RANDOM', 'Build153: never populate the complete model']],
  [gradleProperties, ['rnllamaBuildFromSource=true', 'reactNativeArchitectures=arm64-v8a']],
  [servicePath, ['promoteToForeground', 'FOREGROUND_SERVICE_TYPE_SPECIAL_USE']],
  [modulePath, ['startForegroundService', 'BIND_ABOVE_CLIENT']],
  [manifestPath, ['FOREGROUND_SERVICE_SPECIAL_USE', 'PROPERTY_SPECIAL_USE_FGS_SUBTYPE']],
]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of markers) {
    if (!text.includes(marker)) throw new Error(`[build153-native] invariant missing in ${file}: ${marker}`);
  }
}

console.log('[build153-native] custom llama.rn demand paging and foreground inference service injected');
