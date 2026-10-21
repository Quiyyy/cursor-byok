//! Authenticated model-only gateway used by Cursor's complete native Agent runtime.
use super::{
    api_error, authorized, invoke, models::ListedModel, protocol::Protocol, ApiState,
    NativeForwarder,
};
use crate::{
    local_app::NativeAgent, plugin::PluginRegistry, provider::Provider, store::Store, Error, Result,
};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub fn router(
    store: Store,
    plugins: PluginRegistry,
    provider: Arc<dyn Provider>,
    forwarder: NativeForwarder,
    agent: NativeAgent,
) -> Router {
    Router::new()
        .route("/__byok-native__/models/{id}", get(resolve))
        .route("/__byok-native__/models/{id}/v1/models", get(metadata))
        .route(
            "/__byok-native__/models/{id}/v1/chat/completions",
            post(chat),
        )
        .route("/__byok-native__/models/{id}/v1/responses", post(responses))
        .route("/__byok-native__/models/{id}/v1/messages", post(messages))
        .route(
            "/__byok-native__/models/{id}/v1/images/generations",
            post(images),
        )
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(ApiState {
            store,
            plugins,
            provider,
            native: Some(forwarder),
            agent: Some(agent),
        })
}

async fn lookup(state: &ApiState, id: &str) -> Result<(ListedModel, Value)> {
    let internal = id
        .strip_prefix("byok:")
        .ok_or_else(|| Error::Protocol("expected a BYOK model identifier".into()))?;
    let (model_id, name, apis, context, output, images) =
        if let Some(model) = state.store.model(internal).await? {
            let api = match model.provider_type() {
                crate::model::ProviderType::Anthropic => "anthropic_messages",
                crate::model::ProviderType::OpenAiResponses => "openai_responses",
                _ => "openai_chat",
            };
            let output = model.max_completion_tokens.or(model.anthropic_max_tokens);
            (
                model.model_id,
                model.display_name,
                vec![api],
                model.context_window_tokens,
                output,
                true,
            )
        } else {
            let model = state.plugins.model_descriptor(internal).await?;
            (
                model.model_id,
                model.display_name,
                vec!["openai_chat", "openai_responses"],
                state
                    .store
                    .model_settings(internal)
                    .await?
                    .context_window_tokens,
                model.max_output_tokens,
                model.images,
            )
        };
    let mut capabilities =
        json!({"supports_tool_use":true,"supports_streaming":true,"supports_vision":images});
    if let Some(n) = context {
        capabilities["context_length"] = json!(n);
    }
    if let Some(n) = output {
        capabilities["max_output_tokens"] = json!(n);
    }
    let metadata =
        json!({"id":model_id,"object":"model","api_types":apis,"capabilities":capabilities});
    Ok((
        ListedModel {
            public_id: model_id,
            internal_id: internal.into(),
            display_name: name,
        },
        metadata,
    ))
}
async fn resolve(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = authorized(&state, &headers).await {
        return *e;
    }
    match lookup(&state, &id).await {
        Ok((model, metadata)) => Json(json!({"modelId":model.public_id,"contextWindowTokens":metadata.pointer("/capabilities/context_length")})).into_response(),
        Err(e) => api_error(StatusCode::NOT_FOUND, e),
    }
}
async fn metadata(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = authorized(&state, &headers).await {
        return *e;
    }
    match lookup(&state, &id).await {
        Ok((_, metadata)) => Json(json!({"object":"list","data":[metadata]})).into_response(),
        Err(e) => api_error(StatusCode::NOT_FOUND, e),
    }
}
async fn generate(
    state: ApiState,
    id: String,
    headers: HeaderMap,
    body: Value,
    protocol: Protocol,
) -> Response {
    if let Err(e) = authorized(&state, &headers).await {
        return *e;
    }
    let model = match lookup(&state, &id).await {
        Ok((model, _)) => model,
        Err(e) => return api_error(StatusCode::NOT_FOUND, e),
    };
    if body.get("model").and_then(Value::as_str) != Some(&model.public_id) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "request model does not match the selected route",
        );
    }
    invoke(state, headers, body, protocol, model, "native-agent").await
}
async fn chat(
    State(s): State<ApiState>,
    Path(id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Response {
    generate(s, id, h, b, Protocol::Chat).await
}
async fn responses(
    State(s): State<ApiState>,
    Path(id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Response {
    generate(s, id, h, b, Protocol::Responses).await
}
async fn messages(
    State(s): State<ApiState>,
    Path(id): Path<String>,
    h: HeaderMap,
    Json(b): Json<Value>,
) -> Response {
    generate(s, id, h, b, Protocol::Messages).await
}

// The native GenerateImage tool performs its own rendering and file execution.
// This endpoint only forwards the standard provider API it requests.
async fn images(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = authorized(&state, &headers).await {
        return *e;
    }
    let Some(internal) = id.strip_prefix("byok:") else {
        return api_error(StatusCode::BAD_REQUEST, "invalid model route");
    };
    let mut model = match state.store.model(internal).await {
        Ok(Some(model)) if model.model_type == crate::model::ModelType::OpenAi => model,
        Ok(_) => {
            return api_error(
                StatusCode::NOT_IMPLEMENTED,
                "this model connection does not expose the OpenAI image API",
            )
        }
        Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let Some(image_model) = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    else {
        return api_error(StatusCode::BAD_REQUEST, "image model is required");
    };
    let mut url = match model
        .request_url()
        .and_then(|s| reqwest::Url::parse(&s).map_err(|e| Error::Config(e.to_string())))
    {
        Ok(url) => url,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };
    let base = ["/chat/completions", "/responses"]
        .iter()
        .find_map(|suffix| url.path().strip_suffix(suffix))
        .map(str::to_owned);
    let Some(base) = base else {
        return api_error(
            StatusCode::NOT_IMPLEMENTED,
            "image API requires a standard OpenAI-compatible base URL",
        );
    };
    url.set_path(&format!("{base}/images/generations"));
    model.base_url = url.to_string();
    model.use_full_url = true;
    model.model_id = image_model.into();
    match state
        .native
        .as_ref()
        .expect("native router forwarder")
        .forward(Protocol::Chat, &headers, body, &model, "native-agent")
        .await
    {
        Ok(response) => response,
        Err(e) => api_error(StatusCode::BAD_GATEWAY, e),
    }
}
