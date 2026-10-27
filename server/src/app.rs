//! Assembles server dependencies and starts the application services.
use std::{future::IntoFuture, net::SocketAddr, time::Duration};

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
        let plugins = PluginRegistry::managed(
            store.clone(),
            plugin_runtime.clone(),
            config.app_version.clone(),
        )?;
        let clients = crate::network::NetworkClients::new(store.clone());
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
        let control = control::ControlService::new(
            store.clone(),
            provider.clone(),
            plugin_runtime,
            plugins.clone(),
            clients.clone(),
        )?;
        let harness = control.cursor_harness().clone();
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
        let mut router = api::router(services.with_native(harness.native_agent()), clients)?
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
        if let Err(error) = self.harness.restore().await {
            // Keep management available so the user can inspect and retry takeover.
            tracing::warn!(%error, "failed to restore Cursor takeover during startup");
        }
        self.harness.start_cursor_update_check_if_managed().await;
        tracing::info!(%address, "cursor server listening");
        let harness = self.harness;
        let graceful = shutdown.clone();
        let server = axum::serve(listener, self.router)
            .with_graceful_shutdown(async move {
                graceful.cancelled().await;
            })
            .into_future();
        tokio::pin!(server);

        tokio::select! {
            result = &mut server => {
                if let Err(error) = harness.disable().await {
                    tracing::warn!(%error, "failed to disable Cursor harness after server stop");
                }
                result?
            },
            () = shutdown.cancelled() => {
                if let Err(error) = harness.disable().await {
                    tracing::warn!(%error, "failed to disable Cursor harness during shutdown");
                }
                match tokio::time::timeout(Duration::from_secs(10), &mut server).await {
                    Ok(result) => result?,
                    Err(_) => tracing::warn!("graceful shutdown timed out; forcing server close"),
                }
            }
        }
        Ok(())
    }
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
