//! Isolated real-Cursor verification host. Never enables the installed application's takeover.
use cursor_server::{
    config::{ProviderConfig, ProviderKind},
    cursor::{prompting::PromptCompiler, TransportRegistry},
    model::{ModelConfigInput, ModelInvocation},
    network::NetworkClients,
    provider::{OpenAiChatProvider, Provider, ProviderStream},
    store::Store,
};
use hudsucker::{
    certificate_authority::RcgenAuthority,
    hyper::{Request, Uri},
    rustls::crypto::aws_lc_rs,
    Body, HttpContext, HttpHandler, Proxy, RequestOrResponse,
};
use serde_json::json;
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct RecordedProvider {
    inner: OpenAiChatProvider,
    root: PathBuf,
    model: String,
    index: AtomicUsize,
}
impl Provider for RecordedProvider {
    fn stream(
        &self,
        mut invocation: ModelInvocation,
        cancellation: CancellationToken,
    ) -> ProviderStream {
        invocation.request.model.model_id = self.model.clone();
        let index = self.index.fetch_add(1, Ordering::SeqCst);
        std::fs::write(
            self.root.join(format!("request-{index:03}.json")),
            serde_json::to_vec_pretty(&invocation).unwrap(),
        )
        .unwrap();
        self.inner.stream(invocation, cancellation)
    }
}

#[derive(Clone)]
struct Relay {
    backend: SocketAddr,
}
impl HttpHandler for Relay {
    async fn handle_request(
        &mut self,
        _: &HttpContext,
        mut request: Request<Body>,
    ) -> RequestOrResponse {
        let original = request.uri().clone();
        if request.method() != hudsucker::hyper::Method::CONNECT
            && original.host().is_some_and(|h| h.ends_with(".cursor.sh"))
        {
            request.headers_mut().insert(
                cursor_server::api::cursor::proxy::UPSTREAM_URL_HEADER,
                original.to_string().parse().unwrap(),
            );
            *request.uri_mut() = format!(
                "http://{}{}",
                self.backend,
                original.path_and_query().map_or("/", |v| v.as_str())
            )
            .parse::<Uri>()
            .unwrap();
        }
        request.into()
    }
    async fn should_intercept_connect(&mut self, _: &HttpContext, request: &Request<Body>) -> bool {
        request
            .uri()
            .authority()
            .is_some_and(|a| a.host().ends_with(".cursor.sh"))
    }
    async fn should_intercept_tls(
        &mut self,
        _: &HttpContext,
        hello: hudsucker::rustls::server::ClientHello<'_>,
    ) -> bool {
        hello
            .server_name()
            .is_some_and(|h| h.ends_with(".cursor.sh"))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter("cursor_server=info")
        .init();
    let root = PathBuf::from(std::env::var("CURSOR_BYOK_DATA_DIR")?);
    std::fs::create_dir_all(&root)?;
    let store = Store::connect(&format!("sqlite://{}", root.join("test.db").display())).await?;
    store.set_detailed_logging(true).await?;
    let model = std::env::var("CHECK_MODEL")?;
    let input: ModelConfigInput = serde_json::from_value(json!({
        "display_name":"BYOK Protocol Check", "type":"openai", "base_url":"http://127.0.0.1:1",
        "api_key":"local-test-placeholder", "tooltip_data":"Isolated protocol verification", "model_id":model,
        "context_window_tokens":128000
    }))?;
    for existing in store.models().await? {
        store.delete_model(&existing.model_hash).await?;
    }
    let config = store.create_model(&input).await?;
    let provider = RecordedProvider {
        inner: OpenAiChatProvider::new(
            reqwest::Client::new(),
            ProviderConfig {
                kind: ProviderKind::OpenAiChat,
                request_url: std::env::var("CHECK_GATEWAY_URL")?,
                api_key: std::env::var("CHECK_GATEWAY_KEY")?,
                custom_headers: Default::default(),
                max_output_tokens: Some(4096),
                request_timeout: Duration::from_secs(300),
                allowed_body_fields: None,
            },
        ),
        root: root.clone(),
        model,
        index: AtomicUsize::new(0),
    };
    let compiler =
        PromptCompiler::from_protocol_file(std::env::var("CURSOR_PROTOCOL_FILE")?.into())?;
    let registry = TransportRegistry::new(store.clone(), Arc::new(provider), compiler);
    let router = cursor_server::api::router(registry, NetworkClients::new(store))?;
    let backend = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let backend_addr = backend.local_addr()?;
    let ca_dir = PathBuf::from(std::env::var("CHECK_CA_DIR")?);
    let issuer = rcgen::Issuer::from_ca_cert_pem(
        &std::fs::read_to_string(ca_dir.join("ca.crt"))?,
        rcgen::KeyPair::from_pem(&std::fs::read_to_string(ca_dir.join("ca.key"))?)?,
    )?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let proxy_addr = listener.local_addr()?;
    let proxy = Proxy::builder()
        .with_listener(listener)
        .with_ca(RcgenAuthority::new(
            issuer,
            100,
            aws_lc_rs::default_provider(),
        ))
        .with_rustls_connector(aws_lc_rs::default_provider())
        .with_http_handler(Relay {
            backend: backend_addr,
        })
        .build()?;
    std::fs::write(
        root.join("connection.json"),
        serde_json::to_vec_pretty(
            &json!({"backend":backend_addr,"proxy":format!("http://{proxy_addr}"),"model_hash":config.model_hash}),
        )?,
    )?;
    tokio::select! { result = axum::serve(backend,router) => {result?;}, result = proxy.start() => {result?;} }
    Ok(())
}
