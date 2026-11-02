//! Full CONNECT/TLS ingress against an isolated configured upstream proxy.
use super::*;
use crate::{
    network::NetworkClients,
    store::{ProxyMode, ProxySettingsInput, Store},
};
use hudsucker::hyper::{Method, Response};
use std::{
    io::Write,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::sync::mpsc;
use tracing_subscriber::prelude::*;

#[derive(Debug)]
struct Seen {
    uri: String,
    method: Method,
    auth: Option<String>,
    cookies: Vec<String>,
    trace: bool,
    internal_url: bool,
    hop_header: bool,
    body: Vec<u8>,
}

#[derive(Clone)]
struct Upstream {
    seen: mpsc::UnboundedSender<Seen>,
    body_drops: Arc<AtomicUsize>,
}

struct BodyDrop(Arc<AtomicUsize>);
impl Drop for BodyDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

impl HttpHandler for Upstream {
    async fn handle_request(&mut self, _: &HttpContext, req: Request<Body>) -> RequestOrResponse {
        if req.method() == Method::CONNECT {
            return req.into();
        }
        let (parts, body) = req.into_parts();
        let bytes = axum::body::to_bytes(axum::body::Body::new(body), 1024 * 1024)
            .await
            .unwrap();
        self.seen
            .send(Seen {
                uri: parts.uri.to_string(),
                method: parts.method,
                auth: parts
                    .headers
                    .get("authorization")
                    .map(|v| v.to_str().unwrap().to_owned()),
                cookies: parts
                    .headers
                    .get_all("cookie")
                    .iter()
                    .map(|v| v.to_str().unwrap().to_owned())
                    .collect(),
                trace: parts.headers.contains_key(TRACE_ID_HEADER),
                internal_url: parts.headers.contains_key(UPSTREAM_URL_HEADER),
                hop_header: parts.headers.contains_key("x-hop-secret"),
                body: bytes.to_vec(),
            })
            .unwrap();
        let path = parts.uri.path();
        if path.ends_with("empty") {
            return Response::builder()
                .header("content-length", "0")
                .body(Body::empty())
                .unwrap()
                .into();
        }
        if path.ends_with("stall-headers") {
            std::future::pending::<()>().await;
        }
        if path.ends_with("stream") || path.ends_with("stall-body") || path.ends_with("cancel") {
            let stall = path.ends_with("stall-body") || path.ends_with("cancel");
            let guard = BodyDrop(self.body_drops.clone());
            let stream = async_stream::stream! {
                let _guard = guard;
                yield Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"data: first\n\n"));
                if stall { std::future::pending::<()>().await; }
                for _ in 0..8 {
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    yield Ok(bytes::Bytes::from_static(b"data: next\n\n"));
                }
            };
            return Response::builder()
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(stream))
                .unwrap()
                .into();
        }
        Response::builder()
            .status(403)
            .header("content-type", "application/proto")
            .header("x-fixture", "upstream")
            .body(Body::from(vec![0, 1, 255]))
            .unwrap()
            .into()
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    runtime: ProxyRuntime,
    upstream_task: JoinHandle<()>,
    backend_task: JoinHandle<()>,
    client: reqwest::Client,
    http1_client: reqwest::Client,
    seen: mpsc::UnboundedReceiver<Seen>,
    body_drops: Arc<AtomicUsize>,
    backend_hits: Arc<AtomicUsize>,
    url: String,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let ca = super::super::ca::CaManager::in_directory(directory.path().join("ca"));
        ca.initialize_local().unwrap();
        let cert = reqwest::Certificate::from_pem(
            &std::fs::read(directory.path().join("ca/ca.crt")).unwrap(),
        )
        .unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        let (tx, seen) = mpsc::unbounded_channel();
        let body_drops = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let upstream = Proxy::builder()
            .with_listener(listener)
            .with_ca(RcgenAuthority::new(
                ca.load().unwrap().issuer,
                10,
                aws_lc_rs::default_provider(),
            ))
            .with_rustls_connector(aws_lc_rs::default_provider())
            .with_http_handler(Upstream {
                seen: tx,
                body_drops: body_drops.clone(),
            })
            .build()
            .unwrap();
        let upstream_task = tokio::spawn(async move {
            upstream.start().await.unwrap();
        });
        store
            .set_proxy_settings(ProxySettingsInput {
                mode: ProxyMode::Custom,
                address: format!("http://{upstream_address}"),
                auth_enabled: false,
                username: String::new(),
                password: None,
            })
            .await
            .unwrap();
        // The only test-only transport addition is trusting the temporary fixture CA.
        let outbound = crate::network::client_builder(&store)
            .await
            .unwrap()
            .add_root_certificate(cert.clone())
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let forwarder = CursorProxy::for_test(
            NetworkClients::new(store),
            outbound,
            Duration::from_millis(500),
        );
        let backend_hits = Arc::new(AtomicUsize::new(0));
        let hits = backend_hits.clone();
        let backend = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_address = backend.local_addr().unwrap();
        let backend_task = tokio::spawn(async move {
            axum::serve(
                backend,
                axum::Router::new().fallback(move || {
                    let hits = hits.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        "local-model-catalog"
                    }
                }),
            )
            .await
            .unwrap();
        });
        let mut runtime = ProxyRuntime::default();
        let (url, _) = runtime
            .start(
                backend_address,
                ca.load().unwrap(),
                0,
                Arc::new(RwLock::new(TabMode::Direct)),
                forwarder,
            )
            .await
            .unwrap();
        let frontend = || {
            reqwest::Client::builder()
                .use_native_tls()
                .no_proxy()
                .proxy(reqwest::Proxy::all(&url).unwrap())
                .add_root_certificate(cert.clone())
                .timeout(Duration::from_secs(5))
        };
        let client = frontend().build().unwrap();
        let http1_client = frontend().http1_only().build().unwrap();
        Self {
            _directory: directory,
            runtime,
            upstream_task,
            backend_task,
            client,
            http1_client,
            seen,
            body_drops,
            backend_hits,
            url,
        }
    }

    fn request(&self, path: &str) -> reqwest::RequestBuilder {
        self.client
            .post(format!("https://isolated-test.cursor.sh{path}"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(stop) = self.runtime.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = &self.runtime.task {
            task.abort();
        }
        self.upstream_task.abort();
        self.backend_task.abort();
    }
}

#[derive(Clone)]
struct LogBuffer(Arc<std::sync::Mutex<Vec<u8>>>);

struct EventFields(Vec<u8>);
impl tracing::field::Visit for EventFields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        let _ = write!(self.0, "{}={value:?} ", field.name());
    }
}

