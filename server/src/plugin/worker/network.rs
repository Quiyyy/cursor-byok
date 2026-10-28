//! Host network permissions, request recording and streamed responses.
use super::*;
fn recorded_network_request(
    params: &serde_json::Value,
) -> Result<(serde_json::Value, serde_json::Value)> {
    let mut recorded_headers = serde_json::Map::new();
    if let Some(headers) = params.get("headers").and_then(serde_json::Value::as_object) {
        for (name, value) in headers {
            let value = value.as_str().ok_or_else(|| {
                Error::Config(format!("plugin HTTP header '{name}' must be a string"))
            })?;
            if !crate::model::is_sensitive_header(name) {
                recorded_headers.insert(name.clone(), value.into());
            }
        }
    }
    let body = params
        .get("body")
        .and_then(serde_json::Value::as_str)
        .map(|body| serde_json::from_str(body).unwrap_or_else(|_| body.into()))
        .unwrap_or(serde_json::Value::Null);
    Ok((serde_json::Value::Object(recorded_headers), body))
}

impl HostContext {
    pub(super) async fn call(
        &self,
        request_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        match method {
            "network.fetch" => self.fetch(request_id, params).await,
            "network.stream.open" => self.stream_open(request_id, params).await,
            "network.stream.read" => self.stream_read(params).await,
            "network.stream.close" => {
                self.streams
                    .lock()
                    .await
                    .remove(required_string(&params, "streamId")?);
                Ok(serde_json::Value::Null)
            }
            _ => Err(Error::Protocol(format!(
                "unsupported plugin host method: {method}"
            ))),
        }
    }

