//! Raven's MobileNative adapter for Android: permissions, Activity lifecycle,
//! communication audio focus and CameraX frames, implemented in Kotlin under `android/`.
//! The app depends on this crate only for Android, so it compiles to nothing elsewhere.
#![cfg(target_os = "android")]

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, Runtime,
};

pub mod camera;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    Microphone,
    Camera,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionStatus {
    NotRequested,
    Granted,
    Denied,
    RequiresSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MobileNativeEvent {
    Foregrounded,
    BackgroundTerminal,
    AudioFocus { focused: bool, route: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub microphone: PermissionStatus,
    pub camera: PermissionStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestResult {
    pub request_id: u64,
    pub status: PermissionStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestPermissionArgs {
    kind: PermissionKind,
    request_id: u64,
}
#[derive(Serialize)]
struct ListenArgs {
    events: tauri::ipc::Channel<MobileNativeEvent>,
}
#[derive(Serialize)]
struct AudioFocusArgs {
    acquire: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFocusSnapshot {
    pub focused: bool,
    pub route: String,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("raven-mobile-native")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("app.raven.mobilenative", "RavenMobileNativePlugin")?;
            app.manage(MobileNativeHandle(handle));
            Ok(())
        })
        .build()
}

pub struct MobileNativeHandle<R: Runtime>(tauri::plugin::PluginHandle<R>);

fn call<R: Runtime, A: Serialize, T: for<'de> Deserialize<'de>>(
    app: &AppHandle<R>,
    method: &str,
    args: A,
) -> Result<T, String> {
    app.state::<MobileNativeHandle<R>>()
        .0
        .run_mobile_plugin(method, args)
        .map_err(|e| e.to_string())
}

pub fn permission_status<R: Runtime>(app: &AppHandle<R>) -> Result<PermissionSnapshot, String> {
    call(app, "permissionStatus", ())
}

pub fn request_permission<R: Runtime>(
    app: &AppHandle<R>,
    kind: PermissionKind,
    request_id: u64,
) -> Result<PermissionRequestResult, String> {
    call(
        app,
        "requestPermission",
        RequestPermissionArgs { kind, request_id },
    )
}

pub fn listen<R: Runtime>(
    app: &AppHandle<R>,
    events: tauri::ipc::Channel<MobileNativeEvent>,
) -> Result<(), String> {
    call(app, "listen", ListenArgs { events })
}

pub fn audio_focus<R: Runtime>(
    app: &AppHandle<R>,
    acquire: bool,
) -> Result<AudioFocusSnapshot, String> {
    call(app, "audioFocus", AudioFocusArgs { acquire })
}

pub fn open_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    call(app, "openSettings", ())
}

#[no_mangle]
pub extern "system" fn Java_app_raven_mobilenative_RavenMobileNativePlugin_nativeInitialize(
    env: jni::JNIEnv<'_>,
    _plugin: jni::objects::JObject<'_>,
    application_context: jni::objects::JObject<'_>,
) -> jni::sys::jboolean {
    // CPAL/Oboe use ndk-context independently of WebRTC. Keep an Application
    // global reference for the process lifetime, including Activity recreation.
    static CONTEXT: std::sync::OnceLock<Result<jni::objects::GlobalRef, String>> =
        std::sync::OnceLock::new();
    let vm = match env.get_java_vm() {
        Ok(vm) => vm,
        Err(_) => return jni::sys::JNI_FALSE,
    };
    let context = CONTEXT.get_or_init(|| {
        let context = env
            .new_global_ref(&application_context)
            .map_err(|e| e.to_string())?;
        // SAFETY: OnceLock serializes this single initialization before plugin
        // registration completes. The VM and retained Application outlive audio.
        unsafe {
            ndk_context::initialize_android_context(
                vm.get_java_vm_pointer().cast(),
                context.as_obj().as_raw().cast(),
            );
        }
        Ok(context)
    });
    match context {
        Ok(context)
            if livekit::webrtc::android::initialize_android_context(&vm, context.as_obj()) =>
        {
            jni::sys::JNI_TRUE
        }
        _ => jni::sys::JNI_FALSE,
    }
}
