//! MobileNative: the native Android app built from this crate. Android OS state
//! (foreground, permissions, audio focus) feeds the shared engines through
//! `crate::media_eligibility`. Nothing here owns admission, heartbeat or reconnect.

#[cfg(any(mobile, test))]
pub mod camera;
pub mod gate;
#[cfg(mobile)]
pub mod media;
