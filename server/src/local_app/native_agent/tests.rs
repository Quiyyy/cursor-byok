use super::*;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use axum::{
    http::{HeaderMap, Uri},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

struct HttpServer {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl HttpServer {
    async fn start(router: Router) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self { url, task }
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

const CHAT_STREAM: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

fn input(url: &str) -> crate::model::ModelConfigInput {
    serde_json::from_value(json!({
        "type":"openai", "model_id":"gpt-test", "display_name":"Same model",
        "base_url":url, "api_key":"provider-secret", "tooltip_data":"test",
        "openai_endpoint":"/v1/chat/completions", "reasoning_effort":"high",
        "openai_extra_params_enabled":true,
        "openai_extra_params":{"temperature":0.8,"prompt_cache_key":"{{SessionId}}"},
        "custom_headers_enabled":true,"custom_headers":{"x-session":"{{SessionId}}"}
    }))
    .unwrap()
}

fn invocation(id: &str, endpoint: &str, body: Value) -> Request<Body> {
    Request::post(format!("/__byok-native__/models/byok:{id}/v1/{endpoint}"))
        .header("authorization", "Bearer native-test-key")
        .header("content-type", "application/json")
        .header("x-byok-conversation-id", "conversation-a")
        .header("x-byok-generation-id", "generation-a")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn fixture() -> (tempfile::TempDir, crate::store::Store, axum::Router) {
    let directory = tempfile::tempdir().unwrap();
    let store = crate::store::Store::connect(&format!(
        "sqlite://{}",
        directory.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let runtime =
        crate::plugin::PluginRuntime::in_directory(directory.path().join("runtime")).unwrap();
    let plugins = crate::plugin::PluginRegistry::in_directory(
        crate::network::NetworkClients::new(store.clone()),
        runtime,
        "test".into(),
        directory.path().join("plugins"),
    )
    .unwrap();
    let clients = crate::network::NetworkClients::new(store.clone());
    let provider = Arc::new(crate::provider::ProviderRouter::new(
        store.clone(),
        plugins.clone(),
        clients.clone(),
        std::time::Duration::from_secs(30),
        std::time::Duration::from_secs(30),
    ));
    let agent = NativeAgent {
        inner: Arc::new(Inner {
            app: directory.path().join("unused-cursor"),
            directory: directory.path().join("native"),
            key: "native-test-key".into(),
            installed: Mutex::new(None),
            catalog: Mutex::new(None),
        }),
    };
    let router = crate::api::byok::native_router(
        store.clone(),
        plugins,
        provider,
        crate::api::byok::NativeForwarder::new(
            store.clone(),
            clients,
            std::time::Duration::from_secs(30),
            std::time::Duration::from_secs(30),
        ),
        agent,
    );
    (directory, store, router)
}

#[tokio::test]
async fn native_gateway_is_independently_authorized_and_scopes_same_named_models() {
    let (_directory, store, router) = fixture().await;
    let mut ids = Vec::new();
    for port in [1, 2] {
        let input=serde_json::from_value(json!({"display_name":"Same model","type":"openai","base_url":format!("http://127.0.0.1:{port}/v1"),"api_key":"provider-secret","tooltip_data":"test","model_id":"grok-4.6","openai_endpoint":"/v1/chat/completions","context_window_tokens":200000})).unwrap();
        ids.push(store.create_model(&input).await.unwrap().model_hash);
    }
    assert_ne!(ids[0], ids[1]);
    assert!(!store.external_api_settings().await.unwrap().enabled);
    let request = |id: &str, key: &str| {
        Request::get(format!("/__byok-native__/models/byok:{id}/v1/models"))
            .header("authorization", format!("Bearer {key}"))
            .body(Body::empty())
            .unwrap()
    };
    store.set_cursor_takeover_enabled(false).await.unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(request(&ids[0], "native-test-key"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    store.set_cursor_takeover_enabled(true).await.unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(request(&ids[0], "wrong-key"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for id in &ids {
        let response = router
            .clone()
            .oneshot(request(id, "native-test-key"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["data"][0]["id"], "grok-4.6");
        assert_eq!(value["data"][0]["capabilities"]["context_length"], 200000);
        assert_eq!(value["data"][0]["api_types"], json!(["openai_chat"]));
        assert!(!String::from_utf8_lossy(&bytes).contains("provider-secret"));
    }
    for (context, expected) in [
        (Some(200000), 200000),
        (Some(1000000), 1000000),
        (None, 500000),
    ] {
        store
            .set_model_settings(
                &ids[0],
                crate::store::ModelSettings {
                    context_window_tokens: context,
                },
            )
            .await
            .unwrap();
        let response = router
            .clone()
            .oneshot(request(&ids[0], "native-test-key"))
            .await
            .unwrap();
        let metadata: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert_eq!(
            metadata["data"][0]["capabilities"]["context_length"],
            json!(expected)
        );
        let response = router
            .clone()
            .oneshot(
                Request::get(format!("/__byok-native__/models/byok:{}", ids[0]))
                    .header("authorization", "Bearer native-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let resolved: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert_eq!(resolved["contextWindowTokens"], json!(expected));
    }
    let response = router
        .oneshot(
            Request::post(format!(
                "/__byok-native__/models/byok:{}/v1/chat/completions",
                ids[0]
            ))
            .header("authorization", "Bearer native-test-key")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"wrong","messages":[]}"#))
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn native_requests_reach_the_selected_connection_with_effective_options_and_identity() {
    let (_directory, store, router) = fixture().await;
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let upstream = HttpServer::start(Router::new().route(
        "/{connection}/v1/chat/completions",
        post(
            move |uri: Uri, headers: HeaderMap, Json(body): Json<Value>| {
                let sent = sent.clone();
                async move {
                    sent.send((uri.path().to_owned(), headers, body)).unwrap();
                    ([("content-type", "text/event-stream")], CHAT_STREAM)
                }
            },
        ),
    ))
    .await;
    let mut models = Vec::new();
    for name in ["first", "second"] {
        models.push(
            store
                .create_model(&input(&format!("{}/{name}/v1", upstream.url)))
                .await
                .unwrap(),
        );
    }
    // The native key is not the external API key, and enabling the latter does not enable takeover.
    store
        .set_external_api_settings(crate::store::ExternalApiSettings {
            enabled: true,
            api_key: "external-secret".into(),
        })
        .await
        .unwrap();
    let body =
        json!({"model":"gpt-test","stream":true,"messages":[{"role":"user","content":"hello"}]});
    assert_eq!(
        router
            .clone()
            .oneshot(invocation(
                &models[0].model_hash,
                "chat/completions",
                body.clone()
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    store.set_cursor_takeover_enabled(true).await.unwrap();
    let mut unauthorized = invocation(&models[0].model_hash, "chat/completions", body.clone());
    unauthorized
        .headers_mut()
        .insert("authorization", "Bearer external-secret".parse().unwrap());
    assert_eq!(
        router.clone().oneshot(unauthorized).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert!(received.try_recv().is_err());
    store
        .set_external_api_settings(crate::store::ExternalApiSettings {
            enabled: false,
            api_key: "external-secret".into(),
        })
        .await
        .unwrap();

    // Keep the protocol matrix in external_api.rs; here exercise both native dispatch branches.
    for (index, model) in models.iter().enumerate() {
        for endpoint in ["chat/completions", "responses"] {
            let mut body = if endpoint == "responses" {
                json!({"model":"gpt-test","stream":true,"input":"hello","reasoning":{"effort":"low"}})
            } else {
                json!({"model":"gpt-test","stream":true,"messages":[{"role":"user","content":"hello"}],"reasoning_effort":"low"})
            };
            body["temperature"] = json!(0.2);
            let response = router
                .clone()
                .oneshot(invocation(&model.model_hash, endpoint, body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let output = to_bytes(response.into_body(), 65536).await.unwrap();
            assert!(String::from_utf8_lossy(&output).contains("ok"));
            let (path, headers, sent) = received.try_recv().unwrap();
            assert_eq!(
                path,
                format!("/{}/v1/chat/completions", ["first", "second"][index])
            );
            assert_eq!(headers["authorization"], "Bearer provider-secret");
            assert_eq!(headers["x-session"], "conversation-a");
            assert!(!headers
                .keys()
                .any(|key| key.as_str().starts_with("x-byok-")));
            assert_eq!(sent["model"], "gpt-test");
            assert_eq!(sent["temperature"], 0.2);
            assert_eq!(sent["reasoning_effort"], "low");
            assert_eq!(sent["prompt_cache_key"], "conversation-a");
            assert_eq!(sent["messages"], json!([{"role":"user","content":"hello"}]));
        }
    }
    let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
        "SELECT call_id, conversation_id, run_id, status, reasoning_effort FROM llm_calls",
    )
    .fetch_all(store.pool())
    .await
    .unwrap();
    assert_eq!(rows.len(), 4);
    for (id, conversation, run, status, effort) in rows {
        assert!(id.starts_with("native-agent:"));
        assert_eq!(
            (
                conversation.as_str(),
                run.as_str(),
                status.as_str(),
                effort.as_str()
            ),
            ("conversation-a", "generation-a", "completed", "low")
        );
    }
}

#[tokio::test]
async fn disconnecting_native_stream_closes_upstream_and_allows_the_next_run() {
    use futures_util::StreamExt;
    for endpoint in ["chat/completions", "responses"] {
        let (_directory, store, router) = fixture().await;
        let closed = CancellationToken::new();
        let observed = closed.clone();
        let upstream = HttpServer::start(Router::new().route("/v1/chat/completions", post(
            move |Json(body): Json<Value>| {
                let closed = observed.clone();
                async move {
                    if body["messages"][0]["content"] == "next" {
                        return ([("content-type","text/event-stream")], CHAT_STREAM).into_response();
                    }
                    let stream = async_stream::stream! {
                        let _closed = closed.drop_guard();
                        yield Ok::<_,std::io::Error>(bytes::Bytes::from_static(b"data: {\"choices\":[{\"delta\":{\"content\":\"FIRST\"}}]}\n\n"));
                        std::future::pending::<()>().await;
                    };
                    ([("content-type","text/event-stream")], Body::from_stream(stream)).into_response()
                }
            }
        ))).await;
        let model = store
            .create_model(&input(&format!("{}/v1", upstream.url)))
            .await
            .unwrap();
        store.set_cursor_takeover_enabled(true).await.unwrap();
        let gateway = HttpServer::start(router).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap();
        let url = format!(
            "{}/__byok-native__/models/byok:{}/v1/{endpoint}",
            gateway.url, model.model_hash
        );
        let body = |text: &str| {
            if endpoint == "responses" {
                json!({"model":"gpt-test","stream":true,"input":text})
            } else {
                json!({"model":"gpt-test","stream":true,"messages":[{"role":"user","content":text}]})
            }
        };
        let request = |text: &str, run: &str| {
            client
                .post(&url)
                .bearer_auth("native-test-key")
                .header("x-byok-conversation-id", "same-chat")
                .header("x-byok-generation-id", run)
                .json(&body(text))
        };
        let response = request("wait", "cancelled-run")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let mut stream = response.bytes_stream();
        let mut received = String::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !received.contains("FIRST") {
                received.push_str(&String::from_utf8_lossy(
                    &stream.next().await.unwrap().unwrap(),
                ));
            }
        })
        .await
        .unwrap();
        drop(stream);
        tokio::time::timeout(Duration::from_secs(5), closed.cancelled())
            .await
            .expect("upstream must close after client disconnect");
        let result = request("next", "next-run")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(result.contains("ok"));
        assert!(!result.contains("FIRST"));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let rows: Vec<(String, String)> =
                    sqlx::query_as("SELECT run_id,status FROM llm_calls ORDER BY run_id")
                        .fetch_all(store.pool())
                        .await
                        .unwrap();
                if rows
                    == [
                        ("cancelled-run".into(), "cancelled".into()),
                        ("next-run".into(), "completed".into()),
                    ]
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both calls must reach their terminal status");
    }
}
