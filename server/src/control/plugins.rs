//! Exposes plugin discovery, resource lifecycle, model sync, and runtime endpoints.
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};

use crate::{
    plugin::{
        ImportResponse, OAuthBeginResponse, OAuthPollResponse, PluginDescriptor,
        PluginRuntimeStatus,
    },
    Result,
};

use super::ControlState;

pub async fn list(State(service): State<ControlState>) -> Result<Json<Vec<PluginDescriptor>>> {
    Ok(Json(service.plugins.plugins().await))
}

pub async fn remove(
    State(service): State<ControlState>,
    Path(plugin_id): Path<String>,
) -> Result<StatusCode> {
    service.plugins.remove(&plugin_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn oauth_begin(
    State(service): State<ControlState>,
    Path((plugin_id, resource_type, method_id)): Path<(String, String, String)>,
    Query(query): Query<OAuthSelection>,
) -> Result<Json<OAuthBeginResponse>> {
    Ok(Json(
        service
            .plugins
            .oauth_begin(
                &plugin_id,
                &resource_type,
                &method_id,
                query.resource_id.as_deref(),
            )
            .await?,
    ))
}

#[derive(serde::Deserialize)]
pub struct OAuthSelection {
    resource_id: Option<String>,
}

pub async fn oauth_poll(
    State(service): State<ControlState>,
    Path(session_id): Path<String>,
) -> Result<Json<OAuthPollResponse>> {
    Ok(Json(service.plugins.oauth_poll(&session_id).await?))
}

pub async fn oauth_cancel(
    State(service): State<ControlState>,
    Path(session_id): Path<String>,
) -> StatusCode {
    service.plugins.oauth_cancel(&session_id).await;
    StatusCode::NO_CONTENT
}

pub async fn import(
    State(service): State<ControlState>,
    Path((plugin_id, resource_type)): Path<(String, String)>,
    Json(files): Json<serde_json::Value>,
) -> Result<Json<ImportResponse>> {
    Ok(Json(
        service
            .plugins
            .import_resources(&plugin_id, &resource_type, files)
            .await?,
    ))
}

/// 以附件形式返回账号资源导出文件,便于浏览器直接下载。
pub async fn export_resources(
    State(service): State<ControlState>,
    Path((plugin_id, resource_type)): Path<(String, String)>,
) -> Result<axum::response::Response> {
    let value = service
        .plugins
        .export_resources(&plugin_id, &resource_type)
        .await?;
    let body = serde_json::to_vec_pretty(&value)?;
    let response = axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{plugin_id}-{resource_type}.json\""),
        )
        .body(axum::body::Body::from(body))
        .expect("static export response");
    Ok(response)
}

pub async fn refresh_resource(
    State(service): State<ControlState>,
    Path((plugin_id, resource_type, resource_id)): Path<(String, String, String)>,
) -> Result<StatusCode> {
    service
        .plugins
        .refresh_resource(&plugin_id, &resource_type, &resource_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn action(
    State(service): State<ControlState>,
    Path((plugin_id, resource_type, resource_id, action_id)): Path<(
        String,
        String,
        String,
        String,
    )>,
    Json(input): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    Ok(Json(
        service
            .plugins
            .resource_action(&plugin_id, &resource_type, &resource_id, &action_id, input)
            .await?,
    ))
}

pub async fn delete_resource(
    State(service): State<ControlState>,
    Path((plugin_id, resource_type, resource_id)): Path<(String, String, String)>,
) -> Result<StatusCode> {
    service
        .plugins
        .delete_resource(&plugin_id, &resource_type, &resource_id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn sync_models(
    State(service): State<ControlState>,
    Path((plugin_id, provider_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>> {
    let count = service
        .plugins
        .sync_models(&plugin_id, &provider_id)
        .await?;
    Ok(Json(serde_json::json!({ "models": count })))
}

pub async fn set_model_enabled(
    State(service): State<ControlState>,
    Path((plugin_id, provider_id)): Path<(String, String)>,
    Json(input): Json<serde_json::Value>,
) -> Result<StatusCode> {
    let model_id = input
        .get("modelId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| crate::Error::Config("modelId must be a string".into()))?;
    let enabled = input
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| crate::Error::Config("enabled must be a boolean".into()))?;
    service
        .plugins
        .set_model_enabled(&plugin_id, &provider_id, model_id, enabled)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn runtime_status(
    State(service): State<ControlState>,
) -> Result<Json<PluginRuntimeStatus>> {
    Ok(Json(service.plugin_runtime.status()))
}

pub async fn initialize_runtime(
    State(service): State<ControlState>,
) -> Result<Json<PluginRuntimeStatus>> {
    Ok(Json(
        service.plugin_runtime.initialize(service.store.clone()),
    ))
}

pub async fn cancel_runtime_initialization(
    State(service): State<ControlState>,
) -> Result<Json<PluginRuntimeStatus>> {
    Ok(Json(service.plugin_runtime.cancel_initialization()))
}
