//! Selects local handling or the configured official Cursor upstream.
use std::time::{Duration, Instant};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::Extension,
    http::{header, Request, Response},
};

use crate::Result;
use futures_util::StreamExt;
use uuid::Uuid;

const CURSOR_UPSTREAM: &str = "https://api2.cursor.sh";
pub const UPSTREAM_URL_HEADER: &str = "x-server-upstream-url";
pub(crate) const TRACE_ID_HEADER: &str = "x-byok-proxy-trace-id";
const RESPONSE_HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
const RESPONSE_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone)]
pub struct CursorProxy {
    clients: crate::network::NetworkClients,
    upstream: String,
    headers_timeout: Duration,
    idle_timeout: Duration,
    #[cfg(test)]
    test_client: Option<reqwest::Client>,
}

pub struct BufferedResponse {
    pub status: axum::http::StatusCode,
    pub headers: axum::http::HeaderMap,
    pub body: Bytes,
}

impl BufferedResponse {
    pub fn into_response(self) -> Response<Body> {
        let body = self.body.clone();
        self.with_body(body)
    }

    pub fn with_body(mut self, body: Bytes) -> Response<Body> {
        self.headers.insert(
            header::CONTENT_LENGTH,
            body.len()
                .to_string()
                .parse()
                .expect("body length is always a valid header value"),
        );
        let mut response = Response::new(Body::from(body));
        *response.status_mut() = self.status;
        *response.headers_mut() = self.headers;
        response
    }
}

impl CursorProxy {
    pub fn cursor(clients: crate::network::NetworkClients) -> Self {
        Self {
            clients,
            upstream: CURSOR_UPSTREAM.into(),
            headers_timeout: RESPONSE_HEADERS_TIMEOUT,
            idle_timeout: RESPONSE_IDLE_TIMEOUT,
            #[cfg(test)]
            test_client: None,
        }
    }

    async fn client(&self) -> Result<reqwest::Client> {
        #[cfg(test)]
        if let Some(client) = &self.test_client {
            return Ok(client.clone());
        }
        self.clients.cursor_client().await
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        clients: crate::network::NetworkClients,
        client: reqwest::Client,
        timeout: Duration,
    ) -> Self {
        Self {
            test_client: Some(client),
            headers_timeout: timeout,
            idle_timeout: timeout,
            ..Self::cursor(clients)
        }
    }
}

/// Diagnostic lifetime only: dropping a pending request/body records downstream cancellation.
struct ForwardTrace {
    id: Uuid,
    started: Instant,
    phase: &'static str,
    bytes: usize,
    ended: bool,
    dispatch: tracing::Dispatch,
}

impl ForwardTrace {
    fn finish(&mut self, outcome: &'static str) {
        self.ended = true;
        // Response bodies may be dropped by another connection task. Retain the
        // request's dispatcher so cancellation is recorded in the same log sink.
        tracing::dispatcher::with_default(&self.dispatch, || {
            tracing::info!(request_id = %self.id, phase = self.phase, outcome, bytes = self.bytes,
                elapsed_ms = self.started.elapsed().as_millis(), "Cursor forwarding finished");
        });
    }
}

impl Drop for ForwardTrace {
    fn drop(&mut self) {
        if !self.ended {
            self.finish("cancelled");
        }
    }
}

pub async fn forward(
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    forward_request(&proxy, request, None).await
}

pub(crate) async fn forward_to_service(
    proxy: &CursorProxy,
    request: Request<Body>,
    service_url: &str,
) -> Result<Response<Body>> {
    forward_request(proxy, request, Some(service_url)).await
}

