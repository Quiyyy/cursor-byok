//! Installed Cursor factories and tools, reached through a versioned process boundary.
mod bridge;
mod process;
mod session;
pub(crate) use bridge::Bridge;
pub(crate) use session::NativeCallback;
pub use session::{NativeProfile, NativeRun};

use crate::{Error, Result};
use process::Worker;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::sync::Mutex;

const WORKER: &str = include_str!("../../../cursor-runtime/worker.bundle.mjs");
const NOTICES: &str = include_str!("../../../cursor-runtime/THIRD_PARTY_LICENSES.txt");
#[derive(Clone)]
pub struct NativeRuntime {
    inner: Arc<Runtime>,
}
type Fingerprint = (SystemTime, u64, SystemTime);
struct Runtime {
    app: PathBuf,
    executable: PathBuf,
    script: PathBuf,
    current: Mutex<Option<(Fingerprint, Arc<Worker>)>>,
}

impl NativeRuntime {
    pub fn managed() -> Result<Self> {
        let app = match std::env::var_os("CURSOR_APP_DIR") {
            Some(path) => PathBuf::from(path),
            None => default_app_path()?,
        };
        let executable = std::env::var_os("CURSOR_NODE_EXECUTABLE")
            .map(PathBuf::from)
            .unwrap_or_else(|| cursor_executable(&app));
        Self::in_directory(
            app,
            executable,
            crate::config::managed_data_dir()?.join("cursor-runtime"),
        )
    }
    pub fn in_directory(app: PathBuf, executable: PathBuf, directory: PathBuf) -> Result<Self> {
        use sha2::{Digest, Sha256};
        std::fs::create_dir_all(&directory)?;
        std::fs::write(directory.join("THIRD_PARTY_LICENSES.txt"), NOTICES)?;
        let script = directory.join(format!(
            "worker-{}.mjs",
            hex::encode(Sha256::digest(WORKER.as_bytes()))
        ));
        if !script.exists() {
            std::fs::write(&script, WORKER)?;
        }
        Ok(Self {
            inner: Arc::new(Runtime {
                app,
                executable,
                script,
                current: Mutex::new(None),
            }),
        })
    }
    async fn worker(&self) -> Result<Arc<Worker>> {
        let bundle = self
            .inner
            .app
            .join("extensions/cursor-local-agent-runtime/dist/main.js");
        let metadata = std::fs::metadata(&bundle).map_err(|e| {
            Error::Config(format!(
                "cannot read installed Cursor runtime {}: {e}",
                bundle.display()
            ))
        })?;
        let modified = (
            metadata.modified()?,
            metadata.len(),
            std::fs::metadata(self.inner.app.join("product.json"))?.modified()?,
        );
        let mut current = self.inner.current.lock().await;
        if let Some((version, worker)) = &*current {
            if *version == modified && worker.is_healthy() {
                return Ok(worker.clone());
            }
        }
        let worker =
            Worker::spawn(&self.inner.executable, &self.inner.app, &self.inner.script).await?;
        tracing::info!(metadata=%worker.metadata,"Cursor native runtime ready");
        *current = Some((modified, worker.clone()));
        Ok(worker)
    }
    pub async fn describe(&self, model: &str, mode: i32) -> Result<Value> {
        let worker = self.worker().await?;
        let id = uuid::Uuid::new_v4().to_string();
        let result = worker
            .request(
                "open",
                serde_json::json!({"session_id":id,"model":model,"mode":mode}),
            )
            .await;
        let _ = worker.notify("close", serde_json::json!({"session_id":id}));
        result
    }
}
fn default_app_path() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        Ok(PathBuf::from(
            std::env::var_os("LOCALAPPDATA")
                .ok_or_else(|| Error::Config("LOCALAPPDATA is unavailable".into()))?,
        )
        .join("Programs/cursor/resources/app"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(PathBuf::from(
            "/Applications/Cursor.app/Contents/Resources/app",
        ))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Ok(PathBuf::from("/opt/Cursor/resources/app"))
    }
}
fn cursor_executable(app: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        app.join("../../Cursor.exe")
    }
    #[cfg(target_os = "macos")]
    {
        app.join("../../MacOS/Cursor")
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        app.join("../../cursor")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires the installed Cursor runtime"]
    async fn installed_worker_generates_native_profiles_over_ipc() {
        let app = std::env::var_os("CURSOR_APP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| default_app_path().unwrap());
        let directory = tempfile::tempdir().unwrap();
        let runtime = NativeRuntime::in_directory(
            app.clone(),
            cursor_executable(&app),
            directory.path().into(),
        )
        .unwrap();
        let gpt = runtime.describe("gpt-5.4", 1).await.unwrap();
        let claude = runtime.describe("claude-opus-4.6", 1).await.unwrap();
        assert_ne!(gpt["instructions"], claude["instructions"]);
        assert!(gpt["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "ApplyPatch" && t["input_format"]["type"] == "grammar"));
        assert!(claude["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "StrReplace"));
        let before = runtime.worker().await.unwrap();
        before.kill_for_test();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while before.is_healthy() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(before.request("open", serde_json::json!({})).await.is_err());
        let after = runtime.worker().await.unwrap();
        assert!(!Arc::ptr_eq(&before, &after));
        assert!(after.is_healthy());
    }
}
