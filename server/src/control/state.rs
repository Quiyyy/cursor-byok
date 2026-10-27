//! Shared dependencies; application assembly owns their lifecycles.
use crate::{
    local_app::CursorHarness,
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
    provider::Provider,
    store::Store,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct ControlState {
    pub(super) store: Store,
    pub(super) harness: CursorHarness,
    pub(super) provider: Arc<dyn Provider>,
    pub(super) plugin_runtime: PluginRuntime,
    pub(super) plugins: PluginRegistry,
    pub(super) clients: NetworkClients,
    pub(super) model_tests: Arc<Mutex<BTreeMap<String, CancellationToken>>>,
}
impl ControlState {
    pub fn new(
        store: Store,
        provider: Arc<dyn Provider>,
        plugin_runtime: PluginRuntime,
        plugins: PluginRegistry,
        clients: NetworkClients,
        harness: CursorHarness,
    ) -> Self {
        Self {
            store,
            harness,
            provider,
            plugin_runtime,
            plugins,
            clients,
            model_tests: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}
