//! One long-lived Node worker; sessions retain it while a Cursor update starts a new worker.
use crate::{Error, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot},
};

type Pending = HashMap<u64, oneshot::Sender<Result<Value>>>;
pub(super) struct Worker {
    input: mpsc::UnboundedSender<Value>,
    pending: parking_lot::Mutex<Pending>,
    sessions: parking_lot::Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>,
    next: AtomicU64,
    healthy: AtomicBool,
    _child: parking_lot::Mutex<Child>,
    pub metadata: Value,
}

impl Worker {
    pub async fn spawn(executable: &Path, app: &Path, script: &Path) -> Result<Arc<Self>> {
        let mut command = Command::new(executable);
        command
            .arg(script)
            .arg(app)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn()?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| Error::Config("native worker has no stdin".into()))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| Error::Config("native worker has no stdout".into()))?;
        let mut lines = BufReader::new(output).lines();
        let line = tokio::time::timeout(Duration::from_secs(45), lines.next_line())
            .await
            .map_err(|_| Error::Config("Cursor native worker startup timed out".into()))??
            .ok_or_else(|| Error::Config("Cursor native worker stopped during startup".into()))?;
        let ready: Value = serde_json::from_str(&line)?;
        if ready["kind"] != "ready" {
            return Err(Error::Config(format!(
                "invalid Cursor worker startup: {ready}"
            )));
        }
        let (sender, mut receiver) = mpsc::unbounded_channel::<Value>();
        let worker = Arc::new(Self {
            input: sender,
            pending: Default::default(),
            sessions: Default::default(),
            next: AtomicU64::new(1),
            healthy: AtomicBool::new(true),
            _child: parking_lot::Mutex::new(child),
            metadata: ready["metadata"].clone(),
        });
        let weak = Arc::downgrade(&worker);
        tokio::spawn(async move {
            while let Some(value) = receiver.recv().await {
                let mut bytes = serde_json::to_vec(&value).expect("IPC value is serializable");
                bytes.push(b'\n');
                if input.write_all(&bytes).await.is_err() {
                    fail(&weak, "native worker input closed");
                    break;
                }
            }
        });
        let weak = Arc::downgrade(&worker);
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(worker) = weak.upgrade() else {
                    return;
                };
                if line.len() > 64 * 1024 * 1024 {
                    fail(&weak, "native worker frame exceeded 64 MiB");
                    return;
                }
                let value: Value = match serde_json::from_str(&line) {
                    Ok(value) => value,
                    Err(_) => {
                        fail(&weak, "invalid native worker frame");
                        return;
                    }
                };
                if value["kind"] == "response" {
                    if let Some(id) = value["id"].as_u64() {
                        if let Some(sender) = worker.pending.lock().remove(&id) {
                            let result = match value["error"].as_str() {
                                Some(error) => Err(Error::Protocol(error.into())),
                                None => Ok(value["result"].clone()),
                            };
                            let _ = sender.send(result);
                        }
                    }
                } else if let Some(session) = value["session_id"].as_str() {
                    if let Some(sender) = worker.sessions.lock().get(session) {
                        let _ = sender.send(value.clone());
                    }
                }
            }
            fail(&weak, "native worker exited");
        });
        Ok(worker)
    }
    pub fn subscribe(&self, id: String) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.sessions.lock().insert(id, tx);
        rx
    }
    pub fn unsubscribe(&self, id: &str) {
        self.sessions.lock().remove(id);
    }
    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub fn kill_for_test(&self) {
        let _ = self._child.lock().start_kill();
    }
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        if let Err(error) = self.send(json!({"id":id,"method":method,"params":params})) {
            self.pending.lock().remove(&id);
            return Err(error);
        }
        let result = tokio::time::timeout(Duration::from_secs(45), rx).await;
        self.pending.lock().remove(&id);
        result
            .map_err(|_| Error::Protocol(format!("native {method} timed out")))?
            .map_err(|_| Error::Protocol("native worker disconnected".into()))?
    }
    pub fn send(&self, value: Value) -> Result<()> {
        if !self.is_healthy() {
            return Err(Error::Protocol("native worker exited".into()));
        }
        self.input
            .send(value)
            .map_err(|_| Error::Protocol("native worker is unavailable".into()))
    }
    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(json!({"method":method,"params":params}))
    }
}
fn fail(worker: &Weak<Worker>, message: &str) {
    let Some(worker) = worker.upgrade() else {
        return;
    };
    if !worker.healthy.swap(false, Ordering::AcqRel) {
        return;
    }
    let _ = worker._child.lock().start_kill();
    for (_, sender) in worker.pending.lock().drain() {
        let _ = sender.send(Err(Error::Protocol(message.into())));
    }
    for (id, sender) in worker.sessions.lock().drain() {
        let _ = sender.send(json!({"kind":"failed","session_id":id,"error":message}));
    }
}
