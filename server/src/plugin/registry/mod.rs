//! Orchestrates plugin capabilities: resources, model catalogs, and invocation.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_stream::try_stream;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use super::{
    catalog::{PluginCatalog, PluginEntry},
    data::PluginDataStore,
    descriptor::{
        parse_model_id, PluginDescriptor, PluginModelDescriptor, PluginProviderDescriptor,
        PluginResourceDescriptor, PluginResourceView, ProviderDefinition, ResourceActionResponse,
        ResourceActionResult, ResourceDefinition, ResourcePresentation, OAUTH2_ADD_METHOD,
        OAUTH2_AUTHORIZATION_CODE_ADD_METHOD,
    },
    oauth_callback::{self, CallbackHandle, CallbackOutcome, CallbackRequest},
    runtime::PluginRuntime,
    state::{now_ms, PluginStateStore, ResourceDraft, ResourcePatch, ResourceRecord, StoredModel},
    wire,
    worker::{PluginWorker, WorkerStreamItem},
};
use crate::{
    model::ModelInvocation,
    network::NetworkClients,
    provider::ProviderStream,
    provider::{CallRecorder, ModelEvent},
    Error, Result,
};

const OAUTH_SLOW_DOWN_STEP_MS: i64 = 5_000;
const MAX_IMPORT_DRAFTS: usize = 256;

#[derive(Clone)]
pub struct PluginRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    clients: NetworkClients,
    runtime: PluginRuntime,
    catalog: PluginCatalog,
    state: PluginStateStore,
    entries: RwLock<Option<Vec<PluginEntry>>>,
    workers: Mutex<HashMap<String, Arc<PluginWorker>>>,
    oauth_sessions: Mutex<HashMap<String, OAuthSession>>,
    preparation_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pending_preparations: Mutex<HashMap<String, (ResourceRecord, serde_json::Value)>>,
}

struct OAuthSession {
    plugin_id: String,
    resource_type: String,
    method_id: String,
    session: serde_json::Value,
    expires_at_ms: i64,
    poll_interval_ms: i64,
    next_poll_at_ms: i64,
    flow: OAuthFlow,
    cancellation: CancellationToken,
}