async fn forward_request(
    proxy: &CursorProxy,
    request: Request<Body>,
    service_url: Option<&str>,
) -> Result<Response<Body>> {
    let (parts, body) = request.into_parts();
    let id = parts
        .headers
        .get(TRACE_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(Uuid::new_v4);
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |value| value.as_str())
        .to_owned();
    let url = match service_url {
        Some(service_url) => format!("{}{}", service_url.trim_end_matches('/'), path),
        None => upstream_url(&parts.headers, &proxy.upstream, &path)?,
    };
    let mut trace = ForwardTrace {
        id,
        started: Instant::now(),
        phase: "client",
        bytes: 0,
        ended: false,
        dispatch: tracing::dispatcher::get_default(Clone::clone),
    };

    let mut headers = parts.headers;
    headers.remove(UPSTREAM_URL_HEADER);
    headers.remove(TRACE_ID_HEADER);
    headers.remove(header::HOST);
    remove_hop_by_hop_headers(&mut headers);
    // HTTP/2 permits split Cookie fields; an HTTP/1.1 upstream needs one field.
    // This path now returns a response directly, before Hudsucker normalizes it.
    if headers.get_all(header::COOKIE).iter().count() > 1 {
        let mut joined = Vec::new();
        for cookie in headers.get_all(header::COOKIE) {
            if !joined.is_empty() {
                joined.extend_from_slice(b"; ");
            }
            joined.extend_from_slice(cookie.as_bytes());
        }
        headers.insert(
            header::COOKIE,
            axum::http::HeaderValue::from_bytes(&joined)
                .expect("joining valid cookie header values remains a valid header"),
        );
    }

    // Log the path without query parameters, headers or request/response contents.
    let log_path = parts.uri.path();
    tracing::info!(request_id = %id, method = %parts.method, path = log_path,
        "Cursor forwarding started");
    let client = match proxy.client().await {
        Ok(client) => client,
        Err(error) => {
            trace.finish("client_error");
            return Err(error);
        }
    };
    trace.phase = "response_headers";
    tracing::info!(request_id = %id, timeout_ms = proxy.headers_timeout.as_millis(),
        "Waiting for Cursor upstream response headers");
    let upstream = tokio::time::timeout(
        proxy.headers_timeout,
        client
            .request(parts.method.clone(), url)
            .headers(headers)
            .body(reqwest::Body::wrap_stream(body.into_data_stream()))
            .send(),
    )
    .await;

    let upstream = match upstream {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            let error = error.without_url();
            tracing::error!(
                request_id = %id,
                method = %parts.method,
                path = log_path,
                elapsed_ms = trace.started.elapsed().as_millis(),
                %error,
                "Cursor upstream request failed"
            );
            trace.finish("upstream_error");
            return Err(error.into());
        }
        Err(_) => {
            trace.finish("timeout");
            return Err(crate::Error::UpstreamTimeout("response_headers"));
        }
    };

    let status = upstream.status();
    let mut response_headers = upstream.headers().clone();
    remove_hop_by_hop_headers(&mut response_headers);
    tracing::info!(
        method = %parts.method,
        request_id = %id,
        path = log_path,
        %status,
        "Cursor upstream response headers received"
    );
    trace.phase = "response_body";
    // Hyper need not poll bodies that HTTP framing declares empty. They are
    // already complete, rather than a downstream cancellation on body drop.
    if upstream.content_length() == Some(0)
        || parts.method == axum::http::Method::HEAD
        || status == axum::http::StatusCode::NO_CONTENT
        || status == axum::http::StatusCode::NOT_MODIFIED
    {
        trace.finish("completed");
        let mut response = Response::new(Body::empty());
        *response.status_mut() = status;
        *response.headers_mut() = response_headers;
        return Ok(response);
    }
    let idle_timeout = proxy.idle_timeout;
    let mut chunks = upstream.bytes_stream();
    let stream = async_stream::try_stream! {
        loop {
            match tokio::time::timeout(idle_timeout, chunks.next()).await {
                Ok(Some(Ok(chunk))) => { trace.bytes += chunk.len(); yield chunk; }
                Ok(Some(Err(error))) => {
                    trace.finish("body_error");
                    Err(std::io::Error::other(error.without_url()))?;
                }
                Ok(None) => { trace.finish("completed"); break; }
                Err(_) => {
                    trace.finish("timeout");
                    Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Cursor upstream response body idle timeout"))?;
                }
            }
        }
    };
    let stream: std::pin::Pin<Box<dyn futures_util::Stream<Item = std::io::Result<Bytes>> + Send>> =
        Box::pin(stream);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = response_headers;

    Ok(response)
}

pub async fn forward_buffered(
    proxy: &CursorProxy,
    mut request: Request<Body>,
) -> Result<BufferedResponse> {
    request.headers_mut().insert(
        "connect-accept-encoding",
        axum::http::HeaderValue::from_static("identity"),
    );
    request.headers_mut().insert(
        header::ACCEPT_ENCODING,
        axum::http::HeaderValue::from_static("identity"),
    );
    let response = forward_request(proxy, request, None).await?;
    let (parts, body) = response.into_parts();
    let body = to_bytes(body, usize::MAX)
        .await
        .map_err(|_| crate::Error::Provider("cannot read Cursor upstream response".into()))?;
    Ok(BufferedResponse {
        status: parts.status,
        headers: parts.headers,
        body,
    })
}

fn upstream_url(headers: &axum::http::HeaderMap, fallback: &str, path: &str) -> Result<String> {
    let Some(value) = headers.get(UPSTREAM_URL_HEADER) else {
        return Ok(format!("{fallback}{path}"));
    };
    let value = value
        .to_str()
        .map_err(|error| crate::Error::Protocol(format!("invalid upstream URL header: {error}")))?;
    let url = reqwest::Url::parse(value)
        .map_err(|error| crate::Error::Protocol(format!("invalid upstream URL: {error}")))?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !crate::local_app::proxy_host_allowed(host) {
        return Err(crate::Error::Protocol(
            "upstream URL must target a Cursor HTTPS host".into(),
        ));
    }
    Ok(url.into())
}

fn remove_hop_by_hop_headers(headers: &mut axum::http::HeaderMap) {
    let connection_headers = headers
        .get(header::CONNECTION)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for name in connection_headers {
        headers.remove(name);
    }
    for name in [
        header::CONNECTION,
        header::PROXY_AUTHENTICATE,
        header::PROXY_AUTHORIZATION,
        header::TE,
        header::TRAILER,
        header::TRANSFER_ENCODING,
        header::UPGRADE,
    ] {
        headers.remove(name);
    }
    headers.remove("keep-alive");
}
