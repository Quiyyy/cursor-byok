//! Implements model configuration endpoints.
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::{
    model::{ModelConfig, ModelConfigInput},
    Result,
};

use super::{ControlState, DiscoveredModels, ModelConnectivityResult, ModelDiscoveryInput};

#[derive(Deserialize)]
pub struct SaveModels {
    pub models: Vec<ModelConfigInput>,
}

#[derive(Deserialize)]
pub struct ModelOrder {
    pub model_hashes: Vec<String>,
}

pub async fn list(State(service): State<ControlState>) -> Result<Json<Vec<ModelConfig>>> {
    Ok(Json(service.store.models().await?))
}

pub async fn all_settings(
    State(service): State<ControlState>,
) -> Result<Json<std::collections::BTreeMap<String, ModelSettingsView>>> {
    Ok(Json(service.all_model_settings().await?))
}

pub async fn settings(
    State(service): State<ControlState>,
    Path(id): Path<String>,
) -> Result<Json<ModelSettingsView>> {
    Ok(Json(service.model_settings(&id).await?))
}

pub async fn update_settings(
    State(service): State<ControlState>,
    Path(id): Path<String>,
    Json(settings): Json<crate::store::ModelSettings>,
) -> Result<Json<ModelSettingsView>> {
    Ok(Json(service.set_model_settings(&id, settings).await?))
}

pub async fn create(
    State(service): State<ControlState>,
    Json(input): Json<SaveModels>,
) -> Result<(StatusCode, Json<Vec<ModelConfig>>)> {
    Ok((
        StatusCode::CREATED,
        Json(service.store.create_models(&input.models).await?),
    ))
}

pub async fn reorder(
    State(service): State<ControlState>,
    Json(input): Json<ModelOrder>,
) -> Result<Json<Vec<ModelConfig>>> {
    Ok(Json(
        service.store.reorder_models(&input.model_hashes).await?,
    ))
}

pub async fn remove(
    State(service): State<ControlState>,
    Path(model_hash): Path<String>,
) -> Result<StatusCode> {
    service.store.delete_model(&model_hash).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update(
    State(service): State<ControlState>,
    Path(model_hash): Path<String>,
    Json(input): Json<ModelConfigInput>,
) -> Result<Json<ModelConfig>> {
    Ok(Json(service.store.update_model(&model_hash, &input).await?))
}

pub async fn test(
    State(service): State<ControlState>,
    Path((model_hash, test_id)): Path<(String, String)>,
) -> Result<Json<ModelConnectivityResult>> {
    Ok(Json(service.test_model(&model_hash, &test_id).await?))
}

pub async fn cancel(
    State(service): State<ControlState>,
    Path((_model_hash, test_id)): Path<(String, String)>,
) -> Result<StatusCode> {
    service.cancel_model_test(&test_id);
    Ok(StatusCode::NO_CONTENT)
}

pub async fn discover(
    State(service): State<ControlState>,
    Json(input): Json<ModelDiscoveryInput>,
) -> Result<Json<DiscoveredModels>> {
    Ok(Json(service.discover_models(&input).await?))
}
#[derive(Clone, Debug, Serialize)]
pub struct ModelSettingsView {
    #[serde(flatten)]
    pub settings: crate::store::ModelSettings,
    pub default_context_window_tokens: u64,
}

impl ControlState {
    pub async fn model_settings(&self, id: &str) -> Result<ModelSettingsView> {
        let model = crate::configured_models::resolve(&self.store, &self.plugins, id).await?;
        Ok(ModelSettingsView {
            settings: crate::store::ModelSettings {
                context_window_tokens: model.context_override,
            },
            default_context_window_tokens: model.default_context,
        })
    }

    pub async fn all_model_settings(&self) -> Result<BTreeMap<String, ModelSettingsView>> {
        Ok(
            crate::configured_models::list(&self.store, Some(&self.plugins))
                .await?
                .into_iter()
                .map(|model| {
                    (
                        model.id,
                        ModelSettingsView {
                            settings: crate::store::ModelSettings {
                                context_window_tokens: model.context_override,
                            },
                            default_context_window_tokens: model.default_context,
                        },
                    )
                })
                .collect(),
        )
    }

    pub async fn set_model_settings(
        &self,
        id: &str,
        settings: crate::store::ModelSettings,
    ) -> Result<ModelSettingsView> {
        let mut view = self.model_settings(id).await?;
        view.settings = self.store.set_model_settings(id, settings).await?;
        Ok(view)
    }
}
