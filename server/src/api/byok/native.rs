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
    let model = crate::configured_models::resolve(&state.store, &state.plugins, internal).await?;
    let apis = match model.protocol {
        crate::model::ProviderType::Anthropic => vec!["anthropic_messages"],
        crate::model::ProviderType::OpenAiResponses => vec!["openai_responses"],
        crate::model::ProviderType::OpenAiChat => vec!["openai_chat"],
        crate::model::ProviderType::Plugin => vec!["openai_chat", "openai_responses"],
    };
    let (model_id, name, context, output, images, efforts) = (
        model.model_id,
        model.display_name,
        model.context,
        model.max_output_tokens,
        model.images,
        model.reasoning_efforts,
    );
    let mut capabilities = json!({"supports_tool_use":true,"supports_streaming":true,"supports_vision":images,"output_modalities":["text"],"context_length":context});
    capabilities["supports_fast"] = json!(model.supports_fast);
    if !efforts.is_empty() {
        capabilities["supports_reasoning"] = json!(true);
        capabilities["reasoning_effort"] = json!(efforts);
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
        Ok((model, metadata)) => Json(json!({"modelId":model.public_id,"contextWindowTokens":metadata.pointer("/capabilities/context_length"),"reasoningEfforts":metadata.pointer("/capabilities/reasoning_effort"),"supportsFast":metadata.pointer("/capabilities/supports_fast")})).into_response(),
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
    mut body: Value,
    protocol: Protocol,
) -> Response {
    if let Err(e) = authorized(&state, &headers).await {
        return *e;
    }
    let (model, metadata) = match lookup(&state, &id).await {
        Ok(found) => found,
        Err(e) => return api_error(StatusCode::NOT_FOUND, e),
    };
    if body.get("model").and_then(Value::as_str) != Some(&model.public_id) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "request model does not match the selected route",
        );
    }
    if let Err(error) = preserve_selected_effort(&mut body, protocol, &headers, &metadata) {
        return api_error(StatusCode::BAD_REQUEST, error);
    }
    if let Err(error) = preserve_selected_fast(&mut body, &headers, &metadata) {
        return api_error(StatusCode::BAD_REQUEST, error);
    }
    let search = matches!(protocol, Protocol::Responses) && super::search::prepare(&mut body);
    let response = invoke(state, headers, body, protocol, model, "native-agent").await;
    if search {
        super::search::finish(response).await
    } else {
        response
    }
}

// Native releases may not serialize effort for newly named models. Carry only an
// explicitly selected, provider-advertised value; keep native overrides intact.
fn preserve_selected_effort(
    body: &mut Value,
    protocol: Protocol,
    headers: &HeaderMap,
    metadata: &Value,
) -> Result<()> {
    let Some(effort) = headers
        .get("x-byok-reasoning-effort")
        .and_then(|h| h.to_str().ok())
    else {
        return Ok(());
    };
    if !metadata
        .pointer("/capabilities/reasoning_effort")
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(effort)))
    {
        return Err(Error::Protocol(
            "selected reasoning effort is not advertised by this model".into(),
        ));
    }
    match protocol {
        Protocol::Chat if body.get("reasoning_effort").is_none_or(Value::is_null) => {
            body["reasoning_effort"] = json!(effort)
        }
        Protocol::Responses if body.pointer("/reasoning/effort").is_none_or(Value::is_null) => {
            if body.get("reasoning").is_none_or(Value::is_null) {
                body["reasoning"] = json!({});
            }
            if !body["reasoning"].is_object() {
                return Err(Error::Protocol("reasoning must be an object".into()));
            }
            body["reasoning"]["effort"] = json!(effort);
        }
        _ => {}
    }
    Ok(())
}

fn preserve_selected_fast(body: &mut Value, headers: &HeaderMap, metadata: &Value) -> Result<()> {
    let Some(fast) = headers.get("x-byok-fast") else {
        return Ok(());
    };
    if metadata
        .pointer("/capabilities/supports_fast")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(Error::Protocol(
            "Fast is not supported by this model connection".into(),
        ));
    }
    let tier = match fast.to_str().ok() {
        Some("true") => "priority",
        Some("false") => "default",
        _ => return Err(Error::Protocol("invalid Fast selection".into())),
    };
    if body.get("service_tier").is_none_or(Value::is_null) {
        body["service_tier"] = json!(tier);
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fast_selection_requires_support_and_preserves_explicit_tiers() {
        let mut headers = HeaderMap::new();
        headers.insert("x-byok-fast", "true".parse().unwrap());
        let metadata = json!({"capabilities":{"supports_fast":true}});
        let mut body = json!({});
        preserve_selected_fast(&mut body, &headers, &metadata).unwrap();
        assert_eq!(body["service_tier"], "priority");
        body["service_tier"] = json!("default");
        preserve_selected_fast(&mut body, &headers, &metadata).unwrap();
        assert_eq!(body["service_tier"], "default");
        assert!(preserve_selected_fast(
            &mut body,
            &headers,
            &json!({"capabilities":{"supports_fast":false}})
        )
        .is_err());
        headers.insert("x-byok-fast", "invalid".parse().unwrap());
        assert!(preserve_selected_fast(&mut body, &headers, &metadata).is_err());
    }
    #[test]
    fn forwards_advertised_effort_without_replacing_native_parameters() {
        let mut headers = HeaderMap::new();
        headers.insert("x-byok-reasoning-effort", "high".parse().unwrap());
        let metadata = json!({"capabilities":{"reasoning_effort":["low","high"]}});
        let mut responses = json!({"reasoning":{"summary":"auto"}});
        preserve_selected_effort(&mut responses, Protocol::Responses, &headers, &metadata).unwrap();
        assert_eq!(
            responses,
            json!({"reasoning":{"effort":"high","summary":"auto"}})
        );
        let mut chat = json!({});
        preserve_selected_effort(&mut chat, Protocol::Chat, &headers, &metadata).unwrap();
        assert_eq!(chat["reasoning_effort"], "high");
        chat["reasoning_effort"] = json!("low");
        preserve_selected_effort(&mut chat, Protocol::Chat, &headers, &metadata).unwrap();
        assert_eq!(chat["reasoning_effort"], "low");
        headers.insert("x-byok-reasoning-effort", "max".parse().unwrap());
        assert!(preserve_selected_effort(&mut chat, Protocol::Chat, &headers, &metadata).is_err());
    }
}
