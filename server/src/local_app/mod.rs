//! Exposes the local desktop application integration.
mod account;
mod ca;
mod native_agent;
mod process;
mod proxy;
mod settings;
#[cfg(test)]
mod tests;
pub mod update;
pub use native_agent::NativeAgent;

use std::{
    future::Future,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{
    store::{Store, TabMode, TabSettings},
    Error, Result,
};

use self::{ca::CaManager, proxy::ProxyRuntime};

pub(crate) fn proxy_host_allowed(host: &str) -> bool {
    proxy::is_cursor_host(host)
}

pub(crate) fn request_uses_local_cursor_token(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(account::is_local_cursor_authorization)
}

#[cfg(test)]
pub(crate) fn local_cursor_authorization() -> String {
    format!("Bearer {}", account::local_token().unwrap())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaState {
    Missing,
    Untrusted,
    Ready,
    Invalid,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationState {
    Disabled,
    Enabled,
    Degraded,
}

#[derive(Clone, Debug, Serialize)]
pub struct CursorHarnessStatus {
    pub platform: &'static str,
    pub ca: CaState,
    pub configured_models: usize,
    pub enabled_models: usize,
    pub integration: IntegrationState,
    pub settings_applied: bool,
    pub proxy_url: Option<String>,
    pub ca_install_command: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct SetEnabled {
    pub enabled: bool,
}

#[derive(Clone)]
pub struct CursorHarness {
    inner: Arc<Inner>,
}

struct Inner {
    native: NativeAgent,
    store: Store,
    ca: CaManager,
    ca_initialization: Mutex<()>,
    backend_addr: RwLock<Option<SocketAddr>>,
    tab_mode: Arc<RwLock<TabMode>>,
    proxy: Mutex<ProxyRuntime>,
    restart_required: AtomicBool,
    operation: Arc<Mutex<()>>,
    update: update::Runtime,
}

impl CursorHarness {
    pub fn new(store: Store) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(Inner {
                native: NativeAgent::managed()?,
                store,
                ca: CaManager::managed()?,
                ca_initialization: Mutex::new(()),
                backend_addr: RwLock::new(None),
                tab_mode: Arc::new(RwLock::new(TabMode::default())),
                proxy: Mutex::new(ProxyRuntime::default()),
                restart_required: AtomicBool::new(false),
                operation: Arc::new(Mutex::new(())),
                update: update::Runtime::new(
                    crate::config::managed_data_dir()?.join("cursor-update"),
                ),
            }),
        })
    }

    pub fn set_backend_addr(&self, addr: SocketAddr) {
        *self.inner.backend_addr.write() = Some(addr);
    }

    pub fn native_agent(&self) -> NativeAgent {
        self.inner.native.clone()
    }

    pub async fn proxy_port(&self) -> Option<u16> {
        self.inner.proxy.lock().await.port()
    }

    pub async fn cleanup_stale_settings(&self) -> Result<()> {
        settings::clear_stale_managed_settings()
    }

    pub async fn restore(&self) -> Result<()> {
        let _operation = self.inner.operation.lock().await;
        self.restore_cursor_update_settings().await?;
        if self.inner.update.pending() {
            if let Err(error) = self.recover_cursor_update_locked().await {
                self.inner.update.failed(&error);
                return Err(error);
            }
        }
        restore_saved_takeover(&self.inner.store, self.enable()).await
    }

    pub async fn status(&self) -> Result<CursorHarnessStatus> {
        let models = self.inner.store.models().await?;
        let configured_models = models.len();
        let enabled_models = configured_models;
        let ca = self.inner.ca.state()?;
        let native_ready = self.inner.native.is_installed().await;
        let proxy = self.inner.proxy.lock().await;
        let proxy_url = proxy.url();
        let settings_applied = proxy_url
            .as_deref()
            .map(settings::settings_match)
            .transpose()?
            .unwrap_or(false);
        let integration = match (proxy.running(), settings_applied) {
            (false, false) => IntegrationState::Disabled,
            (true, true) if native_ready => IntegrationState::Enabled,
            _ => IntegrationState::Degraded,
        };
        Ok(CursorHarnessStatus {
            platform: std::env::consts::OS,
            ca,
            configured_models,
            enabled_models,
            integration,
            settings_applied,
            proxy_url,
            ca_install_command: self.inner.ca.install_command(),
        })
    }

    pub async fn initialize_ca(&self) -> Result<CursorHarnessStatus> {
        let _initialization = self.inner.ca_initialization.lock().await;
        let manager = self.inner.ca.clone();
        tokio::task::spawn_blocking(move || manager.initialize_local())
            .await
            .map_err(|error| Error::Store(format!("CA initialization task failed: {error}")))??;
        self.status().await
    }

    pub async fn set_enabled(&self, enabled: bool) -> Result<CursorHarnessStatus> {
        let _operation = self
            .inner
            .operation
            .try_lock()
            .map_err(|_| Error::Busy("Cursor takeover or update is in progress".into()))?;
        self.inner.update.ensure_accepting()?;
        if enabled && self.inner.update.pending() {
            return Err(Error::Busy(
                "Recover the interrupted Cursor update first".into(),
            ));
        }
        if enabled {
            if let Err(error) = self.enable().await {
                let _ = self.inner.store.set_cursor_takeover_enabled(false).await;
                if let Err(cleanup) = self.disable_locked().await {
                    tracing::warn!(%cleanup, "failed to clean up unsuccessful Cursor takeover");
                }
                return Err(error);
            }
            if let Err(error) = self.inner.store.set_cursor_takeover_enabled(true).await {
                let _ = self.disable_locked().await;
                return Err(error);
            }
        } else {
            self.inner.store.set_cursor_takeover_enabled(false).await?;
            self.disable_locked().await?;
        }
        self.status().await
    }

    pub async fn set_tab_settings(&self, settings: TabSettings) -> Result<TabSettings> {
        let saved = self.inner.store.set_tab_settings(settings).await?;
        *self.inner.tab_mode.write() = saved.mode;
        Ok(saved)
    }

    async fn enable(&self) -> Result<()> {
        if !matches!(self.inner.ca.state()?, CaState::Ready) {
            return Err(Error::Config(
                "initialize and trust the CA before enabling Cursor".into(),
            ));
        }
        let backend_addr = self
            .inner
            .backend_addr
            .read()
            .ok_or_else(|| Error::Config("desktop management server is not ready".into()))?;
        let proxy = self.inner.proxy.lock().await;
        let native_changed = self.inner.native.enable(backend_addr).await?;
        let settings_applied = proxy
            .url()
            .as_deref()
            .map(settings::settings_match)
            .transpose()?
            .unwrap_or(false);
        close_cursor_if_needed(
            &self.inner.restart_required,
            !settings_applied || native_changed,
            process::terminate_cursor(),
        )
        .await?;
        drop(proxy);
        self.enable_transport(backend_addr).await
    }

    async fn enable_transport(&self, backend_addr: SocketAddr) -> Result<()> {
        let mut proxy = self.inner.proxy.lock().await;
        if proxy.running() {
            if let Some(url) = proxy.url() {
                apply_cursor_configuration(&url).await?;
            }
            return Ok(());
        }
        let ca = self.inner.ca.load()?;
        let requested_port = self.inner.store.port_settings().await?.proxy_port;
        *self.inner.tab_mode.write() = self.inner.store.tab_settings().await?.mode;
        let (url, actual_port) = proxy
            .start(
                backend_addr,
                ca,
                requested_port,
                self.inner.tab_mode.clone(),
            )
            .await?;
        if let Err(error) = self.inner.store.set_proxy_port(actual_port).await {
            proxy.stop().await;
            return Err(error);
        }
        if let Err(error) = apply_cursor_configuration(&url).await {
            proxy.stop().await;
            return Err(error);
        }
        Ok(())
    }

    pub async fn disable(&self) -> Result<()> {
        self.inner.update.stop();
        let _operation = self.inner.operation.lock().await;
        self.inner.update.cancel_check();
        self.disable_locked().await
    }
    async fn disable_locked(&self) -> Result<()> {
        let native = if self.inner.update.pending() {
            self.inner.native.deactivate().await
        } else {
            self.inner.native.disable().await
        };
        let settings = settings::clear_proxy_settings();
        self.inner.proxy.lock().await.stop().await;
        native?;
        settings
    }
}

async fn restore_saved_takeover(
    store: &Store,
    restore: impl Future<Output = Result<()>>,
) -> Result<()> {
    if store.cursor_takeover_enabled().await? {
        restore.await?;
    }
    Ok(())
}

async fn close_cursor_if_needed(
    pending: &AtomicBool,
    changed: bool,
    terminate: impl Future<Output = Result<()>>,
) -> Result<()> {
    if changed {
        pending.store(true, Ordering::Relaxed);
    }
    if pending.load(Ordering::Relaxed) {
        terminate.await.map_err(|error| {
            Error::Config(format!(
                "无法自动关闭 Cursor 以应用接管，请完全退出 Cursor 后重试开启接管：{error}"
            ))
        })?;
        pending.store(false, Ordering::Relaxed);
    }
    Ok(())
}

async fn apply_cursor_configuration(proxy_url: &str) -> Result<()> {
    account::inject_if_missing().await?;
    settings::write_proxy_settings(proxy_url)
}