struct CaptureEvents(LogBuffer);
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureEvents {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if event.metadata().target().starts_with("cursor_server") {
            let mut buffer = EventFields(Vec::new());
            event.record(&mut buffer);
            buffer.0.push(b'\n');
            self.0 .0.lock().unwrap().extend_from_slice(&buffer.0);
        }
    }
}

#[test]
fn concurrent_log_events_remain_separate() {
    struct SplitValue(Arc<std::sync::Barrier>);
    impl std::fmt::Debug for SplitValue {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("begin")?;
            self.0.wait();
            f.write_str("end")
        }
    }
    let logs = LogBuffer(Arc::new(std::sync::Mutex::new(Vec::new())));
    let dispatch =
        tracing::Dispatch::new(tracing_subscriber::registry().with(CaptureEvents(logs.clone())));
    let barrier = Arc::new(std::sync::Barrier::new(2));
    std::thread::scope(|scope| {
        for _ in 0..2 {
            let (dispatch, barrier) = (dispatch.clone(), barrier.clone());
            scope.spawn(move || {
                tracing::dispatcher::with_default(&dispatch, || {
                    tracing::info!(probe = ?SplitValue(barrier));
                });
            });
        }
    });
    assert_eq!(
        String::from_utf8(logs.0.lock().unwrap().clone()).unwrap(),
        "probe=beginend \nprobe=beginend \n"
    );
}

