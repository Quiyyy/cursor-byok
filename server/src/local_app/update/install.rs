//! Owns the close → official install → patch → launch sequence and interrupted recovery.
use super::*;
impl CursorHarness {
    pub async fn install_cursor_update(&self, expected_id: &str) -> Result<Status> {
        if self.inner.update.pending() {
            return Err(Error::Busy(
                "Recover the interrupted Cursor update first".into(),
            ));
        }
        if !self.inner.store.cursor_takeover_enabled().await? {
            return Err(Error::Config(
                "Enable Cursor takeover before updating with BYOK".into(),
            ));
        }
        let gate = self
            .inner
            .update
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| Error::Busy("Cursor update task is already running".into()))?;
        let operation = self
            .inner
            .operation
            .clone()
            .try_lock_owned()
            .map_err(|_| Error::Busy("Cursor takeover is changing".into()))?;
        self.inner.update.ensure_accepting()?;
        let status = self.status().await?;
        if !matches!(
            status.integration,
            crate::local_app::IntegrationState::Enabled
        ) || !matches!(status.ca, crate::local_app::CaState::Ready)
        {
            return Err(Error::Config(
                "Restore Cursor takeover before installing the update".into(),
            ));
        }
        let prepared = self
            .inner
            .update
            .progress
            .read()
            .prepared
            .clone()
            .ok_or_else(|| Error::Config("Check the Cursor update before installing".into()))?;
        if prepared.candidate().id != expected_id
            || prepared.patch_revision != NativeAgent::patch_revision()
        {
            return Err(Error::Config(
                "The checked Cursor update changed; check again".into(),
            ));
        }
        self.inner.update.phase(Phase::Verifying);
        self.inner.update.progress.write().error = None;
        let harness = self.clone();
        tokio::spawn(async move {
            let (_gate, _operation) = (gate, operation);
            let result = harness.perform_cursor_update(prepared).await;
            harness.inner.update.finish(result);
        });
        self.cursor_update_status().await
    }
    pub(super) async fn perform_cursor_update(&self, prepared: Prepared) -> Result<()> {
        prepared.validate()?;
        let runtime = &self.inner.update;
        let current = package::Product::read(self.inner.native.app_path())?;
        if semver::Version::parse(&prepared.check.version).unwrap()
            <= semver::Version::parse(&current.version).unwrap()
        {
            return Err(Error::Config(
                "Cursor is already at this version or newer".into(),
            ));
        }
        let installer = runtime.package_dir(&prepared.release).join("installer.exe");
        if package::checksum(&installer)? != prepared.sha256 {
            return Err(Error::Config(
                "Cursor installer changed after preflight".into(),
            ));
        }
        windows::verify(&runtime.root, &installer).await?;
        let executable =
            crate::local_app::native_agent::cursor_executable(self.inner.native.app_path())
                .canonicalize()?;
        runtime.phase(Phase::Closing);
        let launch = windows::close(&runtime.root, &executable).await?;
        let after_close = package::Product::read(self.inner.native.app_path())?;
        if after_close.version != current.version || after_close.commit != current.commit {
            return Err(Error::Config(
                "Cursor changed while closing; check the update again".into(),
            ));
        }
        let mut operation = Operation {
            phase: Phase::Installing,
            old_version: current.version,
            prepared,
            launch,
            installer_pid: None,
            installer_started_ms: chrono::Utc::now().timestamp_millis() - 1000,
        };
        runtime.journal(&operation)?;
        self.inner.native.invalidate().await;
        runtime.phase(Phase::Installing);
        let log = runtime.root.join("installer.log");
        let mut child =
            windows::installer_command(&installer, executable.parent().unwrap(), &log).spawn()?;
        operation.installer_pid = child.id();
        runtime.journal(&operation)?;
        // Do not kill an official installer on client disconnect, app-window close or timeout.
        let status = tokio::time::timeout(std::time::Duration::from_secs(600),child.wait()).await
            .map_err(|_|Error::Config("Cursor installer is taking too long; it has not been terminated. Wait for it to finish, then recover takeover".into()))??;
        if !status.success() {
            return Err(Error::Config(format!(
                "Cursor installer failed ({status}); log: {}",
                log.display()
            )));
        }
        self.inner
            .native
            .verify_originals(&operation.prepared.check)?;
        self.complete_cursor_update(&mut operation).await
    }
    async fn complete_cursor_update(&self, operation: &mut Operation) -> Result<()> {
        let runtime = &self.inner.update;
        let executable =
            crate::local_app::native_agent::cursor_executable(self.inner.native.app_path())
                .canonicalize()?;
        if windows::running(&runtime.root, &executable).await? {
            return Err(Error::Config(
                "Cursor was opened during the update. Close it, then recover takeover".into(),
            ));
        }
        runtime.phase(Phase::Patching);
        operation.phase = Phase::Patching;
        runtime.journal(operation)?;
        let address = self
            .inner
            .backend_addr
            .read()
            .ok_or_else(|| Error::Config("BYOK server is not ready".into()))?;
        if self.inner.store.cursor_takeover_enabled().await? {
            self.inner.native.enable(address).await?;
            if package::Product::read(self.inner.native.app_path())?.version
                == operation.prepared.check.version
            {
                self.inner
                    .native
                    .verify_updated(&operation.prepared.check)
                    .await?;
            }
            self.inner.native.verify_catalog().await?;
            self.enable_transport(address).await?;
        } else {
            self.inner.native.disable().await?;
            settings::clear_proxy_settings()?;
            self.inner.proxy.lock().await.stop().await;
        }
        runtime.phase(Phase::Starting);
        operation.phase = Phase::Starting;
        runtime.journal(operation)?;
        windows::launch(&executable, &operation.launch).await?;
        tokio::fs::remove_file(runtime.operation_path()).await?;
        self.inner
            .restart_required
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let mut progress = runtime.progress.write();
        progress.phase = Phase::Complete;
        progress.prepared = None;
        progress.error = None;
        Ok(())
    }
    pub async fn recover_cursor_update(&self) -> Result<Status> {
        if !self.inner.update.pending() {
            return Err(Error::Config(
                "There is no interrupted Cursor update to recover".into(),
            ));
        }
        let gate = self
            .inner
            .update
            .gate
            .clone()
            .try_lock_owned()
            .map_err(|_| Error::Busy("Cursor update task is already running".into()))?;
        let operation = self
            .inner
            .operation
            .clone()
            .try_lock_owned()
            .map_err(|_| Error::Busy("Cursor takeover is changing".into()))?;
        self.inner.update.ensure_accepting()?;
        self.inner.update.phase(Phase::Verifying);
        self.inner.update.progress.write().error = None;
        let harness = self.clone();
        tokio::spawn(async move {
            let (_gate, _operation) = (gate, operation);
            let result = harness.recover_cursor_update_locked().await;
            harness.inner.update.finish(result);
        });
        self.cursor_update_status().await
    }
    pub(in crate::local_app) async fn recover_cursor_update_locked(&self) -> Result<()> {
        let runtime = &self.inner.update;
        let Some(mut operation) = runtime.operation()? else {
            return Ok(());
        };
        let installer = runtime
            .package_dir(&operation.prepared.release)
            .join("installer.exe");
        {
            if windows::installer_running(
                &runtime.root,
                &installer,
                operation.installer_pid.unwrap_or(0),
                operation.installer_started_ms,
            )
            .await?
            {
                return Err(Error::Busy(
                    "The previous Cursor installer is still running; wait and recover again".into(),
                ));
            }
        }
        let current = package::Product::read(self.inner.native.app_path())?;
        if current.version != operation.prepared.check.version
            && current.version != operation.old_version
        {
            return Err(Error::Config("Cursor version changed outside the interrupted update; inspect the installation before retrying".into()));
        }
        if current.version == operation.prepared.check.version
            && operation.prepared.patch_revision != NativeAgent::patch_revision()
        {
            let app = runtime
                .package_dir(&operation.prepared.release)
                .join(&operation.prepared.stage)
                .join("resources/app");
            operation.prepared.check = self.inner.native.check_candidate(&app).await?;
            operation.prepared.patch_revision = NativeAgent::patch_revision();
            runtime.journal(&operation)?;
        }
        self.complete_cursor_update(&mut operation).await
    }
}
