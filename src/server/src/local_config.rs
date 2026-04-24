use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use utoipa::ToSchema;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct LocalPhoneConfig {
    #[serde(default = "default_true")]
    pub wifi_enabled: bool,
}

impl Default for LocalPhoneConfig {
    fn default() -> Self {
        Self {
            wifi_enabled: true,
        }
    }
}

fn default_true() -> bool {
    true
}

pub async fn load(path: &Path) -> HashMap<String, LocalPhoneConfig> {
    match tokio::fs::read_to_string(path).await {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

pub async fn save(
    path: &Path,
    configs: &HashMap<String, LocalPhoneConfig>,
) -> std::io::Result<()> {
    let data = serde_json::to_string_pretty(configs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    let dir = path.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(dir).await.ok();

    let tmp_path = dir.join(format!(".local_config_tmp_{}", std::process::id()));
    let mut file = tokio::fs::File::create(&tmp_path).await?;
    file.write_all(data.as_bytes()).await?;
    file.sync_all().await?;
    tokio::fs::rename(&tmp_path, path).await?;
    Ok(())
}

pub fn get_or_default(
    configs: &HashMap<String, LocalPhoneConfig>,
    adb_serial: &str,
) -> LocalPhoneConfig {
    configs.get(adb_serial).cloned().unwrap_or_default()
}
