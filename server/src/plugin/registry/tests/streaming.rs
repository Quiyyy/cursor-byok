use super::*;
use axum::body::Body;
use futures_util::FutureExt;
use hudsucker::{
    hyper::{server::conn::http1, service::service_fn, Request, Response},
    hyper_util::rt::TokioIo,
};
use serde_json::json;
use tokio_rustls::{rustls, TlsAcceptor};

struct HttpsUpstream {
    url: String,
    certificate: reqwest::Certificate,
    closed: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl HttpsUpstream {
    async fn start() -> Self {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let certificate = reqwest::Certificate::from_der(cert.der()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
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
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "https://localhost:{}",
            listener.local_addr().unwrap().port()
        );
        let closed = CancellationToken::new();
        let observed = closed.clone();
        let task = tokio::spawn(async move {
            for path in ["/hold", "/next"] {
                let (socket, _) = listener.accept().await.unwrap();
                let tls = acceptor.accept(socket).await.unwrap();
                let service = service_fn(
                    move |request: Request<hudsucker::hyper::body::Incoming>| async move {
                        assert_eq!(request.uri().path(), path);
                        let body = if path == "/hold" {
                            Body::from_stream(async_stream::stream! {
                                yield Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"FIRST\n"));
                                std::future::pending::<()>().await;
                            })
                        } else {
                            Body::from("NEXT\n")
                        };
                        Ok::<_, std::convert::Infallible>(
                            Response::builder()
                                .header("content-type", "text/event-stream")
                                .header("connection", "close")
                                .body(body)
                                .unwrap(),
                        )
                    },
                );
                let result = http1::Builder::new()
                    .serve_connection(TokioIo::new(tls), service)
                    .await;
                if path == "/hold" {
                    // A cancelled streaming client may end HTTP/1 without completing its body.
                    observed.cancel();
                } else {
                    result.unwrap();
                }
            }
        });
        Self {
            url,
            certificate,
            closed,
            task,
        }
    }
}

impl Drop for HttpsUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn cancellation_case(explicit: bool) {
    let (root, registry, mut entry, executable, _) = fixture().await;
    let mut upstream = HttpsUpstream::start().await;
    entry.manifest.permissions.network = vec!["localhost".into()];
    std::fs::write(
        &entry.entry,
        r#"
      import {defineProviderPlugin} from 'cursor-byok:plugin';
      defineProviderPlugin({providers:[{id:'fake',displayName:'fake',providerType:'test',
        invoke:async(input,output,context)=>{
          const response = await context.network.stream(input.model.privateData.url);
          if(response.status !== 200) throw new Error(`HTTP ${response.status}`);
          for await (const line of response.lines) output.emit({type:'text-delta',text:line});
          return {status:'completed'};
        }
      }]});
    "#,
    )
    .unwrap();
    // Trust only this fixture's certificate in this test client; production trust is unchanged.
    let client = reqwest::Client::builder()
        .use_native_tls()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .add_root_certificate(upstream.certificate.clone())
        .build()
        .unwrap();
    let store = Store::connect(&format!(
        "sqlite://{}",
        root.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let clients = NetworkClients::with_plugin_client_for_test(store, client).await;
    let worker = PluginWorker::new(
        &entry,
        executable,
        registry.inner.catalog.loader().clone(),
        clients,
    );
    let params = |path: &str| json!({"providerId":"fake","model":{"privateData":{"url":format!("{}{path}",upstream.url)}},"resource":null,"request":{}});
    // Always release the process, including when this regression intentionally fails on old code.
    let run = async {
        let cancellation = CancellationToken::new();
        let mut items = worker
            .invoke_streaming(
                "provider.invoke",
                params("/hold"),
                cancellation.clone(),
                None,
            )
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(10), items.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(first, WorkerStreamItem::Event(ref event) if event == &json!({"type":"text-delta","text":"FIRST"})),
            "{first:?}"
        );
        assert!(
            !upstream.closed.is_cancelled(),
            "upstream must still be streaming before cancellation"
        );
        if explicit {
            cancellation.cancel();
            let result = tokio::time::timeout(Duration::from_secs(5), items.recv())
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(result, WorkerStreamItem::Result(Err(Error::Cancelled))),
                "{result:?}"
            );
        }
        drop(items);
        assert_eq!(cancellation.is_cancelled(), explicit);
        tokio::time::timeout(Duration::from_secs(5), upstream.closed.cancelled())
            .await
            .expect("upstream response stream must close, including receiver-only cancellation");
        let next_cancellation = CancellationToken::new();
        let mut next = worker
            .invoke_streaming(
                "provider.invoke",
                params("/next"),
                next_cancellation.clone(),
                None,
            )
            .await
            .unwrap();
        let mut text = String::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match next
                    .recv()
                    .await
                    .expect("worker must return a terminal result")
                {
                    WorkerStreamItem::Event(event) => {
                        text.push_str(event["text"].as_str().unwrap())
                    }
                    WorkerStreamItem::Result(result) => {
                        assert_eq!(result.unwrap()["status"], "completed");
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(text, "NEXT");
        assert!(!next_cancellation.is_cancelled());
        assert_eq!(cancellation.is_cancelled(), explicit);
        tokio::time::timeout(Duration::from_secs(5), &mut upstream.task)
            .await
            .unwrap()
            .unwrap();
    };
    let outcome = std::panic::AssertUnwindSafe(run).catch_unwind().await;
    worker.stop().await;
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn receiver_drop_closes_plugin_https_stream_without_an_explicit_cancel() {
    cancellation_case(false).await;
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn explicit_cancel_closes_plugin_https_stream_and_keeps_next_call_independent() {
    cancellation_case(true).await;
}
