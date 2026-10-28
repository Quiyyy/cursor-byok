use super::*;
use crate::store::Store;
#[test]
fn authentication_retries_once_and_never_after_output() {
    assert!(should_retry_auth("auth-error", 0, false));
    assert!(!should_retry_auth("auth-error", 1, false));
    assert!(!should_retry_auth("auth-error", 0, true));
    assert!(!should_retry_auth("request-error", 0, false));
}

async fn fixture() -> (
    tempfile::TempDir,
    PluginRegistry,
    PluginEntry,
    std::path::PathBuf,
    ResourceRecord,
) {
    let executable = std::path::PathBuf::from(
        std::env::var_os("DENO_TEST_EXECUTABLE").expect("set DENO_TEST_EXECUTABLE"),
    );
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        // Exercise Deno's grants through a filesystem alias on every Unix
        // runner, not only macOS where /var already aliases /private/var.
        let installed = root.path().join("physical-plugins");
        std::fs::create_dir_all(&installed).unwrap();
        std::os::unix::fs::symlink(&installed, root.path().join("installed")).unwrap();
    }
    let directory = root.path().join("installed/test");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("plugin.json"), r#"{"apiVersion":1,"id":"dev.refresh","name":"Refresh test","version":"0.1.0","minAppVersion":"0.1.0","entry":"main.ts","icon":"icon.svg","permissions":{"network":[]}}"#).unwrap();
    std::fs::write(
        directory.join("icon.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    std::fs::write(directory.join("main.ts"), r#"
            import { defineProviderPlugin } from "cursor-byok:plugin";
            let exchanges = 0;
            export default defineProviderPlugin({
              providers: [{id:"fake",displayName:"fake",providerType:"test",resourceType:"account",invoke:async()=>({status:"completed"})}],
              resources: [{type:"account",displayName:"account",present:()=>({displayName:"test"}),
                prepare: async (resource) => {
                  if (resource.privateData.token.startsWith("fresh-")) return null;
                  const generation = ++exchanges;
                  await new Promise(resolve => setTimeout(resolve, 150));
                  return {privateData:{token:`fresh-${generation}`,refreshToken:`rotated-${generation}`},state:{status:"ready"}};
                }
              }]
            });
        "#).unwrap();
    let store = Store::connect(&format!(
        "sqlite://{}",
        root.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let state = PluginStateStore::new(PluginDataStore::for_test(root.path().join("data")).unwrap());
    state
        .upsert_resources(
            "dev.refresh",
            "account",
            vec![ResourceDraft {
                key: "one".into(),
                private_data: serde_json::json!({"token":"expired"}),
                state: None,
            }],
        )
        .await
        .unwrap();
    let record = state
        .resources("dev.refresh", "account")
        .await
        .unwrap()
        .remove(0);
    let catalog = PluginCatalog::for_test(root.path().to_owned());
    let entry =
        super::super::catalog::load_plugin(&directory, catalog.loader(), &executable, "0.1.7")
            .await
            .expect("test plugin loads");
    let registry = PluginRegistry {
        inner: Arc::new(RegistryInner {
            clients: NetworkClients::new(store),
            state,
            catalog,
            runtime: PluginRuntime::for_test(),
            entries: Default::default(),
            workers: Default::default(),
            oauth_sessions: Default::default(),
            preparation_locks: Default::default(),
            pending_preparations: Default::default(),
        }),
    };
    (root, registry, entry, executable, record)
}

async fn stop_workers(registry: &PluginRegistry) {
    for worker in registry.inner.workers.lock().await.values() {
        worker.stop().await;
    }
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn concurrent_requests_refresh_once_and_observe_committed_tokens() {
    let (_root, registry, entry, executable, record) = fixture().await;
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let (registry, entry, executable, record) = (
            registry.clone(),
            entry.clone(),
            executable.clone(),
            record.clone(),
        );
        tasks.push(tokio::spawn(async move {
            registry
                .prepare_resource(&entry, &executable, "account", record, None)
                .await
                .unwrap()
        }));
    }
    for task in tasks {
        assert_eq!(
            task.await.unwrap().private_data["refreshToken"],
            "rotated-1"
        );
    }
    let stored = registry
        .inner
        .state
        .resources("dev.refresh", "account")
        .await
        .unwrap();
    assert_eq!(stored[0].private_data["refreshToken"], "rotated-1");
    stop_workers(&registry).await;
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn cancelled_model_request_still_commits_rotated_credentials() {
    let (_root, registry, entry, executable, record) = fixture().await;
    let key = format!("dev.refresh/account/{}", record.id);
    let copy = registry.clone();
    let task = tokio::spawn(async move {
        copy.prepare_resource(&entry, &executable, "account", record, None)
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if registry
                .inner
                .preparation_locks
                .lock()
                .await
                .contains_key(&key)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let stored = registry
                .inner
                .state
                .resources("dev.refresh", "account")
                .await
                .unwrap();
            if stored[0].private_data["refreshToken"] == "rotated-1" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    stop_workers(&registry).await;
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn failed_disk_write_retries_saved_rotation_without_reusing_old_token() {
    let (root, registry, entry, executable, record) = fixture().await;
    let path = root.path().join("data/dev.refresh/resources-account.json");
    let original = std::fs::metadata(&path).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    std::fs::set_permissions(&path, readonly).unwrap();
    let result = registry
        .prepare_resource(&entry, &executable, "account", record.clone(), None)
        .await;
    std::fs::set_permissions(&path, original).unwrap();
    assert!(result.is_err());
    assert_eq!(registry.inner.pending_preparations.lock().await.len(), 1);
    let prepared = registry
        .prepare_resource(&entry, &executable, "account", record, None)
        .await
        .unwrap();
    assert_eq!(prepared.private_data["refreshToken"], "rotated-1");
    assert!(registry.inner.pending_preparations.lock().await.is_empty());
    stop_workers(&registry).await;
}

async fn fast_invocation_fixture() -> (
    tempfile::TempDir,
    PluginRegistry,
    Store,
    crate::provider::ProviderRouter,
) {
    let (root, mut registry, entry, executable, _) = fixture().await;
    std::fs::write(&entry.entry, r#"
      import {defineProviderPlugin} from 'cursor-byok:plugin';
      import {buildResponsesBody} from 'cursor-byok:protocol/openai-responses';
      defineProviderPlugin({
        providers:[{id:'fake',displayName:'fake',providerType:'test',resourceType:'account',
          supportsFast:true,nativeResponses:true,
          invoke:async(input,output)=>{
            const text=JSON.stringify(buildResponsesBody({url:'https://example.com/responses',model:input.model.id,request:input.request}));
            if(input.request.nativeResponses) output.emit({type:'responses-event',event:{type:'response.completed',response:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]}}});
            else output.emit({type:'text-delta',text});
            output.emit({type:'done',reason:'stop'});
            return {status:'completed'};
          }}],
        resources:[{type:'account',displayName:'account',present:()=>({displayName:'test'})}]
      });
    "#).unwrap();
    let entry = super::super::catalog::load_plugin(
        &entry.directory,
        registry.inner.catalog.loader(),
        &executable,
        "0.1.7",
    )
    .await
    .unwrap();
    // Use the supplied Deno executable without downloading a runtime.
    let mut command = tokio::process::Command::new(executable);
    super::super::detach_console(&mut command);
    let output = command
        .args(["eval", "console.log(Deno.execPath())"])
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    let runtime_root = root.path().join("runtime");
    let asset = super::super::asset::RuntimeAsset::current().unwrap();
    let installed = super::super::installation::runtime_executable(&runtime_root, asset);
    std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
    std::fs::copy(String::from_utf8(output.stdout).unwrap().trim(), &installed).unwrap();
    std::fs::write(installed.parent().unwrap().join(".ready"), "test").unwrap();
    let inner = Arc::get_mut(&mut registry.inner).unwrap();
    inner.runtime = PluginRuntime::in_directory(runtime_root).unwrap();
    *inner.entries.get_mut() = Some(vec![entry]);
    let model = StoredModel::from_definition(
        &serde_json::json!({"id":"fast","displayName":"Fast fixture"}),
    )
    .unwrap();
    registry
        .inner
        .state
        .replace_models("dev.refresh", "fake", &[model])
        .await
        .unwrap();
    let store = Store::connect(&format!(
        "sqlite://{}",
        root.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let provider = crate::provider::ProviderRouter::new(
        store.clone(),
        registry.clone(),
        NetworkClients::new(store.clone()),
        Duration::from_secs(10),
        Duration::from_secs(10),
    );
    (root, registry, store, provider)
}

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn native_fast_selection_reaches_plugin_requests_and_call_records() {
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;
    let (root, registry, store, provider) = fast_invocation_fixture().await;
    store.set_cursor_takeover_enabled(true).await.unwrap();
    let clients = NetworkClients::new(store.clone());
    let router = crate::api::byok::native_router(
        store.clone(),
        registry.clone(),
        Arc::new(provider),
        crate::api::byok::NativeForwarder::new(
            store.clone(),
            clients,
            Duration::from_secs(10),
            Duration::from_secs(10),
        ),
        crate::local_app::NativeAgent::for_test(root.path()),
    );
    let route = "/__byok-native__/models/byok%3Aplugin%3Adev.refresh%2Ffake%2Ffast";
    let metadata = router
        .clone()
        .oneshot(
            Request::get(route)
                .header("authorization", "Bearer native-test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::OK);
    let metadata: serde_json::Value =
        serde_json::from_slice(&to_bytes(metadata.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(metadata["supportsFast"], true);
    for (index, (endpoint, fast, explicit, expected)) in [
        ("chat/completions", true, None, Some("priority")),
        ("chat/completions", false, None, None),
        ("responses", true, None, Some("priority")),
        ("responses", false, None, Some("default")),
        ("responses", true, Some("default"), Some("default")),
    ]
    .into_iter()
    .enumerate()
    {
        let mut body = if endpoint == "responses" {
            serde_json::json!({"model":"fast","stream":false,"input":[{"type":"reasoning","encrypted_content":"signed-history"}],"tools":[{"type":"web_search"}]})
        } else {
            serde_json::json!({"model":"fast","stream":false,"messages":[{"role":"user","content":"hi"}]})
        };
        if let Some(tier) = explicit {
            body["service_tier"] = tier.into();
        }
        let response = router
            .clone()
            .oneshot(
                Request::post(format!("{route}/v1/{endpoint}"))
                    .header("authorization", "Bearer native-test-key")
                    .header("content-type", "application/json")
                    .header("x-byok-fast", fast.to_string())
                    .header("x-byok-conversation-id", "same-conversation")
                    .header("x-byok-generation-id", format!("run-{index}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 65536).await.unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "case {index}: {}",
            String::from_utf8_lossy(&bytes)
        );
        let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let output = if endpoint == "responses" {
            &response["output"][0]["content"][0]["text"]
        } else {
            &response["choices"][0]["message"]["content"]
        };
        let sent: serde_json::Value = serde_json::from_str(output.as_str().unwrap()).unwrap();
        assert_eq!(
            sent.get("service_tier").and_then(serde_json::Value::as_str),
            expected
        );
        assert_eq!(sent["prompt_cache_key"], "same-conversation");
        if endpoint == "responses" {
            assert_eq!(sent["input"], body["input"]);
            assert_eq!(sent["tools"], body["tools"]);
        }
        let calls = store.llm_calls(20).await.unwrap();
        let call = calls
            .iter()
            .find(|call| call.run_id == format!("run-{index}"))
            .unwrap();
        assert_eq!(call.fast, Some(expected == Some("priority")));
        assert_eq!(call.conversation_id, "same-conversation");
    }
    stop_workers(&registry).await;
}
