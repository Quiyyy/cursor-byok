// Desktop builds use the GUI subsystem; startup diagnostics are saved to log files.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    cursor_byok_desktop::run()
}
