#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;

use std::sync::Arc;

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use cursor_server::{
    control,
    cursor::services::CursorServices,
    model::ModelConfigInput,
    network::NetworkClients,
    plugin::{PluginRegistry, PluginRuntime},
};
use prost::Message;
use serde_json::{json, Value};
use tower::ServiceExt;

#[derive(Clone, PartialEq, Message)]
struct DefaultModel {
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
struct ModelNudge {
    #[prost(string, tag = "1")]
    nudge_date: String,
    #[prost(bool, tag = "2")]
    should_default_switch_on_new_chat: bool,
}

async fn request(
    router: Router,
    method: &str,
    path: &str,
    body: Value,
) -> (StatusCode, axum::body::Bytes) {
    let response = router
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    (
        response.status(),
        to_bytes(response.into_body(), 1024 * 1024).await.unwrap(),
    )
}

#[tokio::test]
async fn configured_default_reaches_cursor_and_disables_auto_nudges() {
    let (directory, store) = fixtures::temp_store().await;
    let input: ModelConfigInput = serde_json::from_value(json!({
        "display_name":"Grok", "type":"openai", "base_url":"https://example.invalid/v1",
        "api_key":"test", "tooltip_data":"test", "model_id":"grok-4.7"
    }))
    .unwrap();
    let model = store.create_model(&input).await.unwrap();
    let runtime = PluginRuntime::in_directory(directory.path().join("runtime")).unwrap();
    let plugins = PluginRegistry::in_directory(
        cursor_server::network::NetworkClients::new(store.clone()),
        runtime.clone(),
        "1.1.1".into(),
        directory.path().join("plugins"),
    )
    .unwrap();
    let provider = Arc::new(fake_provider::FakeProvider::default());
    let clients = NetworkClients::new(store.clone());
    let control = control::ControlState::new(
        store.clone(),
        provider.clone(),
        runtime,
        plugins.clone(),
        clients.clone(),
        cursor_server::local_app::CursorHarness::new(store.clone()).unwrap(),
    );
    let router = control::api_router(control).merge(
        cursor_server::api::cursor::router(
            CursorServices::new(store.clone(), provider, Some(plugins)),
            clients,
        )
        .unwrap(),
    );
    let settings_path = "/__byok-api__/api/settings/cursor-model";

    let response = router
        .clone()
        .oneshot(
            Request::post("/aiserver.v1.AiService/GetDefaultModel")
                .header("content-type", "application/proto")
                .header("x-cursor-byok-default-only", "1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let unconfigured =
        DefaultModel::decode(to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
    assert!(
        unconfigured.model.is_empty(),
        "An unconfigured creation override must keep native selection without contacting upstream"
    );

    let (status, _) = request(
        router.clone(),
        "PUT",
        settings_path,
        json!({"model_id":"default"}),
    )
    .await;
    assert!(
        status.is_client_error(),
        "Auto is not a configured default model"
    );
    let (status, body) = request(
        router.clone(),
        "PUT",
        settings_path,
        json!({"model_id":model.model_hash}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(first["model_id"], model.model_hash);
    let revision = first["updated_at_ms"].as_i64().unwrap();
    assert!(revision > 0);
    let (_, body) = request(router.clone(), "GET", settings_path, json!({})).await;
    assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), first);

    let (status, body) = request(
        router.clone(),
        "POST",
        "/aiserver.v1.AiService/GetDefaultModel",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let default = DefaultModel::decode(body).unwrap();
    assert_eq!(default.model, format!("byok:{}", model.model_hash));
    assert_eq!(default.thinking_model, default.model);
    assert_eq!(default.next_default_set_date, revision.to_string());
    assert!(!default.max_mode);
    let (status, body) = request(
        router.clone(),
        "POST",
        "/aiserver.v1.AiService/GetDefaultModelNudgeData",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let nudge = ModelNudge::decode(body).unwrap();
    assert_eq!(nudge.nudge_date, "0");
    assert!(!nudge.should_default_switch_on_new_chat);
    let (status, body) = request(
        router.clone(),
        "POST",
        "/agent.v1.AgentService/GetNewChatNudgeParameterizedModelPicker",
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.is_empty(),
        "No new-chat promotion may replace the configured model"
    );

    let (_, body) = request(
        router.clone(),
        "PUT",
        settings_path,
        json!({"model_id":model.model_hash}),
    )
    .await;
    assert!(
        serde_json::from_slice::<Value>(&body).unwrap()["updated_at_ms"]
            .as_i64()
            .unwrap()
            > revision
    );
    store.delete_model(&model.model_hash).await.unwrap();
    let (status, _) = request(
        router,
        "POST",
        "/aiserver.v1.AiService/GetDefaultModel",
        json!({}),
    )
    .await;
    assert!(
        status.is_client_error(),
        "An unavailable default must not silently become Auto"
    );
}