    async fn request(
        &self,
        request_id: &str,
        params: &serde_json::Value,
    ) -> Result<(
        reqwest::RequestBuilder,
        CancellationToken,
        Option<CallRecorder>,
    )> {
        let raw_url = required_string(params, "url")?;
        let url = url::Url::parse(raw_url)
            .map_err(|error| Error::Config(format!("invalid plugin network URL: {error}")))?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return Err(Error::Config(
                "plugin network URL must be HTTPS without credentials".into(),
            ));
        }
        let host = url
            .host_str()
            .ok_or_else(|| Error::Config("plugin network URL has no host".into()))?
            .to_ascii_lowercase();
        if !self.network_hosts.contains(&host) {
            return Err(Error::Config(format!(
                "plugin '{}' cannot access host '{host}'",
                self.plugin_id
            )));
        }
        let method = params
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("GET")
            .parse::<reqwest::Method>()
            .map_err(|error| Error::Config(format!("invalid plugin HTTP method: {error}")))?;
        let client = self.clients.plugin_client().await?;
        let mut request = client.request(method, url);
        if let Some(headers) = params.get("headers").and_then(serde_json::Value::as_object) {
            for (name, value) in headers {
                let value = value.as_str().ok_or_else(|| {
                    Error::Config(format!("plugin HTTP header '{name}' must be a string"))
                })?;
                request = request.header(name, value);
            }
        }
        if let Some(body) = params.get("body").and_then(serde_json::Value::as_str) {
            request = request.body(body.to_owned());
        }
        let invocation = self.invocations.lock().await.get(request_id).cloned();
        let cancellation = invocation
            .as_ref()
            .map(|state| state.cancellation.clone())
            .unwrap_or_default();
        let recorder = invocation.and_then(|state| state.claim_recorder());
        if let Some(recorder) = &recorder {
            let (headers, body) = recorded_network_request(params)?;
            recorder.request(headers, &body).await?;
        }
        Ok((request, cancellation, recorder))
    }

    async fn fetch(
        &self,
        request_id: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (request, cancellation, recorder) = self.request(request_id, &params).await?;
        let request = request.timeout(Duration::from_secs(60));
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            response = request.send() => response?,
        };
        let status = response.status().as_u16();
        if let Some(recorder) = &recorder {
            recorder.response_headers(status).await?;
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_NETWORK_RESPONSE_BYTES)
        {
            return Err(Error::Provider(
                "plugin network response is larger than allowed".into(),
            ));
        }
        let headers = header_map(&response);
        let body = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            body = response.bytes() => body?,
        };
        if body.len() as u64 > MAX_NETWORK_RESPONSE_BYTES {
            return Err(Error::Provider(
                "plugin network response is larger than allowed".into(),
            ));
        }
        if let Some(recorder) = &recorder {
            recorder.response_chunk(&body).await?;
        }
        Ok(
            serde_json::json!({ "status": status, "headers": headers, "body": String::from_utf8_lossy(&body) }),
        )
    }

    /// 打开流式响应:立即返回状态与响应头,响应体按行经 stream.read 拉取。
    async fn stream_open(
        &self,
        request_id: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let (request, cancellation, recorder) = self.request(request_id, &params).await?;
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancelled),
            response = request.send() => response?,
        };
        let status = response.status().as_u16();
        if let Some(recorder) = &recorder {
            recorder.response_headers(status).await?;
        }
        let headers = header_map(&response);
        let (sender, receiver) = mpsc::channel::<Result<String>>(256);
        tokio::spawn(async move {
            use futures_util::StreamExt;
            let mut body = response.bytes_stream();
            let mut buffered = Vec::<u8>::new();
            let mut total = 0_u64;
            loop {
                let chunk = tokio::select! {
                    _ = cancellation.cancelled() => {
                        let _ = sender.send(Err(Error::Cancelled)).await;
                        return;
                    }
                    chunk = body.next() => chunk,
                };
                let Some(chunk) = chunk else { break };
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(error) => {
                        let _ = sender.send(Err(Error::from(error))).await;
                        return;
                    }
                };
                total += chunk.len() as u64;
                if total > MAX_STREAM_BYTES {
                    let _ = sender
                        .send(Err(Error::Provider(
                            "plugin network stream is larger than allowed".into(),
                        )))
                        .await;
                    return;
                }
                if let Some(recorder) = &recorder {
                    if let Err(error) = recorder.response_chunk(&chunk).await {
                        let _ = sender.send(Err(error)).await;
                        return;
                    }
                }
                buffered.extend_from_slice(&chunk);
                while let Some(position) = buffered.iter().position(|byte| *byte == b'\n') {
                    let mut line = buffered.drain(..=position).collect::<Vec<u8>>();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if sender
                        .send(Ok(String::from_utf8_lossy(&line).into_owned()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            if !buffered.is_empty() {
                let _ = sender
                    .send(Ok(String::from_utf8_lossy(&buffered).into_owned()))
                    .await;
            }
        });
        let stream_id = uuid::Uuid::new_v4().to_string();
        self.streams
            .lock()
            .await
            .insert(stream_id.clone(), Arc::new(Mutex::new(receiver)));
        Ok(serde_json::json!({
            "streamId": stream_id,
            "status": status,
            "headers": headers,
        }))
    }

    async fn stream_read(&self, params: serde_json::Value) -> Result<serde_json::Value> {
        let stream_id = required_string(&params, "streamId")?;
        let lines_handle = self
            .streams
            .lock()
            .await
            .get(stream_id)
            .cloned()
            .ok_or_else(|| Error::Protocol(format!("unknown plugin stream: {stream_id}")))?;
        let mut receiver = lines_handle.lock().await;
        let mut lines = Vec::new();
        match receiver.recv().await {
            Some(Ok(line)) => lines.push(line),
            Some(Err(error)) => {
                drop(receiver);
                self.streams.lock().await.remove(stream_id);
                return Err(error);
            }
            None => {
                drop(receiver);
                self.streams.lock().await.remove(stream_id);
                return Ok(serde_json::json!({ "lines": [], "done": true }));
            }
        }
        // 把已就绪的行一并带走,减少往返。
        while lines.len() < 256 {
            match receiver.try_recv() {
                Ok(Ok(line)) => lines.push(line),
                Ok(Err(error)) => {
                    drop(receiver);
                    self.streams.lock().await.remove(stream_id);
                    return Err(error);
                }
                Err(_) => break,
            }
        }
        Ok(serde_json::json!({ "lines": lines, "done": false }))
    }
}

fn header_map(response: &reqwest::Response) -> std::collections::BTreeMap<String, String> {
    response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
}

fn required_string<'a>(params: &'a serde_json::Value, key: &str) -> Result<&'a str> {
    params
        .get(key)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| Error::Protocol(format!("plugin host call requires string '{key}'")))
}

#[cfg(test)]
mod tests {
    use crate::{
        model::{NewLlmCall, ProviderType},
        provider::{CallRecorder, FinishReason},
        store::Store,
    };

    use super::*;

