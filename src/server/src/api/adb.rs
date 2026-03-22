use std::collections::HashMap;
use std::process::Stdio;
use tokio::process::Command;

use super::ApiError;

/// Run an ADB command and return stdout bytes.
pub async fn adb(args: &[&str]) -> Result<Vec<u8>, ApiError> {
    let output = Command::new("adb")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| ApiError::Adb(format!("failed to spawn adb: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::Adb(format!(
            "adb {:?} failed ({}): {}",
            args,
            output.status,
            stderr.trim()
        )));
    }

    Ok(output.stdout)
}

/// Run `adb shell <cmd>` and return stdout as a String.
pub async fn adb_shell(cmd: &str) -> Result<String, ApiError> {
    let out = adb(&["shell", cmd]).await?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Parse a row from `adb shell content query` output.
/// Format: "Row: 0 thread_id=5, address=+1234567890, body=Hello, date=1234567890"
pub fn parse_content_row(line: &str) -> Option<HashMap<String, String>> {
    let line = line.trim();
    if !line.starts_with("Row:") {
        return None;
    }
    // Skip "Row: N "
    let data = line.split_once(' ')?.1; // "0 thread_id=5, ..."
    let data = data.split_once(' ')?.1; // "thread_id=5, ..."

    let mut map = HashMap::new();
    for part in data.split(", ") {
        if let Some((key, val)) = part.split_once('=') {
            map.insert(
                key.trim().to_string(),
                val.trim().to_string(),
            );
        }
    }
    Some(map)
}
