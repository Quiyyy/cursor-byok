//! Installs native routing and new-conversation defaults; never owns Agent state or tools.
use crate::{Error, Result};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::sync::Mutex;

const INSTALLER: &str = include_str!("../../native-agent/install.bundle.mjs");
const BRIDGE: &str = include_str!("../../native-agent/route.cjs");
const NOTICES: &str = include_str!("../../native-agent/THIRD_PARTY_LICENSES.txt");
const FILES: [&str; 4] = [
    "extensions/cursor-agent-host/dist/main.js",
    "extensions/cursor-local-agent-runtime/dist/main.js",
    "out/vs/workbench/workbench.desktop.main.js",
    "product.json",
];
type Fingerprint = Vec<(SystemTime, u64)>;
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
    pub fn managed() -> Result<Self> {
        let app = installed_app_path()?;
        Ok(Self {
            inner: Arc::new(Inner {
                app,
                directory: crate::config::managed_data_dir()?.join("native-agent"),
                key: uuid::Uuid::new_v4().to_string(),
                installed: Mutex::new(None),
                catalog: Mutex::new(None),
            }),
        })
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
        let fingerprint = self.fingerprint()?;
        let mut cache = self.inner.catalog.lock().await;
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
        FILES
            .iter()
            .map(|file| {
                let m = std::fs::metadata(self.inner.app.join(file))?;
                Ok((m.modified()?, m.len()))
            })
            .collect()
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
        let script = self.inner.directory.join("install.mjs");
        write_asset(&script, INSTALLER)?;
        write_asset(self.inner.directory.join("route.cjs"), BRIDGE)?;
        write_asset(
            self.inner.directory.join("THIRD_PARTY_LICENSES.txt"),
            NOTICES,
        )?;
        let mut command = tokio::process::Command::new(cursor_executable(&self.inner.app));
        command
            .arg(&script)
            .arg(&self.inner.app)
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
        let output =
            tokio::time::timeout(std::time::Duration::from_secs(45), child.wait_with_output())
                .await
                .map_err(|_| {
                    Error::Config("Cursor native entry installation timed out".into())
                })??;
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
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    #[tokio::test]
    async fn native_gateway_is_independently_authorized_and_scopes_same_named_models() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let runtime =
            crate::plugin::PluginRuntime::in_directory(directory.path().join("runtime")).unwrap();
        let plugins = crate::plugin::PluginRegistry::in_directory(
            store.clone(),
            runtime,
            "test".into(),
            directory.path().join("plugins"),
        )
        .unwrap();
        let clients = crate::network::NetworkClients::new(store.clone());
        let provider = Arc::new(crate::provider::ProviderRouter::new(
            store.clone(),
            plugins.clone(),
            clients.clone(),
            std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(1),
        ));
        let agent = NativeAgent {
            inner: Arc::new(Inner {
                app: directory.path().join("unused-cursor"),
                directory: directory.path().join("native"),
                key: "native-test-key".into(),
                installed: Mutex::new(None),
                catalog: Mutex::new(None),
            }),
        };
        let mut ids = Vec::new();
        for port in [1, 2] {
            let input=serde_json::from_value(json!({"display_name":"Same model","type":"openai","base_url":format!("http://127.0.0.1:{port}/v1"),"api_key":"provider-secret","tooltip_data":"test","model_id":"grok-4.6","openai_endpoint":"/v1/chat/completions","context_window_tokens":200000})).unwrap();
            ids.push(store.create_model(&input).await.unwrap().model_hash);
        }
        assert_ne!(ids[0], ids[1]);
        assert!(!store.external_api_settings().await.unwrap().enabled);
        let router = crate::api::byok::native_router(
            store.clone(),
            plugins,
            provider,
            crate::api::byok::NativeForwarder::new(
                store.clone(),
                clients,
                std::time::Duration::from_secs(1),
                std::time::Duration::from_secs(1),
            ),
            agent,
        );
        let request = |id: &str, key: &str| {
            Request::get(format!("/__byok-native__/models/byok:{id}/v1/models"))
                .header("authorization", format!("Bearer {key}"))
                .body(Body::empty())
                .unwrap()
        };
        store.set_cursor_takeover_enabled(false).await.unwrap();
        assert_eq!(
            router
                .clone()
                .oneshot(request(&ids[0], "native-test-key"))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        store.set_cursor_takeover_enabled(true).await.unwrap();
        assert_eq!(
            router
                .clone()
                .oneshot(request(&ids[0], "wrong-key"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        for id in &ids {
            let response = router
                .clone()
                .oneshot(request(id, "native-test-key"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["data"][0]["id"], "grok-4.6");
            assert_eq!(value["data"][0]["capabilities"]["context_length"], 200000);
            assert_eq!(value["data"][0]["api_types"], json!(["openai_chat"]));
            assert!(!String::from_utf8_lossy(&bytes).contains("provider-secret"));
        }
        for (context, expected) in [
            (Some(200000), 200000),
            (Some(1000000), 1000000),
            (None, 500000),
        ] {
            store
                .set_model_settings(
                    &ids[0],
                    crate::store::ModelSettings {
                        context_window_tokens: context,
                    },
                )
                .await
                .unwrap();
            let response = router
                .clone()
                .oneshot(request(&ids[0], "native-test-key"))
                .await
                .unwrap();
            let metadata: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap())
                    .unwrap();
            assert_eq!(
                metadata["data"][0]["capabilities"]["context_length"],
                json!(expected)
            );
            let response = router
                .clone()
                .oneshot(
                    Request::get(format!("/__byok-native__/models/byok:{}", ids[0]))
                        .header("authorization", "Bearer native-test-key")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let resolved: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap())
                    .unwrap();
            assert_eq!(resolved["contextWindowTokens"], json!(expected));
        }
        let response = router
            .oneshot(
                Request::post(format!(
                    "/__byok-native__/models/byok:{}/v1/chat/completions",
                    ids[0]
                ))
                .header("authorization", "Bearer native-test-key")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"model":"wrong","messages":[]}"#))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
