/** Set by Tauri at build time; the native Android app (MobileNative) composes its own shell. */
export const isAndroid = import.meta.env.TAURI_ENV_PLATFORM === "android";
