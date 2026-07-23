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
if (!mainApplicationPath) throw new Error('[inference-process] MainApplication.kt not found');
const packageDir = path.dirname(mainApplicationPath);
const packageName = fs.readFileSync(mainApplicationPath, 'utf8').match(/^package\s+([\w.]+)/m)?.[1];
if (!packageName) throw new Error('[inference-process] package name not found');

const serviceSource = `package ${packageName}

import android.app.Service
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.Process

class InferenceProcessService : Service() {
  companion object {
    const val MSG_PING = 1
    const val MSG_PING_RESULT = 2
  }

  private val handler = object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(message: Message) {
      if (message.what != MSG_PING) {
        super.handleMessage(message)
        return
      }
      val reply = Message.obtain(null, MSG_PING_RESULT)
      reply.data = Bundle().apply {
        putInt("pid", Process.myPid())
        putString("processName", applicationInfo.processName ?: "${packageName}:inference")
      }
      message.replyTo?.send(reply)
    }
  }

  private val messenger = Messenger(handler)

  override fun onBind(intent: Intent?): IBinder = messenger.binder
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
}
`;

const moduleSource = `package ${packageName}

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class InferenceProcessModule(
  private val context: ReactApplicationContext
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "InferenceProcess"

  private var remote: Messenger? = null
  private var bound = false
  private val pending = mutableListOf<Promise>()

  private val incoming = Messenger(object : Handler(Looper.getMainLooper()) {
    override fun handleMessage(message: Message) {
      if (message.what != InferenceProcessService.MSG_PING_RESULT) {
        super.handleMessage(message)
        return
      }
      val result = Arguments.createMap().apply {
        putBoolean("running", true)
        putInt("uiPid", android.os.Process.myPid())
        putInt("inferencePid", message.data.getInt("pid"))
        putString("processName", message.data.getString("processName"))
      }
      pending.toList().forEach { it.resolve(result) }
      pending.clear()
    }
  })

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
      remote = Messenger(binder)
      bound = true
      ping()
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      remote = null
      bound = false
    }
  }

  private fun ping() {
    val message = Message.obtain(null, InferenceProcessService.MSG_PING)
    message.replyTo = incoming
    remote?.send(message)
  }

  @ReactMethod
  fun start(promise: Promise) {
    try {
      pending.add(promise)
      val intent = Intent(context, InferenceProcessService::class.java)
      context.startService(intent)
      if (bound) {
        ping()
      } else if (!context.bindService(intent, connection, Context.BIND_AUTO_CREATE)) {
        pending.remove(promise)
        promise.reject("INFERENCE_PROCESS_BIND_FAILED", "Unable to bind inference process")
      }
    } catch (error: Exception) {
      pending.remove(promise)
      promise.reject("INFERENCE_PROCESS_START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      if (bound) context.unbindService(connection)
      bound = false
      remote = null
      context.stopService(Intent(context, InferenceProcessService::class.java))
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("INFERENCE_PROCESS_STOP_FAILED", error.message, error)
    }
  }
}
`;

fs.writeFileSync(path.join(packageDir, 'InferenceProcessService.kt'), serviceSource, 'utf8');
fs.writeFileSync(path.join(packageDir, 'InferenceProcessModule.kt'), moduleSource, 'utf8');

const packagePath = path.join(packageDir, 'OfflineAiNativePackage.kt');
let nativePackage = fs.readFileSync(packagePath, 'utf8');
if (!nativePackage.includes('InferenceProcessModule(reactContext)')) {
  nativePackage = nativePackage.replace(
    'RuntimeMemoryModule(reactContext)',
    'RuntimeMemoryModule(reactContext),\n      InferenceProcessModule(reactContext)'
  );
  fs.writeFileSync(packagePath, nativePackage, 'utf8');
}

const manifestPath = 'android/app/src/main/AndroidManifest.xml';
let manifest = fs.readFileSync(manifestPath, 'utf8');
if (!manifest.includes('android:name=".InferenceProcessService"')) {
  manifest = manifest.replace(
    '</application>',
    '    <service android:name=".InferenceProcessService" android:process=":inference" android:exported="false" />\n  </application>'
  );
  fs.writeFileSync(manifestPath, manifest, 'utf8');
}

if (!fs.readFileSync(manifestPath, 'utf8').includes('android:process=":inference"')) {
  throw new Error('[inference-process] manifest validation failed');
}
console.log('[inference-process] secondary process and Messenger IPC injected');
