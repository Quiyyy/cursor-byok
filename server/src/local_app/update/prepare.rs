//! Downloads and checks an update without changing the installed Cursor.
use super::*;
impl CursorHarness {
    pub(super) async fn prepare_cursor_update(&self, cancel: CancellationToken) -> Result<()> {
        let runtime = &self.inner.update;
        let current = package::Product::read(self.inner.native.app_path())?;
        let release = tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled),r=package::latest(&self.inner.store,&current)=>r?};
        let Some(release) = release else {
            runtime.phase(Phase::Idle);
            return Ok(());
        };
        self.prepare_verified_release(release, cancel).await
    }

    pub(super) async fn prepare_verified_release(
        &self,
        release: package::Release,
        cancel: CancellationToken,
    ) -> Result<()> {
        let runtime = &self.inner.update;
        if !verified::supports_version(&release.version) {
            let mut progress = runtime.progress.write();
            progress.phase = Phase::Unverified;
            progress.unverified_version = Some(release.version);
            return Ok(());
        }
        let directory = runtime.package_dir(&release);
        tokio::fs::create_dir_all(&directory).await?;
        let installer = directory.join("installer.exe");
        if let Ok(bytes) = tokio::fs::read(directory.join("ready.json")).await {
            if let Ok(prepared) = serde_json::from_slice::<Prepared>(&bytes) {
                if prepared.validate().is_ok()
                    && prepared.release.url == release.url
                    && prepared.patch_revision == NativeAgent::patch_revision()
                    && package::checksum(&installer).is_ok_and(|hash| hash == prepared.sha256)
                {
                    runtime.phase(Phase::Verifying);
                    tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled),r=windows::verify(&runtime.root,&installer)=>r?};
                    if cancel.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    let mut p = runtime.progress.write();
                    p.prepared = Some(prepared);
                    p.phase = Phase::Ready;
                    return Ok(());
                }
            }
        }
        if installer.exists() {
            tokio::fs::remove_file(&installer).await?;
        }
        runtime.phase(Phase::Downloading);
        let sha256 = package::download(
            &self.inner.store,
            &release,
            &installer,
            &cancel,
            |bytes, total| {
                let mut p = runtime.progress.write();
                p.bytes = bytes;
                p.total = total;
            },
        )
        .await?;
        runtime.phase(Phase::Verifying);
        tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled),r=windows::verify(&runtime.root,&installer)=>r?};
        runtime.phase(Phase::Extracting);
        let stage = format!("stage-{}", uuid::Uuid::new_v4());
        let destination = directory.join(&stage);
        let archive = installer.clone();
        let cancel_extract = cancel.clone();
        let app = tokio::task::spawn_blocking(move || {
            package::extract(&archive, &destination, &cancel_extract)
        })
        .await
        .map_err(|e| Error::Config(format!("Cursor extraction failed: {e}")))??;
        let product = package::Product::read(&app)?;
        if product.version != release.version
            || !verified::supports_build(&product.version, &product.commit)
        {
            return Err(Error::Config(
                "Cursor package is not the maintainer-verified build".into(),
            ));
        }
        runtime.phase(Phase::Validating);
        let check = tokio::select! {_=cancel.cancelled()=>return Err(Error::Cancelled),r=self.inner.native.check_candidate(&app)=>r?};
        let prepared = Prepared {
            release,
            sha256,
            stage,
            check,
            patch_revision: NativeAgent::patch_revision(),
        };
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        atomic_json(&directory.join("ready.json"), &prepared)?;
        let mut p = runtime.progress.write();
        p.prepared = Some(prepared);
        p.phase = Phase::Ready;
        Ok(())
    }
}
