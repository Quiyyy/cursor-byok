use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) async fn isolated_harness(root: &std::path::Path, ready: bool) -> CursorHarness {
    std::fs::create_dir_all(root).unwrap();
    let store = Store::connect(&format!("sqlite://{}", root.join("test.db").display()))
        .await
        .unwrap();
    CursorHarness {
        inner: Arc::new(Inner {
            native: NativeAgent::in_directory(
                root.join("cursor/resources/app"),
                root.join("data/native-agent"),
            ),
            store,
            ca: ca::CaManager::fixture(root.join("ca"), ready).unwrap(),
            ca_initialization: Mutex::new(()),
            backend_addr: RwLock::new(None),
            tab_mode: Arc::new(RwLock::new(TabMode::default())),
            proxy: Mutex::new(ProxyRuntime::default()),
            restart_required: AtomicBool::new(false),
            operation: Arc::new(Mutex::new(())),
            update: update::Runtime::new(root.join("data/cursor-update")),
        }),
    }
}

#[tokio::test]
async fn status_is_read_only_and_takeover_changes_do_not_overlap_updates() {
    let directory = tempfile::tempdir().unwrap();
    let harness = isolated_harness(directory.path(), false).await;
    harness.set_backend_addr("127.0.0.1:1".parse().unwrap());
    let _update = harness.inner.operation.lock().await;
    let status = tokio::time::timeout(std::time::Duration::from_millis(250), harness.status())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(status.integration, IntegrationState::Disabled));
    assert!(!directory.path().join("data/native-agent").exists());
    assert!(matches!(
        harness.set_enabled(false).await,
        Err(Error::Busy(_))
    ));
    assert!(harness.inner.store.cursor_takeover_enabled().await.unwrap());
}

#[tokio::test]
async fn startup_restores_saved_takeover_without_a_status_request() {
    let directory = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}", directory.path().join("test.db").display());
    let previous = Store::connect(&url).await.unwrap();
    previous.set_cursor_takeover_enabled(true).await.unwrap();
    drop(previous);

    let store = Store::connect(&url).await.unwrap();
    let restored = AtomicBool::new(false);
    restore_saved_takeover(&store, async {
        restored.store(true, Ordering::Relaxed);
        Ok(())
    })
    .await
    .unwrap();
    assert!(restored.load(Ordering::Relaxed));

    let error = restore_saved_takeover(&store, async {
        Err(Error::Config("unsupported Cursor runtime".into()))
    })
    .await
    .unwrap_err();
    assert!(error.to_string().contains("unsupported Cursor runtime"));
    assert!(store.cursor_takeover_enabled().await.unwrap());

    store.set_cursor_takeover_enabled(false).await.unwrap();
    restore_saved_takeover(&store, async {
        panic!("disabled takeover must not install or close Cursor");
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn closing_cursor_failure_is_actionable_and_remains_pending_on_retry() {
    for (native_changed, settings_applied) in [(true, true), (false, false)] {
        let pending = AtomicBool::new(false);
        let error = close_cursor_if_needed(&pending, native_changed || !settings_applied, async {
            Err(Error::Config("access denied".into()))
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("完全退出 Cursor"), "{error}");
        assert!(error.to_string().contains("access denied"), "{error}");
        assert!(pending.load(Ordering::Relaxed));

        // Files and proxy settings can already match after the failed attempt.
        // That must not suppress the close attempt on the next enable/status call.
        let error = close_cursor_if_needed(&pending, false, async {
            Err(Error::Config("still running".into()))
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("still running"));

        let closed = AtomicBool::new(false);
        close_cursor_if_needed(&pending, false, async {
            closed.store(true, Ordering::Relaxed);
            Ok(())
        })
        .await
        .unwrap();
        assert!(closed.load(Ordering::Relaxed));
        assert!(!pending.load(Ordering::Relaxed));
        close_cursor_if_needed(&pending, false, async {
            panic!("unchanged, active takeover must not close Cursor again");
        })
        .await
        .unwrap();
    }
}
