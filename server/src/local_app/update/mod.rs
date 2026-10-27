//! Coordinates a checked official package, the existing BYOK patcher and one Cursor restart.
#[cfg(all(test, windows))]
mod e2e;
mod install;
mod package;
mod prepare;
#[cfg(test)]
mod tests;
mod windows;

use super::{settings, CursorHarness};
use crate::{
    local_app::native_agent::{NativeAgent, NativeCheck},
    Error, Result,
};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    Downloading,
    Verifying,
    Extracting,
    Validating,
    Ready,
    Closing,
    Installing,
    Patching,
    Starting,
    Complete,
    Failed,
}
#[derive(Clone, Debug, Serialize)]
pub struct Candidate {
    pub id: String,
    pub version: String,
    pub commit: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub enabled: bool,
    pub current_version: Option<String>,
    pub phase: Phase,
    pub busy: bool,
    pub can_cancel: bool,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub candidate: Option<Candidate>,
    pub error: Option<String>,
    pub recovery_required: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Prepared {
    release: package::Release,
    sha256: String,
    patch_revision: String,
    stage: String,
    check: NativeCheck,
}
impl Prepared {
    fn candidate(&self) -> Candidate {
        Candidate {
            id: format!("{}-{}", self.sha256, self.patch_revision),
            version: self.check.version.clone(),
            commit: self.check.commit.clone(),
        }
    }
    fn validate(&self) -> Result<()> {
        self.release.validate()?;
        uuid::Uuid::parse_str(self.stage.strip_prefix("stage-").unwrap_or_default())
            .map_err(|e| Error::Config(e.to_string()))?;
        if self.sha256.len() != 64
            || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            || self.check.version != self.release.version
        {
            return Err(Error::Config("invalid cached Cursor update".into()));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Operation {
    phase: Phase,
    old_version: String,
    prepared: Prepared,
    launch: windows::Launch,
    installer_pid: Option<u32>,
    installer_started_ms: i64,
}
#[derive(Default)]
struct Progress {
    phase: Phase,
    bytes: u64,
    total: Option<u64>,
    prepared: Option<Prepared>,
    error: Option<String>,
}
pub(super) struct Runtime {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
    progress: RwLock<Progress>,
    cancel: RwLock<Option<CancellationToken>>,
    accepting: AtomicBool,
}
impl Runtime {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Arc::new(Mutex::new(())),
            progress: RwLock::new(Progress::default()),
            cancel: RwLock::new(None),
            accepting: AtomicBool::new(true),
        }
    }
    fn phase(&self, phase: Phase) {
        self.progress.write().phase = phase;
    }
    fn finish(&self, result: Result<()>) {
        if let Err(error) = result {
            if !matches!(error, Error::Cancelled) {
                self.failed(&error);
                return;
            }
            let mut progress = self.progress.write();
            progress.phase = if matches!(error, Error::Cancelled) {
                Phase::Idle
            } else {
                Phase::Failed
            };
            progress.error = if matches!(error, Error::Cancelled) {
                None
            } else {
                Some(error.to_string())
            };
        } else {
            let _ = std::fs::remove_file(self.root.join("last-error.json"));
        }
    }
    fn operation_path(&self) -> PathBuf {
        self.root.join("operation.json")
    }
    fn package_dir(&self, release: &package::Release) -> PathBuf {
        self.root.join("packages").join(release.id())
    }
    fn journal(&self, operation: &Operation) -> Result<()> {
        atomic_json(&self.operation_path(), operation)
    }
    fn operation(&self) -> Result<Option<Operation>> {
        match std::fs::read(self.operation_path()) {
            Ok(bytes) => {
                let operation: Operation = serde_json::from_slice(&bytes)?;
                operation.prepared.validate()?;
                Ok(Some(operation))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    pub(super) fn pending(&self) -> bool {
        self.operation_path().exists()
    }
    pub(super) fn cancel_check(&self) {
        if let Some(cancel) = self.cancel.read().as_ref() {
            cancel.cancel();
        }
    }
    pub(super) fn failed(&self, error: &Error) {
        let mut p = self.progress.write();
        tracing::warn!(%error,phase=?p.phase,"Cursor update task failed");
        let _ = atomic_json(
            &self.root.join("last-error.json"),
            &serde_json::json!({"time":chrono::Utc::now().to_rfc3339(),"phase":p.phase,"error":error.to_string()}),
        );
        p.phase = Phase::Failed;
        p.error = Some(error.to_string());
    }
    pub(super) fn ensure_accepting(&self) -> Result<()> {
        if !self.accepting.load(Ordering::Relaxed) {
            return Err(Error::Busy("BYOK is shutting down".into()));
        }
        Ok(())
    }
    pub(super) fn stop(&self) {
        self.accepting.store(false, Ordering::Relaxed);
        self.cancel_check();
    }
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
    }
    std::fs::rename(temporary, path)?;
    Ok(())
}

impl CursorHarness {
    pub async fn cursor_update_status(&self) -> Result<Status> {
        let saved = self.inner.store.cursor_update_settings().await?;
        let runtime = &self.inner.update;
        let current = package::Product::read(self.inner.native.app_path());
        let progress = runtime.progress.read();
        let busy = runtime.gate.try_lock().is_err();
        let supported = windows::supported() && (current.is_ok() || busy);
        let reason = if !windows::supported() {
            Some("Cursor update management supports Windows x64 only".into())
        } else {
            current.as_ref().err().map(ToString::to_string)
        };
        let settings_conflict = saved.enabled
            && !settings::read().is_ok_and(|current| {
                saved
                    .applied
                    .iter()
                    .all(|(key, value)| current.get(key) == Some(value))
            });
        Ok(Status {
            supported,
            unsupported_reason: reason,
            enabled: saved.enabled,
            current_version: current.ok().map(|p| p.version),
            phase: progress.phase,
            busy,
            can_cancel: runtime
                .cancel
                .read()
                .as_ref()
                .is_some_and(|token| !token.is_cancelled()),
            downloaded_bytes: progress.bytes,
            total_bytes: progress.total,
            candidate: progress.prepared.as_ref().map(Prepared::candidate),
            error: progress.error.clone().or_else(||settings_conflict.then(||"Cursor update settings were changed outside BYOK; turn management off and on again to apply it".into())),
            recovery_required: runtime.pending(),
        })
    }
    pub async fn set_cursor_update_management(&self, enabled: bool) -> Result<Status> {
        let _operation = self
            .inner
            .operation
            .try_lock()
            .map_err(|_| Error::Busy("Cursor takeover or update is in progress".into()))?;
        let runtime = &self.inner.update;
        runtime.ensure_accepting()?;
        let gate = runtime.gate.clone().try_lock_owned().map_err(|_| {
            Error::Busy(
                "Wait for the Cursor check/update to finish, or cancel the check first".into(),
            )
        })?;
        if runtime.pending() {
            return Err(Error::Busy(
                "Recover the interrupted Cursor update first".into(),
            ));
        }
        if enabled {
            if !windows::supported() {
                return Err(Error::Config(
                    "Cursor update management supports Windows x64 only".into(),
                ));
            }
            package::Product::read(self.inner.native.app_path())?;
        }
        let mut saved = self.inner.store.cursor_update_settings().await?;
        if saved.enabled != enabled {
            let mut current = settings::read()?;
            if enabled {
                saved.applied = settings::update_management_patch(&current);
                saved.original = current
                    .iter()
                    .filter(|(key, _)| saved.applied.contains_key(*key))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                saved.enabled = true;
                // Persist the original values before changing settings, so interruption is recoverable.
                self.inner.store.set_cursor_update_settings(&saved).await?;
                current.extend(saved.applied.clone());
                if let Err(error) = settings::write(&current) {
                    saved.enabled = false;
                    self.inner.store.set_cursor_update_settings(&saved).await?;
                    return Err(error);
                }
            } else {
                settings::restore_update_patch(&mut current, &saved);
                settings::write(&current)?;
                saved.enabled = false;
                saved.original.clear();
                saved.applied.clear();
                self.inner.store.set_cursor_update_settings(&saved).await?;
            }
        }
        drop(_operation);
        drop(gate);
        if enabled {
            self.check_cursor_update().await?;
        }
        self.cursor_update_status().await
    }
    pub async fn check_cursor_update(&self) -> Result<Status> {
        let runtime = &self.inner.update;
        if runtime.pending() {
            return Err(Error::Busy(
                "Recover the interrupted Cursor update first".into(),
            ));
        }
        if !windows::supported() {
            return Err(Error::Config(
                "Cursor update management supports Windows x64 only".into(),
            ));
        }
        let guard = runtime
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| Error::Busy("Cursor update task is already running".into()))?;
        runtime.ensure_accepting()?;
        let cancel = CancellationToken::new();
        *runtime.cancel.write() = Some(cancel.clone());
        {
            let mut p = runtime.progress.write();
            p.phase = Phase::Checking;
            p.error = None;
            p.bytes = 0;
            p.total = None;
            p.prepared = None;
        }
        let harness = self.clone();
        tokio::spawn(async move {
            let _guard = guard;
            let result = harness.prepare_cursor_update(cancel).await;
            harness.inner.update.finish(result);
            *harness.inner.update.cancel.write() = None;
        });
        self.cursor_update_status().await
    }
    pub async fn cancel_cursor_update_check(&self) -> Result<Status> {
        {
            let cancel = self.inner.update.cancel.read();
            let cancel = cancel
                .as_ref()
                .ok_or_else(|| Error::Busy("Only a Cursor update check can be cancelled".into()))?;
            cancel.cancel();
        }
        self.cursor_update_status().await
    }
    pub(super) async fn restore_cursor_update_settings(&self) -> Result<()> {
        let saved = self.inner.store.cursor_update_settings().await?;
        if saved.enabled {
            let mut current = settings::read()?;
            // A saved owner can be resumed after a crash between persisting its backup
            // and writing the settings. Do not overwrite subsequent manual edits.
            for (key, value) in &saved.applied {
                if current.get(key) == Some(value) || current.get(key) == saved.original.get(key) {
                    current.insert(key.clone(), value.clone());
                }
            }
            settings::write(&current)?;
        }
        Ok(())
    }
    pub async fn start_cursor_update_check_if_managed(&self) {
        if self
            .inner
            .store
            .cursor_update_settings()
            .await
            .is_ok_and(|settings| settings.enabled)
            && !self.inner.update.pending()
        {
            if let Err(error) = self.check_cursor_update().await {
                tracing::warn!(%error,"automatic Cursor update check failed");
            }
        }
    }
    pub async fn wait_for_cursor_update(&self) {
        self.inner.update.stop();
        let _guard = self.inner.operation.lock().await;
    }
}
