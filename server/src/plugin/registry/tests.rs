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
