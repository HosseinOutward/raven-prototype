//! The Workshop's port sharing, desktop side.
//!
//! A share is published or used over one connection to the server's relay (QUIC with TLS
//! 1.3 here; the WebSocket route is plan 02). The publisher dials only loopback on its own
//! computer, and a consumer listens only on `127.0.0.1`.
//!
//! The web side holds the API calls and the share list; this side moves the bytes and
//! reports each share's state through `workshop://status` events.

pub mod consumer;
pub mod flows;
pub mod frames;
pub mod link;
pub mod publisher;

#[cfg(test)]
mod live;

use std::{collections::HashMap, sync::{atomic::Ordering, Arc, Mutex}, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use flows::Counters;
use frames::{ROLE_CONSUMER, ROLE_PUBLISHER};
use link::{Link, QuicLink};

pub const WORKSHOP_STATUS_EVENT: &str = "workshop://status";

/// What is running, by role and share id. One entry per share per role.
#[derive(Default)]
pub struct WorkshopState {
    sessions: Mutex<HashMap<String, Session>>,
}

pub type SharedWorkshopState = Arc<WorkshopState>;

pub fn new_workshop_state() -> SharedWorkshopState {
    Arc::new(WorkshopState::default())
}

struct Session {
    link: Arc<QuicLink>,
    task: tauri::async_runtime::JoinHandle<()>,
    ticker: tauri::async_runtime::JoinHandle<()>,
}

impl Session {
    fn end(self) {
        self.link.close("stopped");
        self.task.abort();
        self.ticker.abort();
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    share_id: String,
    role: &'static str,
    /// `live`, `notice` or `ended`.
    state: &'static str,
    reason: Option<String>,
    notice: Option<String>,
    bytes_up: u64,
    bytes_down: u64,
    flows: u64,
    udp_dropped: u64,
}

fn emit(app: &AppHandle, event: StatusEvent) {
    let _ = app.emit(WORKSHOP_STATUS_EVENT, event);
}

fn snapshot(share_id: &str, role: &'static str, state: &'static str, counters: &Counters) -> StatusEvent {
    StatusEvent {
        share_id: share_id.to_string(),
        role,
        state,
        bytes_up: counters.bytes_up.load(Ordering::Relaxed),
        bytes_down: counters.bytes_down.load(Ordering::Relaxed),
        flows: counters.flows.load(Ordering::Relaxed),
        udp_dropped: counters.udp_dropped.load(Ordering::Relaxed),
        ..Default::default()
    }
}

fn key(role: &str, share_id: &str) -> String {
    format!("{role}:{share_id}")
}

/// What `workshop_publish` and `workshop_connect` tell the web side.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    route: String,
    /// The port a consumer listens on, `127.0.0.1:<local_port>`.
    local_port: Option<u16>,
    /// Said when the share’s own port was taken and another was used.
    notice: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishArgs {
    endpoints: Vec<String>,
    token: String,
    share_id: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectArgs {
    endpoints: Vec<String>,
    token: String,
    share_id: String,
    /// `tcp`, `udp` or `both`.
    protocol: String,
    port: u16,
}

fn spawn_ticker(app: AppHandle, share_id: String, role: &'static str, counters: Arc<Counters>) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            emit(&app, snapshot(&share_id, role, "live", &counters));
        }
    })
}

fn report_for(app: &AppHandle, share_id: &str, role: &'static str) -> publisher::Report {
    let (app, share_id) = (app.clone(), share_id.to_string());
    Arc::new(move |message: String| {
        emit(&app, StatusEvent { share_id: share_id.clone(), role, state: "notice", notice: Some(message), ..Default::default() });
    })
}

fn finish(app: &AppHandle, state: &WorkshopState, share_id: &str, role: &'static str, counters: &Counters, reason: String) {
    // If the session was already stopped by the user it is gone from the map and the
    // stop command has said so.
    let removed = state.sessions.lock().unwrap().remove(&key(role, share_id));
    if let Some(session) = removed {
        session.ticker.abort();
        let mut event = snapshot(share_id, role, "ended", counters);
        event.reason = Some(reason);
        emit(app, event);
    }
}

