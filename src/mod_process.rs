//! Long-running programs a mod talks to while they run (`herdr.spawn`): their
//! output arrives line by line, the mod writes to their stdin. The chat mod
//! drives `claude` this way. `exec` stays the call for programs that finish.
//!
//! A program belongs to the mod copy that started it: closing that copy (its
//! pane, a reload) ends it, with the programs it started.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// One line longer than this is cut (the rest of it is dropped).
const LINE_MAX: usize = 32 << 20;
/// Lines one `readProcess` hands over at most; the rest wait for the next call.
const BATCH_MAX: usize = 4096;

pub enum Event {
    Out(String),
    Err(String),
    Exit(i32),
}

struct Proc {
    child: Arc<Mutex<Child>>,
    pid: u32,
    stdin: Option<std::sync::mpsc::Sender<String>>,
    events: async_channel::Receiver<Event>,
    exited: bool,
}

static NEXT: AtomicU64 = AtomicU64::new(1);
static PROCS: Mutex<Option<HashMap<u64, Proc>>> = Mutex::new(None);

fn with_procs<R>(f: impl FnOnce(&mut HashMap<u64, Proc>) -> R) -> R {
    let mut g = PROCS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new))
}

/// The programs one mod copy started; dropping it ends them.
#[derive(Default)]
pub struct Owner(Mutex<Vec<u64>>);

impl Owner {
    fn adopt(&self, id: u64) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push(id);
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        for id in self.0.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
            kill(id);
            with_procs(|p| p.remove(&id));
        }
    }
}

/// Finds what Windows would run for a bare name: `claude` is often `claude.cmd`
/// (npm), which `CreateProcess` can't start on its own.
#[cfg(windows)]
fn resolve(command: &str) -> (PathBuf, bool) {
    let p = PathBuf::from(command);
    if p.extension().is_some() || p.components().count() > 1 {
        let batch = p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
        return (p, batch);
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path) {
        for ext in ["exe", "com", "cmd", "bat"] {
            let c = dir.join(format!("{command}.{ext}"));
            if c.is_file() {
                return (c, ext == "cmd" || ext == "bat");
            }
        }
    }
    (p, false)
}

#[cfg(not(windows))]
fn resolve(command: &str) -> (PathBuf, bool) {
    (PathBuf::from(command), false)
}

/// Starts a program with piped stdio. Returns its id.
pub fn spawn(owner: &Owner, command: &str, args: &[String], cwd: Option<String>, env: Vec<(String, String)>) -> Result<u64, String> {
    let (program, batch) = resolve(command);
    let mut cmd = if batch {
        // cmd.exe reparses the line: refuse what it would treat as syntax.
        if args.iter().any(|a| a.chars().any(|c| "&|<>^%!\"\r\n".contains(c))) {
            return Err(format!("{command} is a batch file; its arguments can't hold & | < > ^ % ! or quotes"));
        }
        let mut c = crate::spawn::command("cmd.exe");
        let line = std::iter::once(format!("\"{}\"", program.display()))
            .chain(args.iter().map(|a| if a.is_empty() || a.contains(' ') { format!("\"{a}\"") } else { a.clone() }))
            .collect::<Vec<_>>()
            .join(" ");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.raw_arg(format!("/d /s /c \"{line}\""));
        }
        #[cfg(not(windows))]
        c.arg(line);
        c
    } else {
        let mut c = crate::spawn::command(&program);
        c.args(args);
        c
    };
    cmd.current_dir(cwd.map(PathBuf::from).unwrap_or_else(crate::mods::home))
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("cannot run {command}: {e}"))?;
    let pid = child.id();
    let (tx, events) = async_channel::unbounded();
    let out = child.stdout.take().expect("piped stdout");
    let err = child.stderr.take().expect("piped stderr");
    let input = child.stdin.take().expect("piped stdin");
    let child = Arc::new(Mutex::new(child));

    let (in_tx, in_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut input = input;
        for text in in_rx {
            if input.write_all(text.as_bytes()).and_then(|()| input.flush()).is_err() {
                break;
            }
        }
    });
    let err_tx = tx.clone();
    let err_reader = std::thread::spawn(move || read_lines(err, |l| err_tx.send_blocking(Event::Err(l)).is_ok()));
    let waiter = child.clone();
    std::thread::spawn(move || {
        read_lines(out, |l| tx.send_blocking(Event::Out(l)).is_ok());
        let _ = err_reader.join();
        let code = loop {
            if let Ok(mut c) = waiter.lock()
                && let Ok(Some(s)) = c.try_wait()
            {
                break s.code().unwrap_or(-1);
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        let _ = tx.send_blocking(Event::Exit(code));
    });

    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    with_procs(|p| p.insert(id, Proc { child, pid, stdin: Some(in_tx), events, exited: false }));
    owner.adopt(id);
    Ok(id)
}

fn read_lines(stream: impl Read, mut send: impl FnMut(String) -> bool) {
    let mut r = BufReader::with_capacity(64 << 10, stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match (&mut r).take(LINE_MAX as u64).read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {
                if buf.last() != Some(&b'\n') && buf.len() >= LINE_MAX {
                    // Too long: drop the rest of this line.
                    let mut rest = Vec::new();
                    let _ = r.read_until(b'\n', &mut rest);
                }
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                if !send(String::from_utf8_lossy(&buf).into_owned()) {
                    return;
                }
            }
        }
    }
}

