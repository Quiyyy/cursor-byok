//! Terminates the Cursor desktop process before an explicit takeover.

use tokio::process::Command;

use crate::{Error, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_console(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

pub async fn terminate_cursor() -> Result<()> {
    terminate_platform_cursor().await
}

#[cfg(target_os = "macos")]
async fn terminate_platform_cursor() -> Result<()> {
    terminate_unix_process("Cursor").await
}

#[cfg(target_os = "linux")]
async fn terminate_platform_cursor() -> Result<()> {
    terminate_unix_process("cursor").await?;
    terminate_unix_process("Cursor").await
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
async fn terminate_unix_process(name: &str) -> Result<()> {
    let running = Command::new("pgrep").args(["-x", name]).status().await?;
    if !running.success() {
        return match running.code() {
            Some(1) => Ok(()),
            _ => Err(Error::Config(format!(
                "failed to inspect the {name} process"
            ))),
        };
    }
    let terminated = Command::new("pkill").args(["-x", name]).status().await?;
    if terminated.success() || terminated.code() == Some(1) {
        Ok(())
    } else {
        Err(Error::Config(format!(
            "failed to terminate the {name} process"
        )))
    }
}

#[cfg(target_os = "windows")]
async fn terminate_platform_cursor() -> Result<()> {
    // Scope restarts to the selected installation, including isolated verification copies.
    let app = super::native_agent::installed_app_path()?;
    let executable = super::native_agent::cursor_executable(&app).canonicalize()?;
    let literal = executable
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\'', "''");
    let script = format!("$ErrorActionPreference='Stop'; Get-Process -Name Cursor -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq '{literal}' }} | Stop-Process -Force -ErrorAction Stop; exit 0");
    let mut command = Command::new("powershell.exe");
    hide_console(&mut command);
    let output = command
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(Error::Config(
            "failed to restart the selected Cursor installation".into(),
        ))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
async fn terminate_platform_cursor() -> Result<()> {
    Err(Error::Config(format!(
        "terminating Cursor is unsupported on {}",
        std::env::consts::OS
    )))
}
