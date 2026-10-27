//! Explicit, ignored Windows acceptance. Runs only as a disposable local account.
//! Certificate trust is an isolated test fixture; Windows trust stores are not modified.
use super::*;
use serde_json::{json, Value};
use std::time::Duration;

async fn api(
    client: &reqwest::Client,
    base: &str,
    method: reqwest::Method,
    path: &str,
    body: Value,
) -> Value {
    let response = client
        .request(method, format!("{base}/__byok-api__/api{path}"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let value: Value = response.json().await.unwrap();
    assert!(status.is_success(), "{path}: {status}: {value}");
    value
}
async fn settled(client: &reqwest::Client, base: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    loop {
        let value = api(
            client,
            base,
            reqwest::Method::GET,
            "/cursor-update",
            Value::Null,
        )
        .await;
        if value["busy"] == false {
            return value;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Cursor update did not settle: {value}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires disposable ByokProof_* Windows account, CURSOR_UPDATE_E2E_ROOT and CURSOR_UPDATE_E2E_INPUT"]
async fn windows_user_update_acceptance() {
    let identity = tokio::process::Command::new("whoami.exe")
        .output()
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&identity.stdout)
            .to_lowercase()
            .contains("\\byokproof_"),
        "never run installers as the daily user"
    );
    let root = PathBuf::from(std::env::var_os("CURSOR_UPDATE_E2E_ROOT").unwrap());
    let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("target/cursor-update-acceptance");
    assert!(root.is_absolute() && root.starts_with(expected));
    let input = PathBuf::from(std::env::var_os("CURSOR_UPDATE_E2E_INPUT").unwrap());
    let harness = crate::local_app::tests::isolated_harness(&root, true).await;
    let baseline = input.join("CursorUserSetup-3.26.16.exe");
    windows::verify(&harness.inner.update.root, &baseline)
        .await
        .unwrap();
    let mut install = windows::installer_command(
        &baseline,
        &root.join("cursor"),
        &root.join("baseline-install.log"),
    );
    assert!(install.status().await.unwrap().success());
    assert_eq!(
        package::Product::read(harness.inner.native.app_path())
            .unwrap()
            .version,
        "3.26.16"
    );
    let profile = root.join("roaming/Cursor");
    std::fs::create_dir_all(profile.join("User")).unwrap();
    let original =
        json!({"update.mode":"start","cursor.agentHost.updateMode":"none","editor.fontSize":14});
    std::fs::write(
        profile.join("User/settings.json"),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    let store = harness.inner.store.clone();
    let runtime = crate::plugin::PluginRuntime::in_directory(root.join("runtime")).unwrap();
    let plugins = crate::plugin::PluginRegistry::in_directory(
        store.clone(),
        runtime.clone(),
        "test".into(),
        root.join("plugins"),
    )
    .unwrap();
    let clients = crate::network::NetworkClients::new(store.clone());
    let provider = Arc::new(crate::provider::ProviderRouter::new(
        store.clone(),
        plugins.clone(),
        clients.clone(),
        Duration::from_secs(10),
        Duration::from_secs(10),
    ));
    let control =
        crate::control::ControlService::new(store.clone(), provider, runtime, plugins, clients)
            .unwrap()
            .with_test_harness(harness.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    harness.set_backend_addr(address);
    let frontend = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("apps/desktop/dist");
    let server = tokio::spawn(async move {
        axum::serve(listener, crate::control::web_router(control, &frontend))
            .await
            .unwrap()
    });
    let base = format!("http://{address}");
    std::fs::write(
        root.join("service-ready.json"),
        serde_json::to_vec(&json!({"base":base})).unwrap(),
    )
    .unwrap();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(180))
        .build()
        .unwrap();
    api(
        &client,
        &base,
        reqwest::Method::PUT,
        "/harness/cursor/enabled",
        json!({"enabled":true}),
    )
    .await;

    // The public HTTP check must keep serving requests, and cancellation must not
    // leave a ready candidate or modify the installed resources.
    let fingerprint =
        package::checksum(&harness.inner.native.app_path().join("product.json")).unwrap();
    api(
        &client,
        &base,
        reqwest::Method::POST,
        "/cursor-update/check",
        Value::Null,
    )
    .await;
    api(
        &client,
        &base,
        reqwest::Method::POST,
        "/cursor-update/cancel",
        Value::Null,
    )
    .await;
    let cancelled = settled(&client, &base).await;
    assert_eq!(cancelled["phase"], "idle");
    assert!(cancelled["candidate"].is_null());
    assert_eq!(
        fingerprint,
        package::checksum(&harness.inner.native.app_path().join("product.json")).unwrap()
    );

    api(
        &client,
        &base,
        reqwest::Method::PUT,
        "/cursor-update",
        json!({"enabled":true}),
    )
    .await;
    let ready = settled(&client, &base).await;
    assert_eq!(ready["phase"], "ready", "{ready}");
    let candidate = ready["candidate"].clone();
    let prepared = harness
        .inner
        .update
        .progress
        .read()
        .prepared
        .clone()
        .unwrap();
    let managed = settings::read().unwrap();
    assert_eq!(managed["update.mode"], "none");
    assert_eq!(managed["cursor.agentHost.updateMode"], "none");

    // A window that refuses WM_CLOSE models cancellation of Cursor's save/exit
    // dialog. The same production close routine must fail without force killing
    // it or starting the official installer.
    let executable =
        crate::local_app::native_agent::cursor_executable(harness.inner.native.app_path())
            .canonicalize()
            .unwrap();
    let original_executable = root.join("original-Cursor.exe");
    std::fs::copy(&executable, &original_executable).unwrap();
    let source = root.join("refuse_close.cs");
    std::fs::write(&source, include_str!("fixtures/refuse_close.cs")).unwrap();
    let fake = root.join("refuse-close.exe");
    let script = root.join("compile-fixture.ps1");
    std::fs::write(&script,"param($Source,$Output)\n$ErrorActionPreference='Stop'\n$compiler=Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'\n& $compiler '/nologo' '/target:winexe' '/platform:x64' ('/out:'+$Output) $Source\nexit $LASTEXITCODE\n").unwrap();
    let mut compile = tokio::process::Command::new("powershell.exe");
    windows::hide(&mut compile);
    let output = compile
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .arg(source)
        .arg(&fake)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::copy(&fake, &executable).unwrap();
    let mut refusal = tokio::process::Command::new(&executable).spawn().unwrap();
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(
        refusal.try_wait().unwrap().is_none(),
        "close-cancellation fixture exited before the check"
    );
    assert!(
        windows::running(&harness.inner.update.root, &executable)
            .await
            .unwrap(),
        "running Cursor must be detected even with a canonical Windows path"
    );
    api(
        &client,
        &base,
        reqwest::Method::POST,
        "/cursor-update/install",
        json!({"candidate_id":candidate["id"]}),
    )
    .await;
    let refused = settled(&client, &base).await;
    assert_eq!(refused["phase"], "failed");
    assert!(
        refused["error"].as_str().unwrap().contains("did not exit"),
        "{refused}"
    );
    assert!(refusal.try_wait().unwrap().is_none());
    assert!(!harness.inner.update.root.join("installer.log").exists());
    assert!(!harness.inner.update.pending());
    refusal.kill().await.unwrap();
    refusal.wait().await.unwrap();
    std::fs::copy(&original_executable, &executable).unwrap();

    let workspace = root.join("workspace 中文");
    std::fs::create_dir_all(&workspace).unwrap();
    let launch = windows::Launch {
        args: vec![
            "--user-data-dir".into(),
            profile.display().to_string(),
            "--extensions-dir".into(),
            root.join("extensions").display().to_string(),
            "--new-window".into(),
            "--skip-welcome".into(),
            "--skip-release-notes".into(),
            workspace.display().to_string(),
        ],
    };
    windows::launch(&executable, &launch).await.unwrap();
    tokio::time::sleep(Duration::from_secs(15)).await;
    let normal_start = chrono::Utc::now().to_rfc3339();
    api(
        &client,
        &base,
        reqwest::Method::POST,
        "/cursor-update/install",
        json!({"candidate_id":candidate["id"]}),
    )
    .await;
    let complete = settled(&client, &base).await;
    assert_eq!(complete["phase"], "complete", "{complete}");
    assert_eq!(complete["current_version"], candidate["version"]);
    assert!(!harness.inner.update.pending());
    harness
        .inner
        .native
        .verify_updated(&prepared.check)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_secs(8)).await;
    let normal_end = chrono::Utc::now().to_rfc3339();
    let active = api(
        &client,
        &base,
        reqwest::Method::GET,
        "/harness/cursor/status",
        Value::Null,
    )
    .await;
    assert_eq!(active["integration"], "enabled");
    let mut settings_now = settings::read().unwrap();
    settings_now.insert("update.mode".into(), json!("manual"));
    settings::write(&settings_now).unwrap();
    api(
        &client,
        &base,
        reqwest::Method::PUT,
        "/cursor-update",
        json!({"enabled":false}),
    )
    .await;
    let restored = settings::read().unwrap();
    assert_eq!(restored["update.mode"], "manual");
    assert_eq!(restored["editor.fontSize"], 14);
    assert!(!restored.contains_key("update.enableWindowsBackgroundUpdates"));
    let relaunch = windows::close(&harness.inner.update.root, &executable)
        .await
        .unwrap();
    harness.disable().await.unwrap();
    let installer_log = harness.inner.update.root.join("installer.log");
    let log_hash = package::checksum(&installer_log).unwrap();
    let operation = Operation {
        phase: Phase::Patching,
        old_version: "3.26.16".into(),
        prepared: prepared.clone(),
        launch: relaunch,
        installer_pid: None,
        installer_started_ms: chrono::Utc::now().timestamp_millis(),
    };
    harness.inner.update.journal(&operation).unwrap();
    server.abort();
    let resumed = crate::local_app::tests::isolated_harness(&root, true).await;
    resumed.set_backend_addr(address);
    resumed.restore().await.unwrap();
    assert!(!resumed.inner.update.pending());
    resumed
        .inner
        .native
        .verify_updated(&prepared.check)
        .await
        .unwrap();
    assert_eq!(
        package::checksum(&installer_log).unwrap(),
        log_hash,
        "recovery must not run the installer again"
    );
    windows::close(&resumed.inner.update.root, &executable)
        .await
        .unwrap();
    resumed.disable().await.unwrap();
    let report = json!({"passed":true,"baseline":"3.26.16","target":candidate["version"],"cancel_check":true,"cancel_close_keeps_old_installation":true,"update_http_api":true,"normal_update_started":normal_start,"normal_update_completed":normal_end,"native_patch_verified":true,"settings_restored_preserving_user_edits":true,"interrupted_patch_recovered_without_reinstall":true,"system_certificate_store_modified":false,"real_provider_calls":false});
    std::fs::write(
        root.join("acceptance.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("{}", report);
}
