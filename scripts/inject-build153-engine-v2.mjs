import fs from 'node:fs';
import path from 'node:path';

function walk(dir, target) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['build', '.cxx', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = walk(full, target);
      if (found) return found;
    } else if (entry.name === target) return full;
  }
  return null;
}

function replaceRequired(text, from, to, label) {
  if (!text.includes(from)) {
    if (text.includes(to)) return text;
    throw new Error(`[build153-native] missing ${label}`);
  }
  return text.replace(from, to);
}

const llamaRoot = 'node_modules/llama.rn';
const loaderPath = path.join(llamaRoot, 'cpp/llama-model-loader.cpp');
const mmapPath = path.join(llamaRoot, 'cpp/llama-mmap.cpp');
const androidCmakePath = path.join(llamaRoot, 'android/src/main/CMakeLists.txt');
const coreCmakePath = path.join(llamaRoot, 'android/src/main/rnllama/CMakeLists.txt');
for (const file of [loaderPath, mmapPath, androidCmakePath, coreCmakePath]) {
  if (!fs.existsSync(file)) throw new Error(`[build153-native] missing llama.rn source: ${file}`);
}

let loader = fs.readFileSync(loaderPath, 'utf8');
loader = replaceRequired(
  loader,
  'std::unique_ptr<llama_mmap> mapping = std::make_unique<llama_mmap>(file.get(), prefetch ? -1 : 0, is_numa);',
  'std::unique_ptr<llama_mmap> mapping = std::make_unique<llama_mmap>(file.get(), 0, is_numa); // Build153 Android demand paging',
  'llama-model-loader prefetch call'
);
fs.writeFileSync(loaderPath, loader, 'utf8');

let mmap = fs.readFileSync(mmapPath, 'utf8');
mmap = mmap.replaceAll('POSIX_FADV_SEQUENTIAL', 'POSIX_FADV_RANDOM');
mmap = replaceRequired(
  mmap,
  '        if (numa) { prefetch = 0; }\n#ifdef __linux__',
  `        if (numa) { prefetch = 0; }
#if defined(__ANDROID__)
        // Build153: Android MoE demand paging. Never use MAP_POPULATE or
        // MADV_WILLNEED for the complete GGUF mapping.
        prefetch = 0;
#endif
#ifdef __linux__`,
  'Android mmap prefetch guard'
);
fs.writeFileSync(mmapPath, mmap, 'utf8');

let androidCmake = fs.readFileSync(androidCmakePath, 'utf8');
const androidTargetsStart = androidCmake.indexOf('# Default target (no specific CPU features)');
if (androidTargetsStart < 0) throw new Error('[build153-native] Android JNI target block not found');
androidCmake = androidCmake.slice(0, androidTargetsStart) + `# Build153: generic fallback plus Snapdragon 8 Gen 3 dotprod+i8mm.
build_rnllama_jni("rnllama_jni" "rnllama" "generic" "")
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_jni("rnllama_jni_v8_2_dotprod_i8mm" "rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()
`;
fs.writeFileSync(androidCmakePath, androidCmake, 'utf8');

let coreCmake = fs.readFileSync(coreCmakePath, 'utf8');
const coreTargetsStart = coreCmake.indexOf('# Default target (no specific CPU features)');
if (coreTargetsStart < 0) throw new Error('[build153-native] core target block not found');
coreCmake = coreCmake.slice(0, coreTargetsStart) + `# Build153: generic fallback plus Snapdragon 8 Gen 3 dotprod+i8mm.
build_rnllama_library("rnllama" "generic" "")
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_library("rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()
`;
fs.writeFileSync(coreCmakePath, coreCmake, 'utf8');

const gradleProperties = 'android/gradle.properties';
let props = fs.readFileSync(gradleProperties, 'utf8');
for (const line of ['rnllamaBuildFromSource=true', 'reactNativeArchitectures=arm64-v8a']) {
  const key = line.split('=')[0];
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  props = pattern.test(props) ? props.replace(pattern, line) : `${props.trimEnd()}\n${line}\n`;
}
fs.writeFileSync(gradleProperties, props, 'utf8');

const javaRoot = 'android/app/src/main/java';
const servicePath = walk(javaRoot, 'InferenceProcessService.kt');
const modulePath = walk(javaRoot, 'InferenceProcessModule.kt');
if (!servicePath || !modulePath) throw new Error('[build153-native] inference process Kotlin files not found');

let service = fs.readFileSync(servicePath, 'utf8');
service = replaceRequired(
  service,
  'import android.content.Intent\n',
  `import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
`,
  'foreground service imports'
);
service = replaceRequired(
  service,
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
      manager.createNotificationChannel(
        NotificationChannel(channelId, "离线 AI 推理", NotificationManager.IMPORTANCE_LOW).apply {
          description = "保持本地模型推理进程运行"
          setShowBadge(false)
        }
      )
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
      @Suppress("DEPRECATION") Notification.Builder(this)
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
  }`,
  'foreground promotion function'
);
service = replaceRequired(
  service,
  `  override fun onDestroy() {
    workerReady = false`,
  `  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    workerReady = false`,
  'foreground teardown'
);
fs.writeFileSync(servicePath, service, 'utf8');

let module = fs.readFileSync(modulePath, 'utf8');
if (!module.includes('import android.os.Build')) {
  module = module.replace('import android.os.Handler\n', 'import android.os.Build\nimport android.os.Handler\n');
}
module = replaceRequired(
  module,
  '      context.startService(intent)',
  `      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }`,
  'startForegroundService call'
);
module = replaceRequired(
  module,
  '      if (!context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {',
  `      val bindFlags = Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT or Context.BIND_ABOVE_CLIENT
      if (!context.bindService(intent, connection, bindFlags)) {`,
  'important service binding'
);
fs.writeFileSync(modulePath, module, 'utf8');

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let manifest = fs.readFileSync(manifestPath, 'utf8');
const permissions = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.POST_NOTIFICATIONS',
];
for (const permission of permissions) {
  if (!manifest.includes(permission)) {
    manifest = manifest.replace('<application', `  <uses-permission android:name="${permission}" />\n  <application`);
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
fs.writeFileSync(manifestPath, manifest, 'utf8');

for (const [file, markers] of [
  [loaderPath, ['Build153 Android demand paging', 'file.get(), 0, is_numa']],
  [mmapPath, ['POSIX_FADV_RANDOM', 'Never use MAP_POPULATE']],
  [androidCmakePath, ['rnllama_jni_v8_2_dotprod_i8mm']],
  [coreCmakePath, ['rnllama_v8_2_dotprod_i8mm']],
  [gradleProperties, ['rnllamaBuildFromSource=true', 'reactNativeArchitectures=arm64-v8a']],
  [servicePath, ['promoteToForeground', 'FOREGROUND_SERVICE_TYPE_SPECIAL_USE']],
  [modulePath, ['startForegroundService', 'BIND_ABOVE_CLIENT', 'import android.os.Build']],
  [manifestPath, ['foregroundServiceType="specialUse"', 'PROPERTY_SPECIAL_USE_FGS_SUBTYPE']],
]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of markers) {
    if (!text.includes(marker)) throw new Error(`[build153-native] invariant missing in ${file}: ${marker}`);
  }
}

console.log('[build153-native] source-built demand-paging llama.rn and foreground inference service prepared');