impl Drop for OAuthSession {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

enum OAuthFlow {
    DeviceCode,
    AuthorizationCode {
        redirect_uri: String,
        code_verifier: String,
        callback: CallbackHandle,
    },
}

enum OAuthPollWork {
    DeviceCode {
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        poll_interval_ms: i64,
    },
    AuthorizationCode {
        plugin_id: String,
        resource_type: String,
        method_id: String,
        session: serde_json::Value,
        redirect_uri: String,
        code_verifier: String,
        callback_request: CallbackRequest,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBeginResponse {
    pub session_id: String,
    pub user_code: Option<String>,
    pub verification_url: String,
    pub verification_url_complete: Option<String>,
    pub expires_at_ms: i64,
    pub poll_interval_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum OAuthPollResponse {
    #[serde(rename_all = "camelCase")]
    Pending { poll_interval_ms: i64 },
    #[serde(rename_all = "camelCase")]
    Completed {
        added: usize,
        updated: usize,
        model_sync_error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Denied { message: Option<String> },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub added: usize,
    pub updated: usize,
    pub warnings: Vec<String>,
    pub model_sync_error: Option<String>,
}

/// 路由分支在建立 Recorder 时需要的插件模型元数据。
#[derive(Clone, Debug)]
pub struct PluginInvocationPlan {
    pub model: PluginModelDescriptor,
    pub request_url: String,
}

impl PluginRegistry {
    pub fn managed(
        clients: NetworkClients,
        runtime: PluginRuntime,
        app_version: String,
    ) -> Result<Self> {
        Self::in_directory(
            clients,
            runtime,
            app_version,
            crate::config::managed_data_dir()?.join("plugins"),
        )
    }

    /// Use an explicit plugin root without reading or modifying the user's installation.
    pub fn in_directory(
        clients: NetworkClients,
        runtime: PluginRuntime,
        app_version: String,
        root: PathBuf,
    ) -> Result<Self> {
        let data = PluginDataStore::new(root.join("data"))?;
        Ok(Self {
            inner: Arc::new(RegistryInner {
                clients,
                runtime,
                catalog: PluginCatalog::in_directory(root, app_version)?,
                state: PluginStateStore::new(data),
                entries: RwLock::new(None),
                workers: Mutex::new(HashMap::new()),
                oauth_sessions: Mutex::new(HashMap::new()),
                preparation_locks: Mutex::new(HashMap::new()),
                pending_preparations: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub async fn remove(&self, plugin_id: &str) -> Result<()> {
        if let Some(worker) = self.inner.workers.lock().await.remove(plugin_id) {
            worker.stop().await;
        }
        self.inner.state.clear(plugin_id).await
    }

    fn executable(&self) -> Result<std::path::PathBuf> {
        self.inner
            .runtime
            .executable()
            .ok_or_else(|| Error::Config("plugin runtime is not ready".into()))
    }

    async fn entries(&self, executable: &Path) -> Vec<PluginEntry> {
        if let Some(entries) = self.inner.entries.read().await.as_ref() {
            return entries.clone();
        }
        let mut cache = self.inner.entries.write().await;
        if let Some(entries) = cache.as_ref() {
            return entries.clone();
        }
        let loaded = self.inner.catalog.entries(executable).await;
        *cache = Some(loaded.clone());
        drop(cache);
        for entry in &loaded {
            for resource in entry
                .definition
                .resources
                .iter()
                .filter(|resource| resource.can_prepare)
            {
                let registry = self.clone();
                let entry = entry.clone();
                let executable = executable.to_path_buf();
                let kind = resource.resource_type.clone();
                tokio::spawn(async move {
                    let records = registry
                        .inner
                        .state
                        .resources(&entry.manifest.id, &kind)
                        .await
                        .unwrap_or_default();
                    for record in records {
                        if let Err(error) = registry
                            .prepare_resource(&entry, &executable, &kind, record, None)
                            .await
                        {
                            tracing::warn!(plugin = %entry.manifest.id, %error, "startup credential preparation failed");
                        }
                    }
                });
            }
        }
        loaded
    }

    async fn find_entry(&self, executable: &Path, plugin_id: &str) -> Result<PluginEntry> {
        self.entries(executable)
            .await
            .into_iter()
            .find(|entry| entry.manifest.id == plugin_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin {plugin_id}")))
    }

    async fn worker(&self, entry: &PluginEntry, executable: &Path) -> Arc<PluginWorker> {
        let mut workers = self.inner.workers.lock().await;
        workers
            .entry(entry.manifest.id.clone())
            .or_insert_with(|| {
                Arc::new(PluginWorker::new(
                    entry,
                    executable.to_path_buf(),
                    self.inner.catalog.loader().clone(),
                    self.inner.clients.clone(),
                ))
            })
            .clone()
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2Begin {
    session: serde_json::Value,
    user_code: String,
    verification_url: String,
    #[serde(default)]
    verification_url_complete: Option<String>,
    expires_at_ms: i64,
    poll_interval_ms: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OAuth2AuthorizationCodeBegin {
    session: serde_json::Value,
    authorization_url: String,
    expires_at_ms: i64,
    #[serde(default)]
    poll_interval_ms: Option<i64>,
}

fn oauth_random_secret() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut bytes = [0_u8; 32];
    bytes[..16].copy_from_slice(first.as_bytes());
    bytes[16..].copy_from_slice(second.as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "kebab-case", tag = "status")]
enum OAuth2Poll {
    #[serde(rename_all = "camelCase")]
    Pending {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    SlowDown {
        #[serde(default)]
        session: Option<serde_json::Value>,
    },
    #[serde(rename_all = "camelCase")]
    Completed { resources: Vec<ResourceDraft> },
    #[serde(rename_all = "camelCase")]
    Denied {
        #[serde(default)]
        message: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportParseResult {
    resources: Vec<ResourceDraft>,
    #[serde(default)]
    warnings: Vec<String>,
}

fn find_provider<'a>(entry: &'a PluginEntry, provider_id: &str) -> Result<&'a ProviderDefinition> {
    entry
        .definition
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "plugin '{}' provider {provider_id}",
                entry.manifest.id
            ))
        })
}

fn find_resource<'a>(
    entry: &'a PluginEntry,
    resource_type: &str,
) -> Result<&'a ResourceDefinition> {
    entry
        .definition
        .resources
        .iter()
        .find(|resource| resource.resource_type == resource_type)
        .ok_or_else(|| {
            Error::RunNotFound(format!(
                "plugin '{}' resource type {resource_type}",
                entry.manifest.id
            ))
        })
}

fn should_retry_auth(status: &str, attempt: usize, emitted: bool) -> bool {
    status == "auth-error" && attempt == 0 && !emitted
}

mod authorization;
#[cfg(test)]
#[path = "../catalog_sync_tests.rs"]
mod catalog_sync_tests;
mod invoke;
mod models;
mod resources;
#[cfg(test)]
mod tests;
mod view;
