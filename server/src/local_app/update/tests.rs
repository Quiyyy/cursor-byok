use super::*;

async fn harness(root: &Path) -> CursorHarness {
    let store =
        crate::store::Store::connect(&format!("sqlite://{}", root.join("test.db").display()))
            .await
            .unwrap();
    CursorHarness {
        inner: Arc::new(super::super::Inner {
            native: NativeAgent::in_directory(
                root.join("cursor/resources/app"),
                root.join("data/native"),
            ),
            clients: crate::network::NetworkClients::new(store.clone()),
            store,
            ca: super::super::ca::CaManager::in_directory(root.join("ca")),
            ca_initialization: Mutex::new(()),
            lifecycle: Arc::new(Mutex::new(())),
            update: Runtime::new(root.join("updates")),
            backend_addr: RwLock::new(None),
            tab_mode: Arc::new(RwLock::new(Default::default())),
            proxy: Mutex::new(Default::default()),
        }),
    }
}

fn prepared() -> Prepared {
    Prepared {
        release: package::Release {
            version: verified::latest().version.into(),
            url: "https://downloads.cursor.com/production/fixture/win32/x64/user-setup/Cursor.exe"
                .into(),
        },
        sha256: "a".repeat(64),
        patch_revision: "b".repeat(64),
        stage: format!("stage-{}", uuid::Uuid::new_v4()),
        check: NativeCheck {
            version: verified::latest().version.into(),
            commit: verified::latest().commit.into(),
            files: Vec::new(),
        },
    }
}

#[tokio::test]
async fn unverified_release_never_downloads_or_creates_an_install_candidate() {
    let directory = tempfile::tempdir().unwrap();
    let h = harness(directory.path()).await;
    h.prepare_verified_release(
        package::Release {
            version: "3.30.8".into(),
            url: "https://downloads.cursor.com/production/not-used/win32/x64/user-setup/Cursor.exe"
                .into(),
        },
        CancellationToken::new(),
    )
    .await
    .unwrap();
    let status = h.cursor_update_status().await.unwrap();
    assert_eq!(status.phase, Phase::Unverified);
    assert_eq!(status.unverified_version.as_deref(), Some("3.30.8"));
    assert!(status.candidate.is_none());
    assert!(!h.inner.update.root.exists());
    assert!(!h.inner.store.cursor_takeover_enabled().await.unwrap());
}

#[test]
fn interrupted_operation_retains_its_installer_and_rejects_unverified_builds() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(dir.path().to_path_buf());
    let mut operation = Operation {
        phase: Phase::Installing,
        old_version: "3.27.14".into(),
        prepared: prepared(),
        launch: windows::Launch {
            args: vec!["--user-data-dir".into(), "C:/test profile".into()],
        },
        installer_pid: Some(123),
        installer_started_ms: 42,
    };
    runtime.journal(&operation).unwrap();
    let reopened = Runtime::new(dir.path().to_path_buf())
        .operation()
        .unwrap()
        .unwrap();
    assert_eq!(reopened.installer_pid, Some(123));
    assert_eq!(reopened.launch.args, operation.launch.args);
    operation.prepared.check.commit = "unknown".into();
    runtime.journal(&operation).unwrap();
    assert!(runtime.operation().is_err());
    operation.prepared = prepared();
    operation.prepared.stage = "../../outside".into();
    runtime.journal(&operation).unwrap();
    assert!(runtime.operation().is_err());
}

#[tokio::test]
async fn pending_updates_block_new_checks_and_takeover_enablement() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(dir.path()).await;
    h.inner
        .update
        .journal(&Operation {
            phase: Phase::Installing,
            old_version: "3.27.14".into(),
            prepared: prepared(),
            launch: windows::Launch::default(),
            installer_pid: None,
            installer_started_ms: 42,
        })
        .unwrap();
    assert!(matches!(h.check_cursor_update().await, Err(Error::Busy(_))));
    assert!(matches!(h.set_enabled(true).await, Err(Error::Busy(_))));
    assert!(!dir.path().join("data/native").exists());
}

#[test]
fn shutdown_cancels_preflight_and_rejects_new_work() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(dir.path().to_path_buf());
    let token = CancellationToken::new();
    *runtime.cancel.write() = Some(token.clone());
    runtime.stop();
    assert!(token.is_cancelled());
    assert!(matches!(runtime.ensure_accepting(), Err(Error::Busy(_))));
}

#[cfg(windows)]
#[tokio::test]
async fn startup_does_not_retry_an_incomplete_installation_without_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let h = harness(dir.path()).await;
    let app = h.inner.native.app_path();
    std::fs::create_dir_all(app).unwrap();
    let product = serde_json::json!({
        "nameShort": "Cursor", "target": "user", "quality": "stable",
        "version": "3.27.14", "commit": "old-build"
    });
    std::fs::write(app.join("product.json"), product.to_string()).unwrap();
    let mut pe = [0_u8; 70];
    pe[..2].copy_from_slice(b"MZ");
    pe[60..64].copy_from_slice(&64_u32.to_le_bytes());
    pe[64..68].copy_from_slice(b"PE\0\0");
    pe[68..70].copy_from_slice(&0x8664_u16.to_le_bytes());
    std::fs::write(app.join("../../Cursor.exe"), pe).unwrap();
    let operation = Operation {
        phase: Phase::Installing,
        old_version: "3.27.14".into(),
        prepared: prepared(),
        launch: windows::Launch::default(),
        installer_pid: None,
        installer_started_ms: chrono::Utc::now().timestamp_millis(),
    };
    h.inner.update.journal(&operation).unwrap();
    let before = std::fs::read(h.inner.update.operation_path()).unwrap();
    let error = h.recover_cursor_update_locked(false).await.unwrap_err();
    assert!(error.to_string().contains("confirm recovery"), "{error}");
    assert_eq!(
        std::fs::read(h.inner.update.operation_path()).unwrap(),
        before
    );
    assert_eq!(std::fs::read(app.join("../../Cursor.exe")).unwrap(), pe);
    assert!(!dir.path().join("data/native").exists());
    assert!(!h.inner.update.root.join("packages").exists());
}
