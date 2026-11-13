package app.raven.mobilenative

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Size
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@InvokeArg
class RequestArgs { lateinit var kind: String; var requestId: Long = 0 }

@InvokeArg
class FocusArgs { var acquire: Boolean = false }

@InvokeArg
class CameraStartArgs {
    lateinit var cameraId: String
    var width: Int = 640
    var height: Int = 480
    var callbackHandle: Long = 0
}

@InvokeArg
class CameraStopArgs { var callbackHandle: Long = 0 }

@InvokeArg
class ListenArgs { lateinit var events: Channel }

@TauriPlugin(permissions = [
    Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]),
    Permission(alias = "camera", strings = [Manifest.permission.CAMERA]),
])
class RavenMobileNativePlugin(private val activity: Activity) : Plugin(activity) {
    private var listener: Channel? = null
    /** Pending OS prompts: Tauri callback id to the caller's request id and permission. */
    private val permissionRequests = ConcurrentHashMap<Long, Pair<Long, String>>()
    private data class CameraCapture(val provider: ProcessCameraProvider, val analysis: ImageAnalysis, val executor: ExecutorService)
    /** Running cameras by the Rust callback handle that receives their frames. */
    private val cameras = ConcurrentHashMap<Long, CameraCapture>()
    private val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var focused = false
    private var routeCallback: AudioDeviceCallback? = null

    init {
        // Initialize before frontend device queries; retain only the stable Application context.
        livekit.org.webrtc.PeerConnectionFactory.initialize(
            livekit.org.webrtc.PeerConnectionFactory.InitializationOptions
                .builder(activity.applicationContext).createInitializationOptions()
        )
        if (!nativeInitialize(activity.applicationContext)) {
            throw IllegalStateException("LiveKit WebRTC Android initialization failed")
        }
    }