    async fn recorder(detailed: bool, call_id: &str) -> (tempfile::TempDir, Store, CallRecorder) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("test.db").display()
        ))
        .await
        .unwrap();
        store.set_detailed_logging(detailed).await.unwrap();
        let recorder = CallRecorder::start(
            store.clone(),
            NewLlmCall {
                call_id: call_id.into(),
                run_id: "run".into(),
                conversation_id: "conversation".into(),
                model_hash: "plugin:test/provider/model".into(),
                provider_type: ProviderType::Plugin,
                provider_url: "plugin://test/provider".into(),
                request_type: ProviderType::Plugin,
                request_url: "plugin://test/provider".into(),
                model_id: "model".into(),
                display_name: "Model".into(),
                reasoning_effort: None,
                fast: false,
                message_count: 1,
                tool_count: 0,
                detailed: false,
            },
        )
        .await
        .unwrap();
        (directory, store, recorder)
    }

    fn network_params() -> serde_json::Value {
        serde_json::json!({
            "url": "https://example.com/v1/responses",
            "method": "POST",
            "headers": {
                "Authorization": "Bearer secret",
                "X-Api-Key": "secret-key",
                "Cookie": "session=secret",
                "content-type": "application/json",
                "x-client-request-id": "request-1"
            },
            "body": "{\"model\":\"test\",\"stream\":true}"
        })
    }

    async fn host_with_recorder(store: Store, recorder: CallRecorder) -> HostContext {
        let invocations = Arc::new(Mutex::new(HashMap::new()));
        invocations.lock().await.insert(
            "invocation".into(),
            Arc::new(InvocationState {
                cancellation: CancellationToken::new(),
                recorder: Some(recorder),
                recorder_claimed: AtomicBool::new(false),
            }),
        );
        HostContext {
            plugin_id: "test".into(),
            network_hosts: Arc::new(HashSet::from(["example.com".into()])),
            clients: NetworkClients::new(store),
            invocations,
            streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[tokio::test]
    async fn cancelling_plugin_network_closes_a_connection_waiting_for_tls() {
        use tokio::io::AsyncReadExt;
        let (_directory, store, recorder) = recorder(false, "plugin-network-cancel").await;
        let mut host = host_with_recorder(store, recorder).await;
        host.network_hosts = Arc::new(HashSet::from(["127.0.0.1".into()]));
        let cancellation = host.invocations.lock().await["invocation"]
            .cancellation
            .clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("https://{}/stream", listener.local_addr().unwrap());
        let (started, ready) = tokio::sync::oneshot::channel();
        // A stalled TLS peer exercises real socket cancellation without trusting a test CA
        // or weakening the production HTTPS/host permission checks.
        let peer = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            started.send(()).unwrap();
            loop {
                match socket.read(&mut bytes).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => break,
                    Err(error) => panic!("unexpected socket error: {error}"),
                }
            }
        };
        let cancel = async {
            ready.await.unwrap();
            cancellation.cancel();
        };
        let request = host.stream_open("invocation", serde_json::json!({"url":url}));
        let (_, _, result) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(peer, cancel, request)
        })
        .await
        .expect("cancel must close the upstream socket");
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(host.streams.lock().await.is_empty());
    }

    #[test]
    fn recorded_plugin_request_omits_sensitive_headers() {
        let (headers, body) = recorded_network_request(&network_params()).unwrap();

        assert_eq!(
            headers,
            serde_json::json!({
                "content-type": "application/json",
                "x-client-request-id": "request-1"
            })
        );
        assert_eq!(body, serde_json::json!({ "model": "test", "stream": true }));
    }

    #[tokio::test]
    async fn detailed_plugin_network_recording_persists_request_and_raw_response() {
        let (_directory, store, recorder) = recorder(true, "detailed-plugin").await;
        let host = host_with_recorder(store.clone(), recorder.clone()).await;
        let params = network_params();
        let (_, _, first_recorder) = host.request("invocation", &params).await.unwrap();
        let (_, _, second_recorder) = host.request("invocation", &params).await.unwrap();
        let (_, body) = recorded_network_request(&params).unwrap();

        assert!(first_recorder.is_some());
        assert!(second_recorder.is_none());
        recorder.response_headers(200).await.unwrap();
        recorder
            .response_chunk(b"data: {\"type\":\"response.created\"}\n\n")
            .await
            .unwrap();
        recorder.response_chunk(b"data: [DONE]\n\n").await.unwrap();
        recorder.completed(FinishReason::Stop).await.unwrap();

        let request = store
            .llm_call_request("detailed-plugin")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            request.headers,
            serde_json::json!({
                "content-type": "application/json",
                "x-client-request-id": "request-1"
            })
        );
        assert_eq!(request.body, body);
        let chunks = store.llm_call_chunks("detailed-plugin").await.unwrap();
        let expected_response = "data: {\"type\":\"response.created\"}\n\ndata: [DONE]\n\n";
        assert_eq!(chunks.len(), 2);
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| chunk.data.as_str())
                .collect::<String>(),
            expected_response
        );
        let summary = store.llm_call("detailed-plugin").await.unwrap().unwrap();
        assert_eq!(summary.http_status, Some(200));
        assert_eq!(summary.stream_event_count, 2);
        assert_eq!(summary.response_bytes, expected_response.len() as i64);
        assert!(summary.detailed);
    }

    #[tokio::test]
    async fn authentication_retry_records_separate_attempts_in_both_logging_modes() {
        for detailed in [true, false] {
            let (_directory, store, recorder) = recorder(detailed, "native-agent:retry").await;
            let host = host_with_recorder(store.clone(), recorder.clone()).await;
            let (request, _, observed) =
                host.request("invocation", &network_params()).await.unwrap();
            drop(request);
            assert!(observed.is_some());
            recorder.response_headers(401).await.unwrap();
            recorder.response_chunk(b"expired token").await.unwrap();
            let retry_id = recorder
                .retry(&Error::Provider("expired token".into()))
                .await
                .unwrap();
            host.invocations.lock().await.insert(
                "retry".into(),
                Arc::new(InvocationState {
                    cancellation: CancellationToken::new(),
                    recorder: Some(recorder.clone()),
                    recorder_claimed: AtomicBool::new(false),
                }),
            );
            let mut params = network_params();
            params["headers"]["x-client-request-id"] = "request-2".into();
            let (request, _, observed) = host.request("retry", &params).await.unwrap();
            drop(request);
            assert!(observed.is_some());
            recorder.response_headers(200).await.unwrap();
            recorder.response_chunk(b"success").await.unwrap();
            recorder.completed(FinishReason::Stop).await.unwrap();

            let ids: Vec<String> =
                sqlx::query_scalar("SELECT call_id FROM llm_calls ORDER BY call_id")
                    .fetch_all(store.pool())
                    .await
                    .unwrap();
            assert_eq!(ids.len(), 2);
            assert_eq!(ids[1], retry_id);
            assert!(retry_id.starts_with("native-agent:retry:retry:"));
            for (id, status, http_status, response, request_id) in [
                (&ids[0], "error", 401, "expired token", "request-1"),
                (&ids[1], "completed", 200, "success", "request-2"),
            ] {
                let summary = store.llm_call(id).await.unwrap().unwrap();
                assert_eq!(summary.status, status);
                assert_eq!(summary.http_status, Some(http_status));
                assert_eq!(summary.conversation_id, "conversation");
                assert_eq!(summary.run_id, "run");
                assert_eq!(summary.response_bytes, response.len() as i64);
                assert_eq!(summary.stream_event_count, 1);
                let request = store.llm_call_request(id).await.unwrap();
                let chunks = store.llm_call_chunks(id).await.unwrap();
                if detailed {
                    assert_eq!(request.unwrap().headers["x-client-request-id"], request_id);
                    assert_eq!(chunks.len(), 1);
                    assert_eq!(chunks[0].seq, 0);
                    assert_eq!(chunks[0].data, response);
                } else {
                    assert!(request.is_none());
                    assert!(chunks.is_empty());
                }
            }
        }
    }

    #[tokio::test]
    async fn dropping_a_retry_cancels_only_the_current_attempt() {
        let (_directory, store, recorder) = recorder(true, "native-agent:cancel-retry").await;
        let guard = recorder.cancel_on_drop();
        recorder
            .request(serde_json::json!({}), &serde_json::json!({}))
            .await
            .unwrap();
        let retry_id = recorder
            .retry(&Error::Provider("expired token".into()))
            .await
            .unwrap();
        recorder
            .request(serde_json::json!({}), &serde_json::json!({}))
            .await
            .unwrap();
        drop(guard);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if store.llm_call(&retry_id).await.unwrap().unwrap().status == "cancelled" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let first = store
            .llm_call("native-agent:cancel-retry")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.status, "error");
        assert_eq!(
            first.error_message.as_deref(),
            Some("provider error: expired token")
        );
    }

    #[tokio::test]
    async fn standard_plugin_network_recording_keeps_metrics_without_payloads() {
        let (_directory, store, recorder) = recorder(false, "standard-plugin").await;
        let host = host_with_recorder(store.clone(), recorder.clone()).await;
        let params = network_params();
        let (_, body) = recorded_network_request(&params).unwrap();
        let request_bytes = serde_json::to_string(&body).unwrap().len() as i64;
        let response = b"data: [DONE]\n\n";

        let (_, _, observed) = host.request("invocation", &params).await.unwrap();
        assert!(observed.is_some());
        recorder.response_headers(204).await.unwrap();
        recorder.response_chunk(response).await.unwrap();
        recorder.completed(FinishReason::Stop).await.unwrap();

        assert!(store
            .llm_call_request("standard-plugin")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .llm_call_chunks("standard-plugin")
            .await
            .unwrap()
            .is_empty());
        let summary = store.llm_call("standard-plugin").await.unwrap().unwrap();
        assert_eq!(summary.http_status, Some(204));
        assert_eq!(summary.request_bytes, Some(request_bytes));
        assert_eq!(summary.response_bytes, response.len() as i64);
        assert_eq!(summary.stream_event_count, 1);
        assert!(!summary.detailed);
    }
}
