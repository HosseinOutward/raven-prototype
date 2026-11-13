package app.raven.mobilenative

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

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
    private class CameraCapture(val provider: ProcessCameraProvider, val analysis: ImageAnalysis, val executor: ExecutorService) {
        /** Cleared on the main thread when released; queued analyzer tasks then skip their frame. */
        @Volatile var active = true
    }
    /** Running cameras by the Rust callback handle that receives their frames. */
    private val cameras = ConcurrentHashMap<Long, CameraCapture>()
    private val audioManager = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null
    private var focused = false

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
    }

    @Command
    fun listen(invoke: Invoke) {
        listener = invoke.parseArgs(ListenArgs::class.java).events
        invoke.resolve()
        emit("foregrounded")
    }

    @Command
    fun audioFocus(invoke: Invoke) {
        if (invoke.parseArgs(FocusArgs::class.java).acquire) acquireFocus() else releaseFocus()
        val result = JSObject(); result.put("focused", focused)
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
            // A start arriving just after onStop would otherwise bind and come back on resume.
            if (!(activity as LifecycleOwner).lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                invoke.reject("Raven is in the background"); return@addListener
            }
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
                analysis.setAnalyzer(capture.executor) { image -> analyze(image, capture, args.callbackHandle) }
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
        val capture = cameras.remove(invoke.parseArgs(CameraStopArgs::class.java).callbackHandle) ?: run { invoke.resolve(); return }
        release(capture)
        // The single-thread analyzer executor runs this marker after any frame already inside
        // nativeFrame, and active = false makes later queued analyzer tasks skip, so Rust may
        // free the frame callback once the invoke resolves. Waiting here would block the main thread.
        capture.executor.execute { invoke.resolve() }
        capture.executor.shutdown()
    }

    private fun release(capture: CameraCapture) {
        capture.active = false
        capture.analysis.clearAnalyzer()
        capture.provider.unbind(capture.analysis)
    }

    private fun analyze(image: ImageProxy, capture: CameraCapture, handle: Long) {
        try {
            if (!capture.active) return
            val plane = image.planes.firstOrNull() ?: return
            val buffer = plane.buffer
            val frame = if (buffer.isDirect) buffer.slice() else {
                ByteBuffer.allocateDirect(buffer.remaining()).apply { put(buffer.duplicate()); flip() }
            }
            nativeFrame(handle, image.width, image.height, frame, plane.rowStride, image.imageInfo.timestamp)
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
        releaseFocus()
        super.onDestroy(activity)
    }

    private fun granted(permission: String) =
        activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun acquireFocus() {
        releaseFocus()
        // The listener identifies its own request, which does not exist until built.
        lateinit var request: AudioFocusRequest
        request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener { change ->
                if (focusRequest !== request) return@setOnAudioFocusChangeListener
                focused = change == AudioManager.AUDIOFOCUS_GAIN
                emitFocus()
            }.build()
        focusRequest = request
        if (audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            focused = true
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        } else releaseFocus()
    }

    /** The only place focus is released; does nothing when no call holds it. */
    private fun releaseFocus() {
        val request = focusRequest ?: return
        audioManager.abandonAudioFocusRequest(request)
        focusRequest = null
        focused = false
        audioManager.mode = AudioManager.MODE_NORMAL
    }

    private fun emitFocus() {
        val state = JSObject(); state.put("type", "audioFocus"); state.put("focused", focused)
        listener?.sendObject(state)
    }

    private fun emit(type: String) { val event = JSObject(); event.put("type", type); listener?.sendObject(event) }

    private external fun nativeFrame(handle: Long, width: Int, height: Int, rgba: ByteBuffer, rowStride: Int, timestamp: Long)
    private external fun nativeInitialize(applicationContext: Context): Boolean
}
