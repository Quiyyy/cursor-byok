use super::*;

#[tokio::test]
#[ignore = "requires DENO_TEST_EXECUTABLE"]
async fn successful_catalogs_replace_removed_models_and_empty_lists_but_errors_preserve_state() {
    let executable = std::path::PathBuf::from(
        std::env::var_os("DENO_TEST_EXECUTABLE").expect("set DENO_TEST_EXECUTABLE"),
    );
    let root = tempfile::tempdir().unwrap();
    let store = Store::connect(&format!(
        "sqlite://{}",
        root.path().join("test.db").display()
    ))
    .await
    .unwrap();
    let registry = PluginRegistry::in_directory(
        store,
        PluginRuntime::for_test(),
        "0.1.0".into(),
        root.path().to_owned(),
    )
    .unwrap();
    let directory = root.path().join("installed/catalog-fixture");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(directory.join("plugin.json"), r#"{"apiVersion":1,"id":"dev.catalog","name":"Catalog test","version":"0.1.0","minAppVersion":"0.1.0","entry":"main.ts","icon":"icon.svg","permissions":{"network":[]}}"#).unwrap();
    std::fs::write(
        directory.join("icon.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    std::fs::write(directory.join("main.ts"), r#"
      import {defineProviderPlugin} from 'cursor-byok:plugin';
      let call=0;
      defineProviderPlugin({providers:[{id:'catalog',displayName:'Catalog',providerType:'test',
        models:{list:async()=>{
          call++;
          if(call===1)return [{id:'current',displayName:'Current'},{id:'removed',displayName:'Removed'}];
          if(call===2)return [{id:'current',displayName:'Current'}];
          if(call===3)throw new Error('upstream failed');
          return [];
        }},invoke:async()=>({status:'completed'})
      }]});
    "#).unwrap();
    let entry = super::super::catalog::load_plugin(
        &directory,
        registry.inner.catalog.loader(),
        &executable,
        "0.1.0",
    )
    .await
    .unwrap();
    let provider = &entry.definition.providers[0];
    assert_eq!(
        registry
            .sync_provider_models(&entry, &executable, provider)
            .await
            .unwrap(),
        2
    );
    registry
        .inner
        .state
        .set_model_enabled("dev.catalog", "catalog", "current", false)
        .await
        .unwrap();
    assert_eq!(
        registry
            .sync_provider_models(&entry, &executable, provider)
            .await
            .unwrap(),
        1
    );
    let saved = registry
        .inner
        .state
        .models("dev.catalog", "catalog")
        .await
        .unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].id, "current");
    assert!(!saved[0].enabled);
    assert!(registry
        .sync_provider_models(&entry, &executable, provider)
        .await
        .is_err());
    let after_error = registry
        .inner
        .state
        .models("dev.catalog", "catalog")
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(after_error).unwrap(),
        serde_json::to_value(saved).unwrap()
    );
    assert_eq!(
        registry
            .sync_provider_models(&entry, &executable, provider)
            .await
            .unwrap(),
        0
    );
    assert!(registry
        .inner
        .state
        .models("dev.catalog", "catalog")
        .await
        .unwrap()
        .is_empty());
    for worker in registry.inner.workers.lock().await.values() {
        worker.stop().await;
    }
}
