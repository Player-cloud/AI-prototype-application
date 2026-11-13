//! Starts the TypeScript engine helper as a separate program and talks to it
//! with one JSON object per line over stdin/stdout.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

/// How to start the helper: a program plus its arguments, and folders to put first on PATH
/// (the bundled Node, pnpm and git, so builds use the app's own tools, not whatever the PC has).
#[derive(Debug, Clone, PartialEq)]
pub struct HelperCommand {
    pub program: String,
    pub args: Vec<String>,
    pub path_first: Vec<PathBuf>,
}

/// The bundled Node program inside `dir` (`node/node.exe` on Windows, `node/node` elsewhere).
fn bundled_node(dir: &Path) -> PathBuf {
    dir.join("node").join(if cfg!(windows) { "node.exe" } else { "node" })
}

/// Picks the helper command.
/// 1. `AIP_ENGINE` (a path to a built helper.js) wins.
/// 2. An installed app has its engine next to its own program: `<app>/engine/dist/helper.js`.
/// 3. Otherwise (dev), the monorepo's built engine next to this source.
/// The bundled Node (`<app>/node/`) is used when it is there; otherwise `node` from PATH.
/// `<app>/node/` (Node and the pnpm launcher) and `<app>/git/cmd/` go first on PATH when they exist.
pub fn helper_command(env_override: Option<String>, app_dir: Option<&Path>) -> HelperCommand {
    let bundled = app_dir.map(|d| d.join("engine").join("dist").join("helper.js")).filter(|p| p.is_file());
    let script = env_override.or_else(|| bundled.map(|p| p.to_string_lossy().into_owned())).unwrap_or_else(|| {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for part in ["..", "..", "..", "packages", "engine", "dist", "helper.js"] {
            p.push(part);
        }
        p.to_string_lossy().into_owned()
    });
    let path_first: Vec<PathBuf> = app_dir
        .map(|d| vec![d.join("node"), d.join("git").join("cmd")])
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.is_dir())
        .collect();
    match app_dir.map(bundled_node).filter(|p| p.is_file()) {
        Some(node) => HelperCommand { program: node.to_string_lossy().into_owned(), args: vec![script], path_first },
        None => HelperCommand { program: "node".into(), args: vec![script], path_first },
    }
}

/// The folder holding the running app's own program ('None' if it can't be found).
pub fn app_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// What the window shows about the engine.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum EngineStatus {
    Running { version: String },
    Stopped { reason: String },
}

