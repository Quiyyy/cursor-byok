//! One metadata view of configured API and account models. No credentials or wire encoding.
use crate::{
    model::{self, ModelConfig, ProviderType},
    plugin::{PluginModelDescriptor, PluginRegistry},
    store::Store,
    Error, Result,
};

pub struct ConfiguredModel {
    pub id: String,
    pub external_id: String,
    pub model_id: String,
    pub display_name: String,
    pub source: String,
    pub protocol: ProviderType,
    pub context_override: Option<u64>,
    pub default_context: u64,
    pub context: u64,
    pub max_output_tokens: Option<u64>,
    pub images: bool,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
    pub supports_fast: bool,
}

impl ConfiguredModel {
    fn api(model: ModelConfig) -> Self {
        let source = model.group_name.clone().unwrap_or_else(|| {
            url::Url::parse(&model.base_url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_owned))
                .unwrap_or_else(|| model.base_url.clone())
        });
        Self {
            external_id: format!("{source}/{}", model.model_id),
            protocol: model.provider_type(),
            max_output_tokens: model.max_output_tokens(),
            default_context: model::default_context_window(&model.model_id, None),
            context: model::effective_context_window(
                &model.model_id,
                model.context_window_tokens,
                None,
            ),
            context_override: model.context_window_tokens,
            id: model.model_hash,
            model_id: model.model_id,
            display_name: model.display_name,
            source,
            images: true,
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
            supports_fast: false,
        }
    }

    async fn account(store: &Store, model: PluginModelDescriptor) -> Result<Self> {
        let context_override = store.model_settings(&model.id).await?.context_window_tokens;
        Ok(Self {
            external_id: format!(
                "plugin:{}:{}/{}",
                model.plugin_id, model.provider_id, model.model_id
            ),
            protocol: ProviderType::Plugin,
            default_context: model::default_context_window(
                &model.model_id,
                model.context_window_tokens,
            ),
            context: model::effective_context_window(
                &model.model_id,
                context_override,
                model.context_window_tokens,
            ),
            context_override,
            id: model.id,
            model_id: model.model_id,
            display_name: model.display_name,
            source: model.plugin_name,
            max_output_tokens: model.max_output_tokens,
            images: model.images,
            reasoning_efforts: model.reasoning_efforts,
            default_reasoning_effort: model.default_reasoning_effort,
            supports_fast: model.supports_fast,
        })
    }
}

pub async fn list(store: &Store, plugins: Option<&PluginRegistry>) -> Result<Vec<ConfiguredModel>> {
    let mut api = store.models().await?;
    api.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.display_name.cmp(&b.display_name))
            .then_with(|| a.model_hash.cmp(&b.model_hash))
    });
    let mut models: Vec<_> = api.into_iter().map(ConfiguredModel::api).collect();
    if let Some(plugins) = plugins {
        for model in plugins.configured_models().await {
            models.push(ConfiguredModel::account(store, model).await?);
        }
    }
    Ok(models)
}

pub async fn resolve(store: &Store, plugins: &PluginRegistry, id: &str) -> Result<ConfiguredModel> {
    if id.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
        ConfiguredModel::account(store, plugins.model_descriptor(id).await?).await
    } else {
        store
            .model(id)
            .await?
            .map(ConfiguredModel::api)
            .ok_or_else(|| Error::RunNotFound(format!("model {id}")))
    }
}
