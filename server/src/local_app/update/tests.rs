use super::*;

fn prepared() -> Prepared {
    Prepared {
        release: package::Release {
            version: "3.27.14".into(),
            url: "https://downloads.cursor.com/production/fixture/win32/x64/user-setup/Cursor.exe"
                .into(),
        },
        sha256: "a".repeat(64),
        patch_revision: "b".repeat(64),
        stage: format!("stage-{}", uuid::Uuid::new_v4()),
        check: NativeCheck {
            version: "3.27.14".into(),
            commit: "c".repeat(40),
            files: Vec::new(),
        },
    }
}
#[test]
fn interrupted_operation_survives_restart_and_rejects_unsafe_cache_paths() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::new(dir.path().to_path_buf());
    let operation = Operation {
        phase: Phase::Installing,
        old_version: "3.26.16".into(),
        prepared: prepared(),
        launch: windows::Launch {
            args: vec!["--user-data-dir".into(), "C:/test profile".into()],
        },
        installer_pid: Some(123),
        installer_started_ms: 42,
    };
    runtime.journal(&operation).unwrap();
    let reopened = Runtime::new(dir.path().to_path_buf());
    let saved = reopened.operation().unwrap().unwrap();
    assert_eq!(saved.phase, Phase::Installing);
    assert_eq!(saved.installer_pid, Some(123));
    assert_eq!(saved.launch.args, operation.launch.args);
    let mut invalid = operation;
    invalid.prepared.stage = "../../outside".into();
    runtime.journal(&invalid).unwrap();
    assert!(reopened.operation().is_err());
}
#[test]
fn candidate_identity_changes_with_installer_or_patch_revision() {
    let original = prepared();
    let mut changed = original.clone();
    changed.sha256 = "d".repeat(64);
    assert_ne!(original.candidate().id, changed.candidate().id);
    changed = original.clone();
    changed.patch_revision = "e".repeat(64);
    assert_ne!(original.candidate().id, changed.candidate().id);
}
#[tokio::test]
async fn pending_installation_blocks_new_checks_and_new_takeover_writes() {
    let dir = tempfile::tempdir().unwrap();
    let harness = crate::local_app::tests::isolated_harness(dir.path(), false).await;
    let operation = Operation {
        phase: Phase::Installing,
        old_version: "3.26.16".into(),
        prepared: prepared(),
        launch: windows::Launch::default(),
        installer_pid: None,
        installer_started_ms: 42,
    };
    harness.inner.update.journal(&operation).unwrap();
    assert!(matches!(
        harness.check_cursor_update().await,
        Err(Error::Busy(_))
    ));
    assert!(matches!(
        harness.set_enabled(true).await,
        Err(Error::Busy(_))
    ));
    assert!(matches!(
        harness.cancel_cursor_update_check().await,
        Err(Error::Busy(_))
    ));
    assert!(!dir.path().join("data/native-agent").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn installer_recovery_matches_both_pid_and_executable() {
    let dir = tempfile::tempdir().unwrap();
    let exe = std::env::current_exe().unwrap();
    let pid = std::process::id();
    assert!(windows::installer_running(dir.path(), &exe, pid, 0)
        .await
        .unwrap());
    assert!(!windows::installer_running(
        dir.path(),
        &exe,
        pid,
        chrono::Utc::now().timestamp_millis() + 60_000
    )
    .await
    .unwrap());
    assert!(
        !windows::installer_running(dir.path(), &dir.path().join("different.exe"), pid, 0)
            .await
            .unwrap()
    );
}