pub struct EngineHelper {
    child: Child,
    /// Shared so a running request can be cancelled from another thread.
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl EngineHelper {
    pub fn start(cmd: &HelperCommand) -> Result<Self, String> {
        let mut command = Command::new(&cmd.program);
        #[cfg(windows)]
        {
            // Don't flash a console window for the helper on Windows.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        if !cmd.path_first.is_empty() {
            let rest = std::env::var_os("PATH").unwrap_or_default();
            let joined = std::env::join_paths(cmd.path_first.iter().cloned().chain(std::env::split_paths(&rest)))
                .map_err(|e| format!("could not set PATH for the engine: {e}"))?;
            command.env("PATH", joined);
        }
        let mut child = command
            .args(&cmd.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", cmd.program))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(Self { child, stdin: Arc::new(Mutex::new(stdin)), stdout, next_id: 1 })
    }

    /// Whether the helper program is still running.
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Sends one request and waits for its reply line.
    pub fn request(&mut self, method: &str) -> Result<Value, String> {
        self.request_with(method, Value::Null)
    }

    /// Sends one request with parameters and waits for its reply line.
    pub fn request_with(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_live(method, params, |_| {})
    }

    /// The id the next request will get (for cancelling it).
    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// Lets another thread stop a running request.
    pub fn canceller(&self) -> Canceller {
        Canceller { stdin: Arc::clone(&self.stdin) }
    }

    /// Sends one request and waits for its reply, passing each event line for it to `on_event`
    /// first. Lines for other requests (such as a cancel's answer) are skipped.
    pub fn request_live(&mut self, method: &str, params: Value, mut on_event: impl FnMut(Value)) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let line = if params.is_null() {
            json!({ "id": id, "method": method })
        } else {
            json!({ "id": id, "method": method, "params": params })
        }
        .to_string();
        write_line(&self.stdin, &line)?;
        loop {
            let mut reply = String::new();
            let n = self.stdout.read_line(&mut reply).map_err(|e| format!("engine read failed: {e}"))?;
            if n == 0 {
                return Err("engine stopped".into());
            }
            match line_kind(&reply, id) {
                LineKind::Event(e) => on_event(e),
                LineKind::Other => continue,
                LineKind::Reply => return parse_reply(&reply, id),
            }
        }
    }

    pub fn status(&mut self) -> EngineStatus {
        match self.request("ping") {
            Ok(v) => match v.get("version").and_then(Value::as_str) {
                Some(version) => EngineStatus::Running { version: version.to_string() },
                None => EngineStatus::Stopped { reason: "engine reply had no version".into() },
            },
            Err(reason) => EngineStatus::Stopped { reason },
        }
    }
}

impl Drop for EngineHelper {
    fn drop(&mut self) {
        // Closing stdin makes the helper exit; kill it too in case it hangs.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn write_line(stdin: &Arc<Mutex<ChildStdin>>, line: &str) -> Result<(), String> {
    let mut w = match stdin.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    writeln!(w, "{line}").map_err(|e| format!("engine write failed: {e}"))?;
    w.flush().map_err(|e| format!("engine write failed: {e}"))
}

/// Stops a running request from another thread.
#[derive(Clone)]
pub struct Canceller {
    stdin: Arc<Mutex<ChildStdin>>,
}

impl Canceller {
    pub fn cancel(&self, request_id: u64) -> Result<(), String> {
        write_line(&self.stdin, &json!({ "id": 0, "method": "cancel", "params": { "id": request_id } }).to_string())
    }
}

#[derive(Debug, PartialEq)]
pub enum LineKind {
    /// An event for the request we're waiting on.
    Event(Value),
    /// The reply to it (or something unreadable, which parse_reply explains).
    Reply,
    /// A line for another request.
    Other,
}

pub fn line_kind(line: &str, expected_id: u64) -> LineKind {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return LineKind::Reply };
    match v.get("id").and_then(Value::as_u64) {
        Some(id) if id == expected_id => match v.get("event") {
            Some(e) => LineKind::Event(e.clone()),
            None => LineKind::Reply,
        },
        Some(_) => LineKind::Other,
        None => LineKind::Reply,
    }
}

/// Reads a reply line and returns its result, or its error as Err.
pub fn parse_reply(line: &str, expected_id: u64) -> Result<Value, String> {
    let v: Value = serde_json::from_str(line.trim()).map_err(|_| "engine sent bad JSON".to_string())?;
    if v.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return Err("engine reply id did not match".into());
    }
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        return Err(err.to_string());
    }
    v.get("result").cloned().ok_or_else(|| "engine reply had no result".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reply_returns_result() {
        let v = parse_reply(r#"{"id":1,"result":{"ok":true,"version":"0.0.1"}}"#, 1).unwrap();
        assert_eq!(v["version"], "0.0.1");
    }

    #[test]
    fn parse_reply_rejects_errors_bad_json_and_wrong_id() {
        assert_eq!(parse_reply(r#"{"id":1,"error":"nope"}"#, 1), Err("nope".into()));
        assert_eq!(parse_reply("oops", 1), Err("engine sent bad JSON".into()));
        assert_eq!(parse_reply(r#"{"id":2,"result":1}"#, 1), Err("engine reply id did not match".into()));
    }

    #[test]
    fn helper_command_uses_override_or_monorepo_path() {
        let c = helper_command(Some("x/helper.js".into()), None);
        assert_eq!(c, HelperCommand { program: "node".into(), args: vec!["x/helper.js".into()], path_first: vec![] });
        let d = helper_command(None, None);
        assert!(d.args[0].ends_with("helper.js"));
        assert!(d.args[0].contains("engine"));
        assert_eq!(d.program, "node");
    }

    /// A made-up installed app in a folder with a space in its name.
    fn fake_app(name: &str, with_node: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aip app {}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("engine").join("dist")).unwrap();
        std::fs::write(dir.join("engine").join("dist").join("helper.js"), "").unwrap();
        if with_node {
            std::fs::create_dir_all(dir.join("node")).unwrap();
            std::fs::write(bundled_node(&dir), "").unwrap();
        }
        dir
    }

    #[test]
    fn an_installed_app_uses_its_own_engine_and_node() {
        let dir = fake_app("own", true);
        let c = helper_command(None, Some(&dir));
        assert_eq!(PathBuf::from(&c.args[0]), dir.join("engine").join("dist").join("helper.js"));
        assert_eq!(PathBuf::from(&c.program), bundled_node(&dir));
        assert_eq!(c.path_first, vec![dir.join("node")]);
        // AIP_ENGINE still wins for the script, and the bundled Node still runs it.
        let o = helper_command(Some("x/helper.js".into()), Some(&dir));
        assert_eq!(o.args, vec!["x/helper.js".to_string()]);
        assert_eq!(PathBuf::from(&o.program), bundled_node(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_git_goes_on_path_after_node() {
        let dir = fake_app("git", true);
        std::fs::create_dir_all(dir.join("git").join("cmd")).unwrap();
        let c = helper_command(None, Some(&dir));
        assert_eq!(c.path_first, vec![dir.join("node"), dir.join("git").join("cmd")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_installed_engine_without_bundled_node_uses_node_from_path() {
        let dir = fake_app("pathnode", false);
        let c = helper_command(None, Some(&dir));
        assert_eq!(c.program, "node");
        assert_eq!(c.path_first, Vec::<PathBuf>::new());
        assert_eq!(PathBuf::from(&c.args[0]), dir.join("engine").join("dist").join("helper.js"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn puts_the_bundled_node_folder_first_on_path() {
        let dir = std::env::temp_dir().join(format!("aip path {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = r#"process.stdout.write(JSON.stringify({id:1,result:process.env.PATH.split(require('path').delimiter)[0]})+'\n')"#;
        let cmd = HelperCommand { program: "node".into(), args: vec!["-e".into(), script.into()], path_first: vec![dir.clone()] };
        let mut h = EngineHelper::start(&cmd).expect("node should start");
        assert_eq!(PathBuf::from(h.request("x").unwrap().as_str().unwrap()), dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sends_params_and_reads_the_reply() {
        let script = r#"require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,result:{got:r.params}})+'\n')})"#;
        let cmd = HelperCommand { program: "node".into(), args: vec!["-e".into(), script.into()], path_first: vec![] };
        let mut h = EngineHelper::start(&cmd).expect("node should start");
        let v = h.request_with("ask", json!({ "prompt": "hi" })).unwrap();
        assert_eq!(v["got"]["prompt"], "hi");
    }

    #[test]
    fn sorts_events_replies_and_other_lines() {
        assert_eq!(line_kind(r#"{"id":3,"event":{"type":"step"}}"#, 3), LineKind::Event(json!({ "type": "step" })));
        assert_eq!(line_kind(r#"{"id":3,"result":1}"#, 3), LineKind::Reply);
        assert_eq!(line_kind(r#"{"id":0,"result":{"cancelled":true}}"#, 3), LineKind::Other);
        assert_eq!(line_kind("oops", 3), LineKind::Reply);
    }

    /// A stand-in helper that sends two events, then waits; a cancel line makes it reply "Stopped.".
    #[test]
    fn passes_events_on_and_can_be_cancelled() {
        let script = r#"const rl=require('readline').createInterface({input:process.stdin});rl.on('line',l=>{const r=JSON.parse(l);const w=o=>process.stdout.write(JSON.stringify(o)+'\n');if(r.method==='cancel'){w({id:r.id,result:{cancelled:true}});w({id:r.params.id,error:'Stopped.'});return;}w({id:r.id,event:{n:1}});w({id:r.id,event:{n:2}});})"#;
        let cmd = HelperCommand { program: "node".into(), args: vec!["-e".into(), script.into()], path_first: vec![] };
        let mut h = EngineHelper::start(&cmd).expect("node should start");
        let id = h.next_id();
        let stop = h.canceller();
        let mut seen = Vec::new();
        let r = h.request_live("build_feature", json!({}), |e| {
            seen.push(e["n"].as_u64().unwrap());
            if seen.len() == 2 {
                stop.cancel(id).unwrap();
            }
        });
        assert_eq!(seen, vec![1, 2]);
        assert_eq!(r, Err("Stopped.".into()));
    }

    #[test]
    fn missing_program_gives_stopped_reason() {
        let cmd = HelperCommand { program: "aip-no-such-program".into(), args: vec![], path_first: vec![] };
        match EngineHelper::start(&cmd) {
            Ok(_) => panic!("should not start"),
            Err(e) => assert!(e.contains("could not start")),
        }
    }

    /// Talks to a tiny stand-in helper written in Node (Node is on every CI runner).
    #[test]
    fn talks_to_a_real_process() {
        let script = r#"require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,result:{ok:true,version:'9.9.9'}})+'\n')})"#;
        let cmd = HelperCommand { program: "node".into(), args: vec!["-e".into(), script.into()], path_first: vec![] };
        let mut h = EngineHelper::start(&cmd).expect("node should start");
        assert_eq!(h.status(), EngineStatus::Running { version: "9.9.9".into() });
        assert_eq!(h.status(), EngineStatus::Running { version: "9.9.9".into() });
    }
}
