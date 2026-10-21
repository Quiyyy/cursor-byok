//! Uses Cursor's default-model RPCs; never changes an existing conversation.
use axum::{
    body::{to_bytes, Body},
    extract::{Extension, State},
    http::{header, Request, Response},
};
use prost::Message;

use super::CursorServices;
use crate::{
    api::cursor::proxy::{self, CursorProxy},
    plugin::PluginRegistry,
    store::Store,
    Error, Result,
};

#[derive(Clone, PartialEq, Message)]
struct DefaultModelResponse {
    #[prost(string, tag = "1")]
    model: String,
    #[prost(string, tag = "2")]
    thinking_model: String,
    #[prost(bool, tag = "3")]
    max_mode: bool,
    #[prost(string, tag = "4")]
    next_default_set_date: String,
}

#[derive(Clone, PartialEq, Message)]
struct ModelNudgeResponse {
    #[prost(string, tag = "1")]
    nudge_date: String,
    #[prost(bool, tag = "2")]
    should_default_switch_on_new_chat: bool,
}

pub(crate) async fn validate(
    store: &Store,
    plugins: Option<&PluginRegistry>,
    id: &str,
) -> Result<()> {
    if !id.is_empty() && store.model(id).await?.is_some() {
        return Ok(());
    }
    if id.starts_with(crate::plugin::ADAPTER_ID_PREFIX) {
        if let Some(plugins) = plugins {
            if plugins.configured_models().await.iter().any(|m| m.id == id) {
                return Ok(());
            }
        }
    }
    Err(Error::Config(
        "Cursor default model is unavailable; select an enabled model in BYOK settings".into(),
    ))
}

pub async fn get_default_model(
    State(services): State<CursorServices>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let settings = services.store().cursor_model_settings().await?;
    if settings.model_id.is_empty() {
        return proxy::forward(Extension(proxy), request).await;
    }
    validate(services.store(), services.plugins(), &settings.model_id).await?;
    let id = format!("byok:{}", settings.model_id);
    respond(
        request,
        DefaultModelResponse {
            model: id.clone(),
            thinking_model: id,
            max_mode: false,
            next_default_set_date: settings.updated_at_ms.to_string(),
        },
    )
    .await
}

pub async fn get_model_nudge(
    State(services): State<CursorServices>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    if services
        .store()
        .cursor_model_settings()
        .await?
        .model_id
        .is_empty()
    {
        return proxy::forward(Extension(proxy), request).await;
    }
    // A new-chat nudge resets the native model to "default" (Auto), not the
    // configured model. Disable it; keep Cursor's explicit per-chat selection.
    respond(
        request,
        ModelNudgeResponse {
            nudge_date: "0".into(),
            should_default_switch_on_new_chat: false,
        },
    )
    .await
}

async fn respond(request: Request<Body>, message: impl Message) -> Result<Response<Body>> {
    to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|e| Error::Protocol(e.to_string()))?;
    let mut response = Response::new(Body::from(message.encode_to_vec()));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/proto".parse().unwrap());
    Ok(response)
}
