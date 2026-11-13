//! Coordinates a checked official package, the existing BYOK patcher and one Cursor restart.
mod install;
mod package;
mod prepare;
#[cfg(test)]
mod tests;
mod verified;
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
    Unverified,
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
    pub current_commit: Option<String>,
    pub verified_release: Option<verified::VerifiedRelease>,
    pub current_verified: bool,
    pub unverified_version: Option<String>,
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
            || !verified::supports_build(&self.check.version, &self.check.commit)
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
    unverified_version: Option<String>,
}
pub(super) struct Runtime {
    root: PathBuf,
    pub(super) gate: Arc<Mutex<()>>,
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
            progress.phase = Phase::Idle;
            progress.error = None;
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

pub(crate) fn ensure_verified_installation(app: &Path) -> Result<()> {
    let product = package::Product::read(app)?;
    if !verified::supports_build(&product.version, &product.commit) {
        return Err(Error::Config(format!(
            "Cursor {} has not been verified for managed takeover; this BYOK build supports Cursor {} with the built-in Harness",
            product.version, verified::latest().version
        )));
    }
    ensure_management_settings()
}

fn ensure_management_settings() -> Result<()> {
    let current = settings::read()?;
    if !settings::update_management_patch()
        .iter()
        .all(|(key, value)| current.get(key) == Some(value))
    {
        return Err(Error::Config("Managed Cursor update settings are not applied; disable and re-enable management to restore the verified built-in Harness configuration".into()));
    }
    Ok(())
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
        let settings_conflict = saved.enabled && ensure_management_settings().is_err();
        Ok(Status {
            supported,
            unsupported_reason: reason,
            enabled: saved.enabled,
            current_version: current.as_ref().ok().map(|p| p.version.clone()),
            current_commit: current.as_ref().ok().map(|p| p.commit.clone()),
            verified_release: windows::supported().then_some(verified::latest()),
            current_verified: current.as_ref().is_ok_and(|p| verified::supports_build(&p.version, &p.commit)),
            unverified_version: progress.unverified_version.clone(),
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
            error: progress.error.clone().or_else(||settings_conflict.then(||"Cursor update settings are not applied; turn management off and on again to apply them".into())),
            recovery_required: runtime.pending(),
        })
    }
    pub async fn set_cursor_update_management(&self, enabled: bool) -> Result<Status> {
        let _operation = self
            .inner
            .lifecycle
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
            let executable =
                crate::local_app::native_agent::cursor_executable(self.inner.native.app_path());
            let executable = if executable.exists() {
                executable.canonicalize()?
            } else {
                executable
            };
            let launch = if windows::supported()
                && executable.exists()
                && windows::running(&runtime.root, &executable).await?
            {
                Some(windows::close(&runtime.root, &executable).await?)
            } else {
                None
            };
            let result: Result<()> = async {
                let mut current = settings::read()?;
                if enabled {
                    saved.applied = settings::update_management_patch();
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
                Ok(())
            }
            .await;
            // A settings/storage failure must not leave an otherwise usable Cursor closed.
            if let Some(launch) = launch {
                let restart = windows::launch(&executable, &launch).await;
                if result.is_ok() {
                    restart?;
                } else if let Err(error) = restart {
                    tracing::warn!(%error, "Cursor restart also failed after applying update settings failed");
                }
            }
            result?;
        }
        drop(_operation);
        drop(gate);
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
            p.unverified_version = None;
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
}
