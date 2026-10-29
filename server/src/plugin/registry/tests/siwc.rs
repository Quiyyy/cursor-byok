//! Production SIWC plugin + native gateway + real Deno/HTTPS; no live account or Cursor installation.
use super::*;
use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use futures_util::{FutureExt, StreamExt};
use hudsucker::{
    hyper::{server::conn::http1, service::service_fn, Response},
    hyper_util::rt::TokioIo,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::{rustls, TlsAcceptor};
use tower::ServiceExt;

struct Upstream {
    client: reqwest::Client,
    requests: tokio::sync::mpsc::UnboundedReceiver<Value>,
    closed: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Upstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Upstream {
    async fn start() -> Self {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["api.openai.com".into()]).unwrap();
        let certificate = reqwest::Certificate::from_der(cert.der()).unwrap();
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
        )
        .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(tls));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        // An explicit test proxy keeps hard-coded production URLs unchanged and all I/O local.
        let client = reqwest::Client::builder()
            .use_native_tls()
            .proxy(
                reqwest::Proxy::all(format!("http://{}", listener.local_addr().unwrap())).unwrap(),
            )
            .add_root_certificate(certificate)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let (sent, requests) = tokio::sync::mpsc::unbounded_channel();
        let closed = CancellationToken::new();
        let observed = closed.clone();
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                let sent = sent.clone();
                let closed = observed.clone();
                connections.spawn(async move {
                    let mut connect = Vec::new();
                    while !connect.ends_with(b"\r\n\r\n") {
                        connect.push(socket.read_u8().await.unwrap());
                        assert!(connect.len() < 8192);
                    }
                    assert!(String::from_utf8(connect).unwrap().starts_with("CONNECT api.openai.com:443 "));
                    socket.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
                    let socket = acceptor.accept(socket).await.unwrap();
                    let service = service_fn(move |request: hudsucker::hyper::Request<hudsucker::hyper::body::Incoming>| {
                        let sent = sent.clone(); let closed = closed.clone();
                        async move {
                            assert_eq!(request.headers()["authorization"], "Bearer fixture-access");
                            let body = if request.uri().path() == "/v1/models" {
                                Body::from(json!({"models":[{"slug":"gpt-test","display_name":"SIWC fixture","visibility":"list","context_window":100000}]}).to_string())
                            } else {
                                assert_eq!(request.uri().path(), "/v1/responses");
                                let bytes = to_bytes(Body::new(request.into_body()), 1024*1024).await.unwrap();
                                let body: Value = serde_json::from_slice(&bytes).unwrap();
                                sent.send(body.clone()).unwrap();
                                if body["input"].to_string().contains("wait-for-stop") {
                                    Body::from_stream(async_stream::stream! {
                                        let _closed = closed.drop_guard();
                                        yield Ok::<_,std::io::Error>(bytes::Bytes::from_static(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"FIRST\"}\n\n"));
                                        std::future::pending::<()>().await;
                                    })
                                } else {
                                    let outputs = body["input"].as_array().unwrap().iter().filter(|i| i["type"] == "function_call_output" || i["type"] == "custom_tool_call_output").count();
                                    let search = body["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| tool["type"] == "web_search"));
                                    let item = if search {
                                        json!({"id":"search-answer","type":"message","role":"assistant","content":[{"type":"output_text","text":"Search answer","annotations":[{"type":"url_citation","title":"Source","url":"https://example.test/source"}]}]})
                                    } else if body["input"].to_string().contains("after-stop") || outputs >= 2 {
                                        json!({"id":"msg","type":"message","role":"assistant","content":[{"type":"output_text","text":"complete"}]})
                                    } else if outputs == 0 {
                                        json!({"id":"fc","type":"function_call","name":"Read","namespace":"byok","call_id":"read-1","arguments":"{\"path\":\"fixture.txt\"}"})
                                    } else {
                                        json!({"id":"ct","type":"custom_tool_call","name":"ApplyPatch","namespace":"byok","call_id":"patch-1","input":"*** Begin Patch\n*** End Patch"})
                                    };
                                    let items = if search { vec![json!({"type":"web_search_call","status":"completed"}),item.clone()] } else {vec![item.clone()]};
                                    let response = json!({"id":"response-fixture","status":"completed","output":if search {vec![]} else {items.clone()},"usage":{"input_tokens":10,"output_tokens":2}});
                                    let mut frames = items.into_iter().enumerate().map(|(index,item)|format!("data: {}\n\n",json!({"type":"response.output_item.done","output_index":index,"item":item}))).collect::<String>();
                                    frames.push_str(&format!("data: {}\n\n",json!({"type":"response.completed","response":response})));
                                    Body::from(frames)
                                }
                            };
                            Ok::<_, std::convert::Infallible>(Response::builder().header("content-type","text/event-stream").body(body).unwrap())
                        }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(socket), service).await;
                });
            }
        });
        Self {
            client,
            requests,
            closed,
            task,
        }
    }
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn native_gateway_runs_siwc_tool_replay_and_cancellation_through_the_production_worker() {
    let (root, mut registry, store, previous_provider) = invocation_fixture().await;
    drop(previous_provider);
    let mut upstream = Upstream::start().await;
    let clients =
        NetworkClients::with_plugin_client_for_test(store.clone(), upstream.client.clone()).await;
    Arc::get_mut(&mut registry.inner).unwrap().clients = clients.clone();
    super::super::super::builtin::install(&root.path().join("installed")).unwrap();
    let entry = super::super::super::catalog::load_plugin(
        &root.path().join("installed/chatgpt-auth"),
        registry.inner.catalog.loader(),
        &registry.executable().unwrap(),
        "0.1.0",
    )
    .await
    .unwrap();
    let id = entry.manifest.id.clone();
    *registry.inner.entries.write().await = Some(vec![entry]);
    registry.inner.state.upsert_resources(&id, "chatgpt-account", vec![ResourceDraft {
        key: "oaiapp_fixture".into(), private_data: json!({"clientId":"oaiapp_fixture","hostId":"urn:uuid:fixture","subject":"fixture","accessToken":"fixture-access","scopes":["chatgpt.tokens.use.direct"],"expiresAtMs":super::super::super::state::now_ms()+3_600_000}), state: None,
    }]).await.unwrap();
    let run = async {
        assert_eq!(registry.sync_models(&id, "chatgpt").await.unwrap(), 1);
        let provider = Arc::new(crate::provider::ProviderRouter::new(
            store.clone(),
            registry.clone(),
            clients.clone(),
            Duration::from_secs(10),
            Duration::from_secs(10),
        ));
        let router = crate::api::byok::native_router(
            store.clone(),
            registry.clone(),
            provider,
            crate::api::byok::NativeForwarder::new(
                store.clone(),
                clients,
                Duration::from_secs(10),
                Duration::from_secs(10),
            ),
            crate::local_app::NativeAgent::for_test(root.path()),
        );
        store.set_cursor_takeover_enabled(true).await.unwrap();
        let model = format!("byok:plugin:{id}/chatgpt/gpt-test");
        let encoded: String = url::form_urlencoded::byte_serialize(model.as_bytes()).collect();
        let metadata = router
            .clone()
            .oneshot(
                Request::get(format!("/__byok-native__/models/{encoded}/v1/models"))
                    .header("authorization", "Bearer native-test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let metadata: Value =
            serde_json::from_slice(&to_bytes(metadata.into_body(), 65536).await.unwrap()).unwrap();
        assert_eq!(
            metadata["data"][0]["api_types"],
            json!(["openai_responses"])
        );
        let request = |body: Value, conversation: &str, generation: &str| {
            Request::post(format!("/__byok-native__/models/{encoded}/v1/responses"))
                .header("authorization", "Bearer native-test-key")
                .header("content-type", "application/json")
                .header("x-byok-conversation-id", conversation)
                .header("x-byok-generation-id", generation)
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let tools = json!([{"type":"function","name":"Read","parameters":{"type":"object"}},{"type":"custom","name":"ApplyPatch","format":{"type":"text"}}]);
        let mut history = vec![
            json!({"role":"user","content":"read a file"}),
            json!({"type":"reasoning","encrypted_content":"signed-replay"}),
        ];
        let mut previous = Vec::new();
        for round in 0..3 {
            let response = router.clone().oneshot(request(json!({"model":"gpt-test","input":history,"tools":tools,"stream":false,"service_tier":"priority"}), "parent-chat", "parent-run")).await.unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            let response: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap())
                    .unwrap();
            let sent = upstream.requests.recv().await.unwrap();
            assert_eq!(sent["store"], false);
            assert_eq!(sent["stream"], true);
            assert_eq!(sent["prompt_cache_key"], "parent-chat");
            assert_eq!(sent["service_tier"], "priority");
            assert_eq!(sent["tools"][0]["type"], "namespace");
            assert_eq!(sent["input"][1]["encrypted_content"], "signed-replay");
            let input = sent["input"].as_array().unwrap();
            assert_eq!(&input[..previous.len()], &previous);
            previous = input.clone();
            let item = response["output"][0].clone();
            assert!(item.get("namespace").is_none());
            if round < 2 {
                assert_eq!(
                    item["name"],
                    if round == 0 { "Read" } else { "ApplyPatch" },
                    "round {round}: response={response}; sent={sent}"
                );
                history.push(item.clone());
                history.push(json!({"type":if round == 0 {"function_call_output"} else {"custom_tool_call_output"},"call_id":item["call_id"],"output":"fixture result"}));
            } else {
                assert_eq!(item["content"][0]["text"], "complete");
            }
        }
        let response = router
            .clone()
            .oneshot(request(
                json!({"model":"gpt-test","input":"wait-for-stop","stream":true}),
                "parent-chat",
                "cancelled-run",
            ))
            .await
            .unwrap();
        let mut stream = response.into_body().into_data_stream();
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            while !text.contains("FIRST") {
                text.push_str(&String::from_utf8_lossy(
                    &stream.next().await.unwrap().unwrap(),
                ));
            }
        })
        .await
        .unwrap();
        drop(stream);
        tokio::time::timeout(Duration::from_secs(5), upstream.closed.cancelled())
            .await
            .expect("SIWC upstream must close on Stop/disconnect");
        upstream.requests.recv().await.unwrap();
        let response = router
            .clone()
            .oneshot(request(
                json!({"model":"gpt-test","input":"after-stop","stream":false}),
                "child-chat",
                "child-run",
            ))
            .await
            .unwrap();
        let body = to_bytes(response.into_body(), 65536).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("complete"));
        assert_eq!(
            upstream.requests.recv().await.unwrap()["prompt_cache_key"],
            "child-chat"
        );
        let response = router.oneshot(request(json!({"model":"gpt-test","input":"search docs","tools":[{"type":"web_search_preview"}],"stream":false}), "parent-chat", "search-run")).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let response: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
        assert!(response["output_text"]
            .as_str()
            .unwrap()
            .contains("https://example.test/source"));
        let sent = upstream.requests.recv().await.unwrap();
        assert_eq!(sent["tool_choice"], "required");
        assert!(sent["input"].is_array());
        let calls = store.llm_calls(20).await.unwrap();
        assert_eq!(calls.len(), 6);
        assert!(calls
            .iter()
            .filter(|call| call.run_id == "parent-run")
            .all(|call| call.fast == Some(true)));
        assert!(calls
            .iter()
            .any(|call| call.run_id == "child-run" && call.conversation_id == "child-chat"));
    };
    let result = std::panic::AssertUnwindSafe(run).catch_unwind().await;
    stop_workers(&registry).await;
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
