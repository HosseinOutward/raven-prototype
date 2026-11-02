//! Saves the copy of a person's data that the server prepared.

use std::fs;
use tauri::{
    ipc::{InvokeBody, Request},
    Manager,
};

const SAVE_LIMIT: usize = 1024 * 1024 * 1024;

/// Keeps only what is safe in a file name, and makes it a .zip.
fn safe_export_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .collect();
    if cleaned.is_empty() || cleaned == ".zip" {
        "raven-data.zip".into()
    } else if cleaned.ends_with(".zip") {
        cleaned
    } else {
        format!("{cleaned}.zip")
    }
}

/// Asks where to save the .zip, starting in Downloads, then writes its bytes there. The
/// picker runs here rather than in the WebView, so no command writes to a path the page
/// chose. Returns the saved path, or `None` when the person cancels.
#[tauri::command]
pub async fn save_export_file(
    window: tauri::WebviewWindow,
    request: Request<'_>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The copy was not sent as a file.".into());
    };
    if bytes.len() > SAVE_LIMIT {
        return Err("The copy is too large to save.".into());
    }
    let name = request
        .headers()
        .get("X-Raven-Export-Name")
        .and_then(|h| std::str::from_utf8(h.as_bytes()).ok())
        .map(safe_export_name)
        .unwrap_or_else(|| "raven-data.zip".into());
    let bytes = bytes.clone();
    let mut picker = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(name)
        .add_filter("Zip archive", &["zip"]);
    if let Ok(downloads) = window.app_handle().path().download_dir() {
        picker = picker.set_directory(downloads);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = picker.blocking_save_file() else {
            return Ok(None);
        };
        let path = path
            .into_path()
            .map_err(|_| "That location can't be saved to.".to_string())?;
        fs::write(&path, bytes).map_err(|err| format!("Couldn't write the file: {err}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "Saving was interrupted.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::safe_export_name;

    #[test]
    fn keeps_a_normal_name() {
        assert_eq!(safe_export_name("raven-alice-2026-11-02.zip"), "raven-alice-2026-11-02.zip");
    }

    #[test]
    fn drops_folders_and_odd_characters() {
        assert_eq!(safe_export_name("..\\..\\evil name?.zip"), "evilname.zip");
        assert_eq!(safe_export_name("a/b/c.zip"), "c.zip");
    }

    #[test]
    fn always_ends_in_zip_and_never_empty() {
        assert_eq!(safe_export_name("data"), "data.zip");
        assert_eq!(safe_export_name("???"), "raven-data.zip");
        assert_eq!(safe_export_name(""), "raven-data.zip");
    }
}