/// What came since the last read: waits for at least one event.
/// `None` once the program's exit was reported.
pub struct Batch {
    pub out: Vec<String>,
    pub err: Vec<String>,
    pub exit: Option<i32>,
}

pub fn read(id: u64) -> Result<impl std::future::Future<Output = Option<Batch>> + Send, String> {
    let rx = with_procs(|p| p.get(&id).map(|p| (p.events.clone(), p.exited))).ok_or("no such process")?;
    Ok(async move {
        let (rx, exited) = rx;
        if exited {
            return None;
        }
        let first = rx.recv().await.ok()?;
        let mut b = Batch { out: vec![], err: vec![], exit: None };
        let mut take = |e: Event, b: &mut Batch| match e {
            Event::Out(l) => b.out.push(l),
            Event::Err(l) => b.err.push(l),
            Event::Exit(c) => b.exit = Some(c),
        };
        take(first, &mut b);
        while b.exit.is_none() && b.out.len() + b.err.len() < BATCH_MAX {
            match rx.try_recv() {
                Ok(e) => take(e, &mut b),
                Err(_) => break,
            }
        }
        if b.exit.is_some() {
            with_procs(|p| p.get_mut(&id).map(|p| p.exited = true));
        }
        Some(b)
    })
}

pub fn write(id: u64, text: String) -> Result<(), String> {
    with_procs(|p| {
        let proc = p.get(&id).ok_or("no such process")?;
        proc.stdin.as_ref().ok_or("its input is closed")?.send(text).map_err(|_| "it stopped reading".to_owned())
    })
}

/// Closes the program's stdin (end of input).
pub fn close_input(id: u64) {
    with_procs(|p| p.get_mut(&id).map(|p| p.stdin = None));
}

/// Ends the program and what it started.
pub fn kill(id: u64) {
    let Some((child, pid)) = with_procs(|p| p.get(&id).map(|p| (p.child.clone(), p.pid))) else { return };
    #[cfg(windows)]
    {
        // A batch wrapper's program is its child: end the whole tree.
        let _ = crate::spawn::command("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(windows))]
    let _ = pid;
    if let Ok(mut c) = child.lock() {
        let _ = c.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        let mut f = std::pin::pin!(f);
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        loop {
            if let std::task::Poll::Ready(v) = f.as_mut().poll(&mut cx) {
                return v;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn drain(id: u64) -> (Vec<String>, Option<i32>) {
        let mut out = vec![];
        loop {
            match block_on(read(id).unwrap()) {
                None => return (out, None),
                Some(b) => {
                    out.extend(b.out);
                    if b.exit.is_some() {
                        return (out, b.exit);
                    }
                }
            }
        }
    }

    #[test]
    fn streams_lines_and_takes_input() {
        let owner = Owner::default();
        #[cfg(windows)]
        let (cmd, args) = ("powershell.exe", vec!["-NoProfile".into(), "-Command".into(), "$l = [Console]::In.ReadLine(); Write-Output \"one\"; Write-Output \"got $l\"".into()]);
        #[cfg(not(windows))]
        let (cmd, args) = ("sh", vec!["-c".into(), "read l; echo one; echo \"got $l\"".into()]);
        let id = spawn(&owner, cmd, &args, None, vec![]).unwrap();
        write(id, "hello\n".into()).unwrap();
        let (out, exit) = drain(id);
        assert_eq!(out, vec!["one", "got hello"]);
        assert_eq!(exit, Some(0));
        assert!(block_on(read(id).unwrap()).is_none());
    }

    #[test]
    fn dropping_the_owner_ends_the_program() {
        let owner = Owner::default();
        #[cfg(windows)]
        let (cmd, args) = ("powershell.exe", vec!["-NoProfile".into(), "-Command".into(), "Start-Sleep 60".into()]);
        #[cfg(not(windows))]
        let (cmd, args) = ("sh", vec!["-c".into(), "sleep 60".into()]);
        let id = spawn(&owner, cmd, &args, None, vec![]).unwrap();
        let child = with_procs(|p| p[&id].child.clone());
        drop(owner);
        let start = std::time::Instant::now();
        loop {
            if let Ok(Some(_)) = child.lock().unwrap().try_wait() {
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "still running");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(read(id).is_err());
    }
}
