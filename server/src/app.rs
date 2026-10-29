//! Assembles server dependencies and starts the application services.
use std::{
    future::{Future, IntoFuture},
    net::SocketAddr,
    time::Duration,
};

use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::{
    api,
    config::{Config, ConsoleSource},
    control,
    cursor::services::CursorServices,
    local_app::CursorHarness,
    plugin::{PluginRegistry, PluginRuntime},
    provider::ProviderRouter,
    store::Store,
    Result,
};

pub struct App {
    config: Config,
    router: axum::Router,
    harness: CursorHarness,
    store: Store,
}

impl App {
    pub async fn new(mut config: Config) -> Result<Self> {
        let store = Store::connect(&config.database_url).await?;
        if config.use_persisted_ports {
            config
                .listen_addr
                .set_port(store.port_settings().await?.service_port);
        }
        let plugin_runtime = PluginRuntime::managed()?;
        let clients = crate::network::NetworkClients::new(store.clone());
        let plugins = PluginRegistry::managed(
            clients.clone(),
            plugin_runtime.clone(),
            config.app_version.clone(),
        )?;
        let provider = std::sync::Arc::new(ProviderRouter::new(
            store.clone(),
            plugins.clone(),
            clients.clone(),
            config.provider_request_timeout,
            config.provider_stream_idle_timeout,
        ));
        let byok = api::byok::router(
            store.clone(),
            plugins.clone(),
            provider.clone(),
            Some(api::byok::NativeForwarder::new(
                store.clone(),
                clients.clone(),
                config.provider_request_timeout,
                config.provider_stream_idle_timeout,
            )),
        );
        let services = CursorServices::new(store.clone(), provider.clone(), Some(plugins.clone()));
        let harness = CursorHarness::new(store.clone(), clients.clone())?;
        let control = control::ControlState::new(
            store.clone(),
            provider.clone(),
            plugin_runtime,
            plugins.clone(),
            clients.clone(),
            harness.clone(),
        );
        let native = api::byok::native_router(
            store.clone(),
            plugins,
            provider,
            api::byok::NativeForwarder::new(
                store.clone(),
                clients.clone(),
                config.provider_request_timeout,
                config.provider_stream_idle_timeout,
            ),
            harness.native_agent(),
        );
        let mut router =
            api::cursor::router(services.with_native(harness.native_agent()), clients)?
                .merge(byok)
                .merge(native);
        router = match &config.console {
            Some(ConsoleSource::Directory(directory)) => {
                router.merge(control::web_router(control.clone(), directory))
            }
            Some(ConsoleSource::Proxy(target)) => {
                router.merge(control::proxy_web_router(control.clone(), target.clone()))
            }
            None => router.merge(control::api_router(control.clone())),
        };
        Ok(Self {
            router,
            harness,
            store,
            config,
        })
    }

    pub fn merge_router(mut self, router: axum::Router) -> Self {
        self.router = self.router.merge(router);
        self
    }

    pub async fn bind(&self) -> Result<TcpListener> {
        let requested = self.config.listen_addr;
        let listener = bind_service_listener(requested, self.config.use_persisted_ports).await?;
        if self.config.use_persisted_ports {
            self.store
                .set_service_port(listener.local_addr()?.port())
                .await?;
        }
        Ok(listener)
    }

    pub fn harness(&self) -> CursorHarness {
        self.harness.clone()
    }

    pub fn store(&self) -> Store {
        self.store.clone()
    }

    pub async fn serve(self) -> Result<()> {
        let listener = self.bind().await?;
        let shutdown = CancellationToken::new();
        let signal_shutdown = shutdown.clone();
        let running = self.serve_on(listener, shutdown);
        tokio::pin!(running);
        tokio::select! {
            result = &mut running => result,
            () = shutdown_signal() => {
                tracing::info!("shutdown signal received; cancelling active runs");
                signal_shutdown.cancel();
                running.await
            }
        }
    }

    pub async fn serve_on(self, listener: TcpListener, shutdown: CancellationToken) -> Result<()> {
        let address = listener.local_addr()?;
        self.harness.set_backend_addr(address);
        tracing::info!(%address, "cursor server listening");
        let harness = self.harness;
        let graceful = shutdown.clone();
        let server = axum::serve(listener, self.router)
            .with_graceful_shutdown(async move {
                graceful.cancelled().await;
            })
            .into_future();
        let startup = harness.restore_on_start();
        serve_lifecycle(server, startup, shutdown, harness.disable()).await
    }
}

