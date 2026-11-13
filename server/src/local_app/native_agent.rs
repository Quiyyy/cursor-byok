//! Installs native routing and new-conversation defaults; never owns Agent state or tools.
use crate::{Error, Result};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::sync::Mutex;

const INSTALLER: &str = include_str!("../../native-agent/install.bundle.mjs");
const BRIDGE: &str = include_str!("../../native-agent/route.cjs");
const SEARCH: &str = include_str!("../../native-agent/search.cjs");
const NOTICES: &str = include_str!("../../native-agent/THIRD_PARTY_LICENSES.txt");
const FILES: [&str; 4] = [
    "extensions/cursor-agent-host/dist/main.js",
    "extensions/cursor-local-agent-runtime/dist/main.js",
    "out/vs/workbench/workbench.desktop.main.js",
    "product.json",
];
type Fingerprint = Vec<(PathBuf, SystemTime, u64)>;
#[derive(Clone, Default)]
pub(crate) struct NativeCatalog {
    pub available: Vec<Vec<u8>>,
    pub usable: Vec<Vec<u8>>,
}
#[derive(serde::Deserialize)]
struct EncodedCatalog {
    available: Vec<String>,
    usable: Vec<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct NativeCheck {
    pub version: String,
    pub commit: String,
    pub files: Vec<CheckedFile>,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CheckedFile {
    pub file: String,
    pub sha256: String,
}
struct CachedCatalog {
    input: String,
    fingerprint: Fingerprint,
    models: NativeCatalog,
}

#[derive(Clone)]
pub struct NativeAgent {
    inner: Arc<Inner>,
}
struct Inner {
    app: PathBuf,
    directory: PathBuf,
    key: String,
    installed: Mutex<Option<Fingerprint>>,
    catalog: Mutex<Option<CachedCatalog>>,
}
impl NativeAgent {
    pub(crate) fn app_path(&self) -> &Path {
        &self.inner.app
    }
    pub(crate) fn patch_revision() -> String {
        let mut hash = Sha256::new();
        for source in [INSTALLER, BRIDGE, SEARCH] {
            hash.update(source);
        }
        hex::encode(hash.finalize())
    }
    pub(crate) fn in_directory(app: PathBuf, directory: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                app,
                directory,
                key: uuid::Uuid::new_v4().to_string(),
                installed: Mutex::new(None),
                catalog: Mutex::new(None),
            }),
        }
    }
    pub(crate) async fn invalidate(&self) {
        *self.inner.installed.lock().await = None;
        *self.inner.catalog.lock().await = None;
    }
    pub(crate) async fn deactivate(&self) -> Result<()> {
        self.invalidate().await;
        self.write_connection(false, None)
    }
    pub(crate) async fn check_candidate(&self, app: &Path) -> Result<NativeCheck> {
        Ok(serde_json::from_value(
            self.run_at("check", None, app).await?,
        )?)
    }
    pub(crate) fn verify_originals(&self, checked: &NativeCheck) -> Result<()> {
        let names: std::collections::BTreeSet<_> =
            checked.files.iter().map(|f| f.file.as_str()).collect();
        if names.len() != checked.files.len() || !FILES.iter().all(|name| names.contains(name)) {
            return Err(Error::Config("incomplete Cursor package preflight".into()));
        }
        for entry in &checked.files {
            let chunk = entry
                .file
                .strip_prefix("extensions/cursor-agent-host/dist/")
                .and_then(|file| file.strip_suffix(".js"))
                .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()));
            if !FILES.contains(&entry.file.as_str()) && !chunk {
                return Err(Error::Config(
                    "unexpected file in Cursor package preflight".into(),
                ));
            }
            let actual = hex::encode(Sha256::digest(std::fs::read(
                self.inner.app.join(&entry.file),
            )?));
            if actual != entry.sha256 {
                return Err(Error::Config(format!(
                    "installed Cursor differs from the checked package: {}",
                    entry.file
                )));
            }
        }
        Ok(())
    }
    pub(crate) async fn verify_updated(&self, checked: &NativeCheck) -> Result<()> {
        let actual: NativeCheck = serde_json::from_value(self.run("verify", None).await?)?;
        if actual.version != checked.version
            || actual.commit != checked.commit
            || actual.files != checked.files
        {
            return Err(Error::Config(
                "Cursor patch sources differ from the verified package".into(),
            ));
        }
        Ok(())
    }
    pub(crate) async fn verify_catalog(&self) -> Result<()> {
        let models = self.picker_models(json!([{"id":"gpt-5.4","cursorId":"byok:check","source":"BYOK check","displayName":"BYOK check","contextLength":200000}])).await?;
        if models.available.len() != 1 || models.usable.len() != 1 {
            return Err(Error::Config(
                "native Cursor catalog validation failed".into(),
            ));
        }
        Ok(())
    }
    pub(crate) async fn ensure_managed_runtime(&self, store: &crate::store::Store) -> Result<()> {
        if store.cursor_update_settings().await?.enabled {
            super::update::ensure_verified_installation(&self.inner.app)?;
            if !self.is_current().await {
                return Err(Error::Config("Cursor installation changed; restart managed takeover before using native models".into()));
            }
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn for_test(root: &Path) -> Self {
        Self {
            inner: Arc::new(Inner {
                app: root.join("unused-cursor"),
                directory: root.join("native"),
                key: "native-test-key".into(),
                installed: Mutex::new(None),
                catalog: Mutex::new(None),
            }),
        }
    }

    pub fn managed() -> Result<Self> {
        let app = installed_app_path()?;
        Ok(Self::in_directory(
            app,
            crate::config::managed_data_dir()?.join("native-agent"),
        ))
    }
    pub(crate) fn authorized(&self, key: &str) -> bool {
        key.len() == self.inner.key.len()
            && key
                .bytes()
                .zip(self.inner.key.bytes())
                .fold(0, |v, (a, b)| v | (a ^ b))
                == 0
    }
    pub(crate) async fn picker_models(&self, models: serde_json::Value) -> Result<NativeCatalog> {
        use base64::Engine;
        let input = serde_json::to_string(&models)?;
        let installed = self.inner.installed.lock().await;
        let fingerprint = self.fingerprint();
        let mut cache = self.inner.catalog.lock().await;
        if installed.is_none() || fingerprint.as_ref().ok() != installed.as_ref() {
            *cache = None;
            return Err(Error::Config("Cursor native takeover is not ready or installation files changed; reopen managed takeover".into()));
        }
        let fingerprint = fingerprint?;
        if let Some(previous) = &*cache {
            if previous.input == input && previous.fingerprint == fingerprint {
                return Ok(previous.models.clone());
            }
        }
        let value = self.run("catalog", Some(input.as_bytes())).await?;
        let encoded: EncodedCatalog = serde_json::from_value(value)?;
        let decode = |encoded: Vec<String>| {
            encoded
                .into_iter()
                .map(|v| {
                    base64::engine::general_purpose::STANDARD
                        .decode(v)
                        .map_err(|e| Error::Protocol(format!("invalid native catalog: {e}")))
                })
                .collect::<Result<Vec<_>>>()
        };
        let models = NativeCatalog {
            available: decode(encoded.available)?,
            usable: decode(encoded.usable)?,
        };
        *cache = Some(CachedCatalog {
            input,
            fingerprint,
            models: models.clone(),
        });
        Ok(models)
    }
    fn fingerprint(&self) -> Result<Fingerprint> {
        let mut files: Vec<PathBuf> = FILES.iter().map(PathBuf::from).collect();
        let host = PathBuf::from("extensions/cursor-agent-host/dist");
        for entry in std::fs::read_dir(self.inner.app.join(&host))? {
            let name = entry?.file_name();
            if name.to_str().is_some_and(|name| {
                name.strip_suffix(".js")
                    .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
            }) {
                files.push(host.join(name));
            }
        }
        files.sort();
        files
            .into_iter()
            .map(|file| {
                let m = std::fs::metadata(self.inner.app.join(&file))?;
                Ok((file, m.modified()?, m.len()))
            })
            .collect()
    }
    pub async fn is_current(&self) -> bool {
        self.inner
            .installed
            .lock()
            .await
            .as_ref()
            .is_some_and(|installed| {
                self.fingerprint()
                    .is_ok_and(|current| *installed == current)
            })
    }

    pub async fn enable(&self, address: std::net::SocketAddr) -> Result<bool> {
        let mut installed = self.inner.installed.lock().await;
        self.write_connection(true, Some(address))?;
        if installed
            .as_ref()
            .is_some_and(|old| self.fingerprint().as_ref().is_ok_and(|new| old == new))
        {
            return Ok(false);
        }
        let result = self.install(false).await;
        match result {
            Ok(changed) => {
                *installed = Some(self.fingerprint()?);
                Ok(changed)
            }
            Err(error) => {
                self.write_connection(false, None)?;
                Err(error)
            }
        }
    }
    pub async fn disable(&self) -> Result<()> {
        let mut installed = self.inner.installed.lock().await;
        self.write_connection(false, None)?;
        if self.inner.directory.join("installations").exists() && self.inner.app.exists() {
            self.install(true).await?;
        }
        *installed = None;
        Ok(())
    }
    fn write_connection(&self, enabled: bool, address: Option<std::net::SocketAddr>) -> Result<()> {
        std::fs::create_dir_all(&self.inner.directory)?;
        let file = self.inner.directory.join("connection.json");
        let temporary = self.inner.directory.join("connection.tmp");
        std::fs::write(
            &temporary,
            serde_json::to_vec(
                &json!({"enabled":enabled,"baseUrl":address.map(|a|format!("http://{a}/__byok-native__")),"apiKey":self.inner.key}),
            )?,
        )?;
        std::fs::rename(temporary, file)?;
        Ok(())
    }
    async fn install(&self, restore: bool) -> Result<bool> {
        let result = self
            .run(if restore { "restore" } else { "install" }, None)
            .await?;
        Ok(result["changed"].as_bool().unwrap_or(false))
    }
    async fn run(&self, mode: &str, input: Option<&[u8]>) -> Result<serde_json::Value> {
        self.run_at(mode, input, &self.inner.app).await
    }
    async fn run_at(
        &self,
        mode: &str,
        input: Option<&[u8]>,
        app: &Path,
    ) -> Result<serde_json::Value> {
        std::fs::create_dir_all(&self.inner.directory)?;
        let script = self.inner.directory.join("install.mjs");
        write_asset(&script, INSTALLER)?;
        write_asset(self.inner.directory.join("route.cjs"), BRIDGE)?;
        write_asset(self.inner.directory.join("search.cjs"), SEARCH)?;
        write_asset(
            self.inner.directory.join("THIRD_PARTY_LICENSES.txt"),
            NOTICES,
        )?;
        let executable = if cfg!(windows) {
            app.join("resources/helpers/node.exe")
        } else {
            cursor_executable(app)
        };
        let mut command = tokio::process::Command::new(executable);
        command
            .arg(&script)
            .arg(app)
            .arg(&self.inner.directory)
            .arg(mode)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            if let Some(input) = input {
                use tokio::io::AsyncWriteExt;
                stdin.write_all(input).await?;
            }
        }
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| Error::Config("Cursor native entry installation timed out".into()))??;
        if !output.status.success() {
            return Err(Error::Config(format!(
                "Cursor native entry: {}",
                String::from_utf8_lossy(&output.stderr)
            )));
        }
        Ok(serde_json::from_slice(&output.stdout)?)
    }
}
fn write_asset(path: impl AsRef<Path>, content: &str) -> Result<()> {
    let path = path.as_ref();
    if std::fs::read(path).is_ok_and(|old| old == content.as_bytes()) {
        return Ok(());
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, content)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}
pub(super) fn installed_app_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("CURSOR_APP_DIR") {
        return Ok(PathBuf::from(path));
    }
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
pub(super) fn cursor_executable(app: &Path) -> PathBuf {
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
mod tests;

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::local_app::{
        ca::CaManager, proxy::ProxyRuntime, CaState, CursorHarness, IntegrationState,
    };
    use parking_lot::RwLock;

    #[tokio::test]
    async fn changing_a_host_chunk_invalidates_the_installed_runtime() {
        let directory = tempfile::tempdir().unwrap();
        let native = NativeAgent::for_test(directory.path());
        for file in FILES {
            let file = native.inner.app.join(file);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "original").unwrap();
        }
        let chunk = native
            .inner
            .app
            .join("extensions/cursor-agent-host/dist/900.js");
        std::fs::write(&chunk, "control").unwrap();
        *native.inner.installed.lock().await = Some(native.fingerprint().unwrap());
        assert!(native.is_current().await);
        std::fs::write(&chunk, "updated control").unwrap();
        assert!(!native.is_current().await);
        *native.inner.installed.lock().await = Some(native.fingerprint().unwrap());
        std::fs::rename(&chunk, chunk.with_file_name("901.js")).unwrap();
        assert!(!native.is_current().await);
    }

    #[tokio::test]
    async fn reading_ready_status_never_installs_or_writes_connection() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        assert!(
            !store.cursor_takeover_enabled().await.unwrap(),
            "fresh installations require explicit takeover"
        );
        store.set_cursor_takeover_enabled(true).await.unwrap();
        let native_dir = directory.path().join("native");
        let native = NativeAgent {
            inner: Arc::new(Inner {
                app: directory.path().join("missing-installation"),
                directory: native_dir.clone(),
                key: "test-key".into(),
                installed: Mutex::new(None),
                catalog: Mutex::new(None),
            }),
        };
        let harness = CursorHarness {
            inner: Arc::new(crate::local_app::Inner {
                native,
                store: store.clone(),
                ca: CaManager::in_directory(directory.path().join("ca")),
                ca_initialization: Mutex::new(()),
                lifecycle: Arc::new(Mutex::new(())),
                update: crate::local_app::update::Runtime::new(directory.path().join("updates")),
                backend_addr: RwLock::new(Some("127.0.0.1:1".parse().unwrap())),
                tab_mode: Arc::new(RwLock::new(Default::default())),
                proxy: Mutex::new(ProxyRuntime::default()),
                clients: crate::network::NetworkClients::new(store.clone()),
            }),
        };
        for _ in 0..2 {
            let status = harness.status_with_ca(CaState::Ready).await.unwrap();
            assert!(matches!(status.integration, IntegrationState::Degraded));
            assert!(!native_dir.exists());
            assert!(store.cursor_takeover_enabled().await.unwrap());
        }
    }
}