#[tokio::test]
async fn https_passthrough_uses_configured_upstream_and_preserves_wire_data() {
    let mut f = Fixture::new().await;
    let response = f
        .request(
            "/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam?query-secret=1",
        )
        .header("authorization", "Bearer fixture-secret")
        .header("cookie", "first=1")
        .header("cookie", "second=2")
        .header("connection", "x-hop-secret")
        .header("x-hop-secret", "remove-me")
        .header(TRACE_ID_HEADER, "spoofed")
        .header(UPSTREAM_URL_HEADER, "https://wrong.cursor.sh/")
        .body(vec![9, 0, 255, 8])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    assert_eq!(response.headers()["x-fixture"], "upstream");
    assert_eq!(response.bytes().await.unwrap().as_ref(), &[0, 1, 255]);
    let seen = f.seen.recv().await.unwrap();
    assert_eq!(seen.method, Method::POST);
    assert!(seen
        .uri
        .ends_with("/GetTeamAdminSettingsOrEmptyIfNotInTeam?query-secret=1"));
    assert!(seen.uri.contains("isolated-test.cursor.sh"));
    assert_eq!(seen.body, [9, 0, 255, 8]);
    assert_eq!(seen.auth.as_deref(), Some("Bearer fixture-secret"));
    assert_eq!(seen.cookies, ["first=1; second=2"]);
    assert!(!seen.trace && !seen.internal_url && !seen.hop_header);
    assert_eq!(f.backend_hits.load(Ordering::SeqCst), 0);
    let http1 = f
        .http1_client
        .post("https://isolated-test.cursor.sh/http1-control")
        .send()
        .await
        .unwrap();
    assert_eq!(http1.version(), reqwest::Version::HTTP_11);
    assert_eq!(http1.status(), 403);
    // Unknown official paths cannot reach the local management API.
    assert_eq!(
        f.request("/__byok-api__/api/models")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(f.backend_hits.load(Ordering::SeqCst), 0);
    let local = f
        .request("/aiserver.v1.AiService/AvailableModels")
        .send()
        .await
        .unwrap();
    assert_eq!(local.text().await.unwrap(), "local-model-catalog");
    assert_eq!(f.backend_hits.load(Ordering::SeqCst), 1);
    assert!(f.url.starts_with("http://127.0.0.1:"));
}

#[tokio::test]
async fn https_timeouts_release_requests_and_do_not_truncate_active_streams() {
    // Other tests create the same static tracing callsites concurrently. Keep one
    // process-wide test collector alive, rather than racing scoped dispatchers.
    static LOGS: std::sync::OnceLock<LogBuffer> = std::sync::OnceLock::new();
    let logs = LOGS.get_or_init(|| {
        let logs = LogBuffer(Arc::new(std::sync::Mutex::new(Vec::new())));
        tracing::subscriber::set_global_default(
            tracing_subscriber::registry().with(CaptureEvents(logs.clone())),
        )
        .unwrap();
        logs
    });
    let f = Fixture::new().await;
    let timeout = f
        .request("/stall-headers?query-secret=1")
        .send()
        .await
        .unwrap();
    assert_eq!(timeout.status(), 504);
    assert_eq!(
        timeout.json::<serde_json::Value>().await.unwrap()["code"],
        "deadline_exceeded"
    );
    let response = f.request("/stream").send().await.unwrap();
    let text = response.text().await.unwrap();
    assert_eq!(text.matches("data:").count(), 9);
    let mut body = f
        .request("/stall-body")
        .send()
        .await
        .unwrap()
        .bytes_stream();
    assert_eq!(body.next().await.unwrap().unwrap(), "data: first\n\n");
    assert!(
        body.next().await.unwrap().is_err(),
        "idle timeout must not become successful EOF"
    );
    let mut cancel = f.request("/cancel").send().await.unwrap().bytes_stream();
    cancel.next().await.unwrap().unwrap();
    drop(cancel);
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.body_drops.load(Ordering::SeqCst) < 3 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        f.request("/healthy-after-timeouts")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let empty = f.request("/empty").send().await.unwrap();
    assert_eq!(empty.status(), 200);
    assert!(empty.bytes().await.unwrap().is_empty());
    let logs = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    let ids = logs
        .lines()
        .filter(|line| {
            line.contains("Cursor HTTPS proxy request received")
                && [
                    "/stall-headers",
                    "/stream",
                    "/stall-body",
                    "/cancel",
                    "/healthy-after-timeouts",
                    "/empty",
                ]
                .iter()
                .any(|p| line.contains(&format!("path=\"{p}\"")))
        })
        .filter_map(|line| line.split("request_id=").nth(1)?.split_whitespace().next())
        .collect::<Vec<_>>();
    assert_eq!(ids.len(), 6);
    let logs = logs
        .lines()
        .filter(|line| ids.iter().any(|id| line.contains(id)))
        .collect::<Vec<_>>()
        .join("\n");
    let ended = |index: usize, phase: &str, outcome: &str| {
        assert!(
            logs.lines().any(|line| {
                line.contains(ids[index])
                    && line.contains("Cursor forwarding finished")
                    && line.contains(&format!("phase=\"{phase}\""))
                    && line.contains(&format!("outcome=\"{outcome}\""))
            }),
            "missing terminal state for {}: {phase}/{outcome}\n{logs}",
            ids[index]
        );
    };
    ended(0, "response_headers", "timeout");
    ended(1, "response_body", "completed");
    ended(2, "response_body", "timeout");
    ended(3, "response_body", "cancelled");
    ended(5, "response_body", "completed");
    assert!(
        logs.contains("response_headers") && logs.contains("timeout"),
        "missing lifecycle logs: {logs}"
    );
    assert!(
        logs.contains("response_body") && logs.contains("cancelled") && logs.contains("completed"),
        "missing body lifecycle: {logs}"
    );
    assert!(
        !logs.contains("query-secret")
            && !logs.contains("fixture-secret")
            && !logs.contains("data: first")
    );
}
