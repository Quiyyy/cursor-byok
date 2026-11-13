//! Windows user-installer actions; no installer or window is force-terminated.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(super) struct Launch {
    pub args: Vec<String>,
}

pub(super) fn supported() -> bool {
    cfg!(all(target_os = "windows", target_arch = "x86_64"))
}
fn path_argument(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned()
    }
}

pub(super) async fn command(
    root: &Path,
    mode: &str,
    path: &Path,
    extra: &[String],
) -> Result<serde_json::Value> {
    if !supported() {
        return Err(Error::Config(
            "Cursor update management supports Windows x64 only".into(),
        ));
    }
    let script = root.join("windows.ps1");
    std::fs::create_dir_all(root)?;
    let source = include_str!("windows.ps1");
    if !std::fs::read(&script).is_ok_and(|bytes| bytes == source.as_bytes()) {
        std::fs::write(&script, source)?;
    }
    let mut cmd = tokio::process::Command::new("powershell.exe");
    hide(&mut cmd);
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ])
    .arg(script)
    .args(["-Mode", mode, "-Path"])
    .arg(path_argument(path))
    .args(extra)
    .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(90), cmd.output())
        .await
        .map_err(|_| Error::Config(format!("Cursor {mode} timed out")))??;
    if !output.status.success() {
        return Err(Error::Config(
            String::from_utf8_lossy(&output.stderr).trim().into(),
        ));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}
pub(super) fn hide(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    #[cfg(not(windows))]
    let _ = cmd;
}
pub(super) async fn verify(root: &Path, installer: &Path) -> Result<()> {
    command(root, "signature", installer, &[]).await?;
    Ok(())
}
pub(super) async fn close(root: &Path, executable: &Path) -> Result<Launch> {
    Ok(serde_json::from_value(
        command(root, "close", executable, &[]).await?,
    )?)
}
pub(super) async fn running(root: &Path, executable: &Path) -> Result<bool> {
    Ok(command(root, "running", executable, &[]).await?["running"]
        .as_bool()
        .unwrap_or(false))
}
pub(super) async fn installer_running(
    root: &Path,
    installer: &Path,
    pid: u32,
    since: i64,
) -> Result<bool> {
    Ok(command(
        root,
        "installer-running",
        installer,
        &[
            "-ProcessId".into(),
            pid.to_string(),
            "-StartedAfter".into(),
            since.to_string(),
        ],
    )
    .await?["running"]
        .as_bool()
        .unwrap_or(false))
}
pub(super) fn installer_command(
    installer: &Path,
    installation: &Path,
    log: &Path,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(installer);
    hide(&mut cmd);
    // runcode is the Inno post-install launch task; NORESTART alone only controls Windows reboots.
    cmd.args([
        "/SP-",
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART",
        "/NORESTARTAPPLICATIONS",
        "/NOCLOSEAPPLICATIONS",
        "/MERGETASKS=!runcode",
    ])
    .arg(format!("/DIR={}", path_argument(installation)))
    .arg(format!("/LOG={}", path_argument(log)));
    cmd
}
pub(super) async fn launch(executable: &Path, launch: &Launch) -> Result<()> {
    let mut cmd = tokio::process::Command::new(executable);
    cmd.args(&launch.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn()?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    if let Some(status) = child.try_wait()? {
        return Err(Error::Config(format!(
            "Cursor exited immediately after update: {status}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    async fn native_close_preserves_arguments_and_respects_refusal() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("window.cs");
        std::fs::write(&source, include_str!("fixtures/window.cs")).unwrap();
        let executable = dir.path().join("Cursor.exe");
        let compiler = std::path::PathBuf::from(std::env::var_os("WINDIR").unwrap())
            .join("Microsoft.NET/Framework64/v4.0.30319/csc.exe");
        let mut compile = tokio::process::Command::new(compiler);
        hide(&mut compile);
        let output = compile
            .args(["/nologo", "/target:winexe"])
            .arg(format!("/out:{}", executable.display()))
            .arg(&source)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        for mode in ["accept", "refuse"] {
            let ready = dir.path().join(format!("{mode}.ready"));
            let args = vec![
                mode.to_owned(),
                ready.to_string_lossy().into_owned(),
                "--user-data-dir".into(),
                "C:/isolated profile with spaces".into(),
            ];
            let mut command = tokio::process::Command::new(&executable);
            hide(&mut command);
            let mut child = command.args(&args).kill_on_drop(true).spawn().unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                while !ready.exists() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            })
            .await
            .unwrap();
            let result = close(dir.path(), &executable).await;
            if mode == "accept" {
                assert_eq!(result.unwrap().args, args);
                assert!(child.wait().await.unwrap().success());
            } else {
                assert!(result
                    .unwrap_err()
                    .to_string()
                    .contains("Cursor did not exit"));
                assert!(
                    child.try_wait().unwrap().is_none(),
                    "a refused close must not force-terminate Cursor"
                );
                child.kill().await.unwrap();
                child.wait().await.unwrap();
            }
        }
    }

    #[test]
    fn installation_never_asks_inno_to_launch_or_force_close_cursor() {
        let command = installer_command(
            Path::new("installer.exe"),
            Path::new("C:/Cursor Test"),
            Path::new("log.txt"),
        );
        let args = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(args.contains(&"/MERGETASKS=!runcode".into()));
        assert!(args.contains(&"/NORESTARTAPPLICATIONS".into()));
        assert!(args.contains(&"/NOCLOSEAPPLICATIONS".into()));
        assert!(!args.iter().any(|s| s == "/FORCECLOSEAPPLICATIONS"));
        assert!(args.contains(&"/DIR=C:/Cursor Test".into()));
    }
}
