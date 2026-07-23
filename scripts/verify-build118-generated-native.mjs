import fs from 'node:fs';
import path from 'node:path';

function walk(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.cxx' || entry.name === 'build') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, results);
    else if (predicate(full, entry.name)) results.push(full);
  }
  return results;
}

const javaRoot = 'android/app/src/main/java';
const workerFiles = walk(javaRoot, (_full, name) => name === 'InferenceWorkerBridgeModule.kt');
if (workerFiles.length !== 1) {
  throw new Error(`[build118-native-verify] expected one worker module, found ${workerFiles.length}`);
}

for (const file of workerFiles) {
  let text = fs.readFileSync(file, 'utf8');
  text = text.replace(
    'lines.filter { it.isNotBlank() }.takeLast(200).joinToString("\\n")',
    'lines.filter { it.isNotBlank() }.toList().takeLast(200).joinToString("\\n")'
  );
  fs.writeFileSync(file, text, 'utf8');
}

const checks = [
  [javaRoot, 'class ExternalModelFileModule'],
  [javaRoot, 'class RuntimeMemoryModule'],
  [javaRoot, 'class InferenceProcessService'],
  [javaRoot, 'class InferenceProcessModule'],
  [javaRoot, 'class InferenceWorkerBridgeModule'],
  [javaRoot, 'InferenceWorkerBridgeModule(reactContext)'],
  [javaRoot, 'HeadlessJsTaskService'],
  [javaRoot, 'add(OfflineAiNativePackage())'],
  [javaRoot, 'System.loadLibrary("hyperosmemory")'],
  [javaRoot, 'nativeDropFileCache(descriptor.fd, modelFile.absolutePath)'],
  [javaRoot, 'info.processName.endsWith(":inference")'],
  [javaRoot, 'getInferenceDiagnosticLog'],
  [javaRoot, 'Pss_File'],
  [javaRoot, 'toList().takeLast(200)'],
  ['android/app', 'add_library(hyperosmemory SHARED hyperos_memory_jni.cpp)'],
  ['android/app/src/main', 'madvise('],
  ['android/app/src/main', '/proc/self/maps'],
  ['android/app/src/main/AndroidManifest.xml', 'android:process=":inference"'],
];

function filesFor(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return walk(target, () => true);
}

for (const [target, marker] of checks) {
  const files = filesFor(target);
  const match = files.find((file) => {
    try {
      return fs.readFileSync(file, 'utf8').includes(marker);
    } catch {
      return false;
    }
  });
  if (!match) {
    throw new Error(`[build118-native-verify] missing marker under ${target}: ${marker}`);
  }
  console.log(`[build118-native-verify] ok ${marker} in ${match}`);
}

const cpp = walk('android/app', (_full, name) => name === 'hyperos_memory_jni.cpp');
if (cpp.length !== 1) {
  throw new Error(`[build118-native-verify] expected one hyperos_memory_jni.cpp, found ${cpp.length}`);
}

console.log('[build118-native-verify] generated Android project verified');