async fn serve_lifecycle(
    server: impl Future<Output = std::io::Result<()>>,
    startup: impl Future<Output = Result<()>>,
    shutdown: CancellationToken,
    cleanup: impl Future<Output = Result<()>>,
) -> Result<()> {
    // The owner polls startup and HTTP together; no detached restoration can outlive cleanup.
    let startup = async {
        if shutdown.is_cancelled() {
            return Ok(());
        }
        startup.await
    };
    tokio::pin!(server, startup);
    let mut startup_complete = false;
    let completed = loop {
        tokio::select! {
            biased;
            () = shutdown.cancelled() => break None,
            result = &mut server => break Some(result),
            result = &mut startup, if !startup_complete => {
                startup_complete = true;
                if let Err(error) = result {
                    tracing::warn!(%error, "could not restore Cursor takeover; management service remains available");
                }
            }
        }
    };
    shutdown.cancel();
    if !startup_complete {
        // An installer already in progress must finish before restoring its files.
        if let Err(error) = startup.await {
            tracing::warn!(%error, "Cursor takeover startup ended during shutdown");
        }
    }
    if let Err(error) = cleanup.await {
        tracing::warn!(%error, "failed to disable Cursor harness after server stop");
    }
    match completed {
        Some(result) => result?,
        None => match tokio::time::timeout(Duration::from_secs(10), &mut server).await {
            Ok(result) => result?,
            Err(_) => tracing::warn!("graceful shutdown timed out; forcing server close"),
        },
    }
    Ok(())
}

async fn bind_service_listener(
    requested: SocketAddr,
    allow_random_fallback: bool,
) -> Result<TcpListener> {
    match TcpListener::bind(requested).await {
        Ok(listener) => Ok(listener),
        Err(error) if allow_random_fallback && requested.port() != 0 => {
            tracing::warn!(%requested, %error, "configured service port unavailable; selecting a random port");
            Ok(TcpListener::bind(SocketAddr::new(requested.ip(), 0)).await?)
        }
        Err(error) => Err(error.into()),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn management_http_is_available_while_takeover_restores() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = CancellationToken::new();
        let graceful = shutdown.clone();
        let server = axum::serve(
            listener,
            Router::new().route("/health", get(|| async { "ready" })),
        )
        .with_graceful_shutdown(async move { graceful.cancelled().await })
        .into_future();
        let (started, entered) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let startup = async move {
            started.send(()).unwrap();
            released.await.unwrap();
            Ok(())
        };
        let cleaned = Arc::new(AtomicBool::new(false));
        let cleanup_flag = cleaned.clone();
        let running = tokio::spawn(serve_lifecycle(
            server,
            startup,
            shutdown.clone(),
            async move {
                cleanup_flag.store(true, Ordering::SeqCst);
                Ok(())
            },
        ));
        entered.await.unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(1),
            reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("http://{address}/health"))
                .send(),
        )
        .await;
        release.send(()).unwrap();
        shutdown.cancel();
        running.await.unwrap().unwrap();
        assert!(
            response.is_ok(),
            "management HTTP waited for takeover installation"
        );
        assert!(response.unwrap().unwrap().status().is_success());
        assert!(cleaned.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn shutdown_waits_for_inflight_restoration_before_cleanup() {
        let shutdown = CancellationToken::new();
        let (started, entered) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let restored = Arc::new(AtomicBool::new(false));
        let restored_flag = restored.clone();
        let cleaned = Arc::new(AtomicBool::new(false));
        let cleaned_flag = cleaned.clone();
        let graceful = shutdown.clone();
        let running = tokio::spawn(serve_lifecycle(
            async move {
                graceful.cancelled().await;
                Ok(())
            },
            async move {
                started.send(()).unwrap();
                released.await.unwrap();
                restored_flag.store(true, Ordering::SeqCst);
                Ok(())
            },
            shutdown.clone(),
            async move {
                assert!(restored.load(Ordering::SeqCst));
                cleaned_flag.store(true, Ordering::SeqCst);
                Ok(())
            },
        ));
        entered.await.unwrap();
        shutdown.cancel();
        tokio::task::yield_now().await;
        assert!(!running.is_finished());
        assert!(!cleaned.load(Ordering::SeqCst));
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), running)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(cleaned.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn already_cancelled_startup_performs_no_restoration() {
        let shutdown = CancellationToken::new();
        shutdown.cancel();
        serve_lifecycle(
            async { Ok(()) },
            async { panic!("shutdown must not start a new installation") },
            shutdown,
            async { Ok(()) },
        )
        .await
        .unwrap();
    }
}