#[tauri::command]
pub async fn workshop_publish(
    app: AppHandle,
    state: State<'_, SharedWorkshopState>,
    args: PublishArgs,
) -> Result<Started, String> {
    let link = link::connect(&args.endpoints, &args.token, ROLE_PUBLISHER, &args.share_id)
        .await
        .map_err(|e| e.to_string())?;
    let link = Arc::new(link);
    let route = link.route();
    let counters = Arc::new(Counters::default());
    let share_id = args.share_id.clone();
    let shared = state.inner().clone();
    let task = {
        let (app, link, counters, shared, share_id) = (app.clone(), link.clone(), counters.clone(), shared.clone(), share_id.clone());
        let report = report_for(&app, &share_id, "publisher");
        let port = args.port;
        tauri::async_runtime::spawn(async move {
            let reason = publisher::run(link, port, counters.clone(), report).await;
            finish(&app, &shared, &share_id, "publisher", &counters, reason);
        })
    };
    let ticker = spawn_ticker(app.clone(), share_id.clone(), "publisher", counters);
    let previous = shared.sessions.lock().unwrap().insert(key("publisher", &share_id), Session { link, task, ticker });
    if let Some(previous) = previous {
        previous.end();
    }
    Ok(Started { route, local_port: None, notice: None })
}

#[tauri::command]
pub async fn workshop_connect(
    app: AppHandle,
    state: State<'_, SharedWorkshopState>,
    args: ConnectArgs,
) -> Result<Started, String> {
    let (want_tcp, want_udp) = match args.protocol.as_str() {
        "tcp" => (true, false),
        "udp" => (false, true),
        _ => (true, true),
    };
    let link = link::connect(&args.endpoints, &args.token, ROLE_CONSUMER, &args.share_id)
        .await
        .map_err(|e| e.to_string())?;
    let listeners = consumer::bind(args.port, want_tcp, want_udp)
        .await
        .map_err(|e| format!("Raven couldn’t listen on this computer: {e}."))?;
    let local_port = listeners.port;
    let notice = listeners.moved_from.map(|wanted| {
        format!("Port {wanted} is already in use on this computer, so Raven listens on {local_port} instead.")
    });
    let link = Arc::new(link);
    let route = link.route();
    let counters = Arc::new(Counters::default());
    let share_id = args.share_id.clone();
    let shared = state.inner().clone();
    let task = {
        let (app, link, counters, shared, share_id) = (app.clone(), link.clone(), counters.clone(), shared.clone(), share_id.clone());
        let report = report_for(&app, &share_id, "consumer");
        tauri::async_runtime::spawn(async move {
            let reason = consumer::run(link, share_id.clone(), listeners, counters.clone(), report).await;
            finish(&app, &shared, &share_id, "consumer", &counters, reason);
        })
    };
    let ticker = spawn_ticker(app.clone(), share_id.clone(), "consumer", counters);
    let previous = shared.sessions.lock().unwrap().insert(key("consumer", &share_id), Session { link, task, ticker });
    if let Some(previous) = previous {
        previous.end();
    }
    Ok(Started { route, local_port: Some(local_port), notice })
}

fn stop(app: &AppHandle, state: &WorkshopState, role: &'static str, share_id: &str) {
    let removed = state.sessions.lock().unwrap().remove(&key(role, share_id));
    if let Some(session) = removed {
        session.end();
        emit(app, StatusEvent { share_id: share_id.to_string(), role, state: "ended", reason: Some("stopped".into()), ..Default::default() });
    }
}

/// Stops publishing. Closing the relay connection also ends the share on the server.
#[tauri::command]
pub fn workshop_stop(app: AppHandle, state: State<'_, SharedWorkshopState>, share_id: String) {
    stop(&app, state.inner(), "publisher", &share_id);
}

/// Stops using a share. The local listeners close with it.
#[tauri::command]
pub fn workshop_disconnect(app: AppHandle, state: State<'_, SharedWorkshopState>, share_id: String) {
    stop(&app, state.inner(), "consumer", &share_id);
}
