//! Exposes Cursor services outside the Agent loop.

pub mod account;
pub mod commit_message;
pub mod compatibility;
pub mod default_model;
pub(crate) mod entitlement;
pub mod model_catalog;
pub mod observability;
pub mod tab;

/// Dependencies for model catalog, TAB and Commit RPCs; no Agent lifecycle.
#[derive(Clone)]
pub struct CursorServices {
    store: crate::store::Store,
    provider: std::sync::Arc<dyn crate::provider::Provider>,
    plugins: Option<crate::plugin::PluginRegistry>,
    native: Option<crate::local_app::NativeAgent>,
}
impl CursorServices {
    pub fn new(
        store: crate::store::Store,
        provider: std::sync::Arc<dyn crate::provider::Provider>,
        plugins: Option<crate::plugin::PluginRegistry>,
    ) -> Self {
        Self {
            store,
            provider,
            plugins,
            native: None,
        }
    }
    pub fn with_native(mut self, native: crate::local_app::NativeAgent) -> Self {
        self.native = Some(native);
        self
    }
    pub(crate) fn native(&self) -> crate::Result<&crate::local_app::NativeAgent> {
        self.native
            .as_ref()
            .ok_or_else(|| crate::Error::Config("native Cursor integration is not ready".into()))
    }
    pub fn store(&self) -> &crate::store::Store {
        &self.store
    }
    pub fn plugins(&self) -> Option<&crate::plugin::PluginRegistry> {
        self.plugins.as_ref()
    }
    pub fn provider(&self) -> &std::sync::Arc<dyn crate::provider::Provider> {
        &self.provider
    }
}
