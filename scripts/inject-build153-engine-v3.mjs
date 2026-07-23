import fs from 'node:fs';
import path from 'node:path';

// First apply the complete demand-paging and foreground-service transformation.
await import('./inject-build153-engine-v2.mjs');

const llamaRoot = 'node_modules/llama.rn';
const androidCmakePath = path.join(llamaRoot, 'android/src/main/CMakeLists.txt');
const coreCmakePath = path.join(llamaRoot, 'android/src/main/rnllama/CMakeLists.txt');
const javaPath = path.join(llamaRoot, 'android/src/main/java/com/rnllama/RNLlama.java');

let androidCmake = fs.readFileSync(androidCmakePath, 'utf8');
androidCmake = androidCmake.replace(
  `# Build153: generic fallback plus Snapdragon 8 Gen 3 dotprod+i8mm.
build_rnllama_jni("rnllama_jni" "rnllama" "generic" "")
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_jni("rnllama_jni_v8_2_dotprod_i8mm" "rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()`,
  `# Build153: Redmi K70 Pro / Snapdragon 8 Gen 3 production target.
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_jni("rnllama_jni_v8_2_dotprod_i8mm" "rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()`
);
if (androidCmake.includes('build_rnllama_jni("rnllama_jni"')) {
  throw new Error('[build153-native-v3] generic JNI target still enabled');
}
fs.writeFileSync(androidCmakePath, androidCmake, 'utf8');

let coreCmake = fs.readFileSync(coreCmakePath, 'utf8');
coreCmake = coreCmake.replace(
  `# Build153: generic fallback plus Snapdragon 8 Gen 3 dotprod+i8mm.
build_rnllama_library("rnllama" "generic" "")
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_library("rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()`,
  `# Build153: Redmi K70 Pro / Snapdragon 8 Gen 3 production target.
if (ANDROID_ABI AND ANDROID_ABI STREQUAL "arm64-v8a")
    build_rnllama_library("rnllama_v8_2_dotprod_i8mm" "arm" "-march=armv8.2-a+dotprod+i8mm")
endif ()`
);
if (coreCmake.includes('build_rnllama_library("rnllama"')) {
  throw new Error('[build153-native-v3] generic core target still enabled');
}
fs.writeFileSync(coreCmakePath, coreCmake, 'utf8');

let java = fs.readFileSync(javaPath, 'utf8');
java = java.replace(
  '      System.loadLibrary("rnllama");',
  `      // Build153 packages the exact core matching the selected optimized JNI.
      // The JNI dependency normally loads it automatically; this explicit load
      // keeps initialization deterministic without requiring the generic core.
      System.loadLibrary(loadedLib.replace("rnllama_jni", "rnllama"));`
);
if (!java.includes('loadedLib.replace("rnllama_jni", "rnllama")')) {
  throw new Error('[build153-native-v3] optimized core loader patch failed');
}
fs.writeFileSync(javaPath, java, 'utf8');

// v2 inserts the foreground-service code before deciding whether the Build
// import is necessary. Ensure the generated Kotlin module has the import.
const javaRoot = 'android/app/src/main/java';
function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}
const modulePath = findFile(javaRoot, 'InferenceProcessModule.kt');
if (!modulePath) throw new Error('[build153-native-v3] InferenceProcessModule.kt missing');
let module = fs.readFileSync(modulePath, 'utf8');
if (!module.includes('import android.os.Build\n')) {
  module = module.replace('import android.os.Handler\n', 'import android.os.Build\nimport android.os.Handler\n');
}
if (!module.includes('import android.os.Build\n')) {
  throw new Error('[build153-native-v3] android.os.Build import missing');
}
fs.writeFileSync(modulePath, module, 'utf8');

for (const [file, markers] of [
  [androidCmakePath, ['Snapdragon 8 Gen 3 production target', 'rnllama_jni_v8_2_dotprod_i8mm']],
  [coreCmakePath, ['Snapdragon 8 Gen 3 production target', 'rnllama_v8_2_dotprod_i8mm']],
  [javaPath, ['loadedLib.replace("rnllama_jni", "rnllama")']],
  [modulePath, ['import android.os.Build', 'startForegroundService']],
]) {
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of markers) {
    if (!text.includes(marker)) throw new Error(`[build153-native-v3] invariant missing in ${file}: ${marker}`);
  }
}

console.log('[build153-native-v3] Snapdragon 8 Gen 3 custom llama.rn target finalized');