    override fun load(webView: android.webkit.WebView) {
        val content = activity.findViewById<android.view.View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
            val types = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            val insets = windowInsets.getInsets(types)
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            // The native container owns system-bar spacing; keep IME updates flowing to WebView.
            WindowInsetsCompat.Builder(windowInsets).setInsets(types, Insets.NONE).build()
        }
        ViewCompat.requestApplyInsets(content)
        routeCallback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = emitFocus()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = emitFocus()
        }
        audioManager.registerAudioDeviceCallback(routeCallback, null)
    }

    @Command
    fun permissionStatus(invoke: Invoke) {
        val result = JSObject()
        result.put("microphone", permissionState(Manifest.permission.RECORD_AUDIO))
        result.put("camera", permissionState(Manifest.permission.CAMERA))
        invoke.resolve(result)
    }

    @Command
    fun requestPermission(invoke: Invoke) {
        val args = invoke.parseArgs(RequestArgs::class.java)
        val permission = permissionFor(args.kind) ?: run { invoke.reject("Unknown permission kind"); return }
        if (granted(permission)) {
            val result = JSObject(); result.put("requestId", args.requestId); result.put("status", "granted")
            invoke.resolve(result); return
        }
        permissionRequests[invoke.callback] = args.requestId to permission
        requestPermissionForAlias(args.kind, invoke, "permissionResult")
    }

    @PermissionCallback
    fun permissionResult(invoke: Invoke) {
        val (requestId, permission) = permissionRequests.remove(invoke.callback) ?: run { invoke.reject("Permission request expired"); return }
        if (!granted(permission)) {
            val preferences = activity.getSharedPreferences("raven-mobile-native", Context.MODE_PRIVATE)
            val key = "denials:$permission"
            preferences.edit().putInt(key, preferences.getInt(key, 0) + 1).apply()
        }
        val result = JSObject()
        result.put("requestId", requestId)
        result.put("status", permissionState(permission))
        invoke.resolve(result)
    }

    @Command
    fun listen(invoke: Invoke) {
        listener = invoke.parseArgs(ListenArgs::class.java).events
        invoke.resolve()
        emit("foregrounded")
    }

    @Command
    fun audioFocus(invoke: Invoke) {
        val acquire = invoke.parseArgs(FocusArgs::class.java).acquire
        if (acquire) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setOnAudioFocusChangeListener { change ->
                    focused = change == AudioManager.AUDIOFOCUS_GAIN
                    emitFocus()
                }.build()
            focusRequest = request
            focused = audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
            if (focused) audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        } else {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            focusRequest = null
            audioManager.mode = AudioManager.MODE_NORMAL
            focused = false
        }
        emitFocus()
        val result = JSObject(); result.put("focused", focused); result.put("route", routeName())
        invoke.resolve(result)
    }

    @Command
    fun openSettings(invoke: Invoke) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
        activity.startActivity(intent)
        invoke.resolve()
    }

    @Command
    fun listCameras(invoke: Invoke) {
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener({
            try {
                val result = future.get().availableCameraInfos.map { info ->
                    val frontFacing = info.lensFacing == CameraSelector.LENS_FACING_FRONT
                    val entry = JSObject()
                    entry.put("id", Camera2CameraInfo.from(info).cameraId)
                    entry.put("name", if (frontFacing) "Front camera" else "Back camera")
                    entry.put("frontFacing", frontFacing)
                    entry
                }
                invoke.resolveObject(result)
            } catch (error: Exception) { invoke.reject("Could not enumerate cameras", error) }
        }, ContextCompat.getMainExecutor(activity))
    }

    @Command
    fun startCamera(invoke: Invoke) {
        val args = invoke.parseArgs(CameraStartArgs::class.java)
        if (args.callbackHandle == 0L || args.width <= 0 || args.height <= 0) {
            invoke.reject("Invalid camera request"); return
        }
        if (!granted(Manifest.permission.CAMERA)) {
            invoke.reject("Camera permission is not granted"); return
        }
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener({
            var started: CameraCapture? = null
            try {
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(ResolutionSelector.Builder()
                        .setResolutionStrategy(ResolutionStrategy(Size(args.width, args.height), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    // CameraX rotates upright and converts from YUV, so Rust gets one plane.
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .setOutputImageRotationEnabled(true)
                    .build()
                val capture = CameraCapture(future.get(), analysis, Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "raven-camera-analyzer") })
                // Publish ownership before any analyzer callback can run. A failed start
                // is then drained by the same stop path before Rust releases its handle.
                started = capture
                cameras[args.callbackHandle] = capture
                analysis.setAnalyzer(capture.executor) { image -> analyze(image, args.callbackHandle) }
                val selector = CameraSelector.Builder().addCameraFilter { infos -> infos.filter { Camera2CameraInfo.from(it).cameraId == args.cameraId } }.build()
                capture.provider.bindToLifecycle(activity as LifecycleOwner, selector, analysis)
                invoke.resolve()
            } catch (error: Exception) {
                started?.let { release(it) }
                invoke.reject("Could not start camera", error)
            }
        }, ContextCompat.getMainExecutor(activity))
    }

    @Command
    fun stopCamera(invoke: Invoke) {
        val args = invoke.parseArgs(CameraStopArgs::class.java)
        val capture = cameras[args.callbackHandle]
        if (capture != null) {
            release(capture)
            // Rust frees the frame callback once this resolves, so no frame may still be running.
            try {
                if (!capture.executor.awaitTermination(2, TimeUnit.SECONDS)) {
                    invoke.reject("Camera frames are still stopping"); return
                }
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                invoke.reject("Camera stop was interrupted"); return
            }
            cameras.remove(args.callbackHandle, capture)
        }
        invoke.resolve()
    }

    private fun release(capture: CameraCapture) {
        capture.analysis.clearAnalyzer()
        capture.provider.unbind(capture.analysis)
        capture.executor.shutdown()
    }

    private fun analyze(image: ImageProxy, handle: Long) {
        try {
            val plane = image.planes.firstOrNull() ?: return
            val buffer = plane.buffer.duplicate()
            val rgba = ByteArray(buffer.remaining()).also { buffer.get(it) }
            nativeFrame(handle, image.width, image.height, rgba, plane.rowStride, image.imageInfo.timestamp)
        } finally { image.close() }
    }

    override fun onStop() {
        super.onStop()
        // Lifecycle-bound cameras otherwise restart automatically on Activity resume.
        // Raven requires a fresh user action after backgrounding.
        cameras.values.forEach { release(it) }
        emit("backgroundTerminal")
    }
    override fun onResume() { super.onResume(); emit("foregrounded") }
    override fun onDestroy(activity: androidx.appcompat.app.AppCompatActivity) {
        routeCallback?.let { audioManager.unregisterAudioDeviceCallback(it) }
        if (focused) { focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }; audioManager.mode = AudioManager.MODE_NORMAL }
        super.onDestroy(activity)
    }

    private fun permissionFor(kind: String): String? = when (kind) {
        "microphone" -> Manifest.permission.RECORD_AUDIO
        "camera" -> Manifest.permission.CAMERA
        else -> null
    }

    private fun granted(permission: String) =
        activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun permissionState(permission: String): String {
        if (granted(permission)) return "granted"
        val prefs = activity.getSharedPreferences("raven-mobile-native", Context.MODE_PRIVATE)
        val denials = prefs.getInt("denials:$permission", 0)
        val rationale = activity.shouldShowRequestPermissionRationale(permission)
        return if (denials == 0) "notRequested" else if (denials > 1 && !rationale) "requiresSettings" else "denied"
    }

    private fun emitFocus() {
        val state = JSObject(); state.put("type", "audioFocus"); state.put("focused", focused); state.put("route", routeName())
        listener?.sendObject(state)
    }

    private fun emit(type: String) { val event = JSObject(); event.put("type", type); listener?.sendObject(event) }

    private fun routeName(): String {
        if (Build.VERSION.SDK_INT >= 31) {
            val active = audioManager.communicationDevice
            if (active != null) return routeName(active.type)
        }
        val outputs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        return when {
            audioManager.isBluetoothScoOn -> "bluetooth"
            audioManager.isWiredHeadsetOn -> "wired"
            audioManager.isSpeakerphoneOn -> "speaker"
            outputs.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE } -> "earpiece"
            else -> "unknown"
        }
    }

    private fun routeName(type: Int): String = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "bluetooth"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        else -> "unknown"
    }

    private external fun nativeFrame(handle: Long, width: Int, height: Int, rgba: ByteArray, rowStride: Int, timestamp: Long)
    private external fun nativeInitialize(applicationContext: Context): Boolean
}
