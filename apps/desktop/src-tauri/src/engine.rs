//! Starts the TypeScript engine helper as a separate program and talks to it
//! with one JSON object per line over stdin/stdout.

use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// How to start the helper: a program plus its arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct HelperCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Picks the helper command.
/// `AIP_ENGINE` (a path to the built helper.js) wins; otherwise the monorepo's
/// built engine next to this app is used. Node runs it in both cases.
pub fn helper_command(env_override: Option<String>) -> HelperCommand {
    let script = env_override.unwrap_or_else(|| {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        for part in ["..", "..", "..", "packages", "engine", "dist", "helper.js"] {
            p.push(part);
        }
        p.to_string_lossy().into_owned()
    });
    HelperCommand { program: "node".into(), args: vec![script] }
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
    stdin: ChildStdin,
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
        let mut child = command
            .args(&cmd.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", cmd.program))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(Self { child, stdin, stdout, next_id: 1 })
    }

    /// Sends one request and waits for its reply line.
    pub fn request(&mut self, method: &str) -> Result<Value, String> {
        self.request_with(method, Value::Null)
    }

    /// Sends one request with parameters and waits for its reply line.
    pub fn request_with(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let line = if params.is_null() {
            json!({ "id": id, "method": method })
        } else {
            json!({ "id": id, "method": method, "params": params })
        }
        .to_string();
        writeln!(self.stdin, "{line}").map_err(|e| format!("engine write failed: {e}"))?;
        self.stdin.flush().map_err(|e| format!("engine write failed: {e}"))?;
        let mut reply = String::new();
        let n = self.stdout.read_line(&mut reply).map_err(|e| format!("engine read failed: {e}"))?;
        if n == 0 {
            return Err("engine stopped".into());
        }
        parse_reply(&reply, id)
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
        let c = helper_command(Some("x/helper.js".into()));
        assert_eq!(c, HelperCommand { program: "node".into(), args: vec!["x/helper.js".into()] });
        let d = helper_command(None);
        assert!(d.args[0].ends_with("helper.js"));
        assert!(d.args[0].contains("engine"));
    }

    #[test]
    fn sends_params_and_reads_the_reply() {
        let script = r#"require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,result:{got:r.params}})+'\n')})"#;
        let cmd = HelperCommand { program: "node".into(), args: vec!["-e".into(), script.into()] };
        let mut h = EngineHelper::start(&cmd).expect("node should start");
        let v = h.request_with("ask", json!({ "prompt": "hi" })).unwrap();
        assert_eq!(v["got"]["prompt"], "hi");
    }

    #[test]
    fn missing_program_gives_stopped_reason() {
        let cmd = HelperCommand { program: "aip-no-such-program".into(), args: vec![] };
        match EngineHelper::start(&cmd) {
            Ok(_) => panic!("should not start"),
            Err(e) => assert!(e.contains("could not start")),
        }
    }

    /// Talks to a tiny stand-in helper written in Node (Node is on every CI runner).
    #[test]
    fn talks_to_a_real_process() {
        let script = r#"require('readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,result:{ok:true,version:'9.9.9'}})+'\n')})"#;
        let cmd = HelperCommand { program: "node".into(), args: vec!["-e".into(), script.into()] };
        let mut h = EngineHelper::start(&cmd).expect("node should start");
        assert_eq!(h.status(), EngineStatus::Running { version: "9.9.9".into() });
        assert_eq!(h.status(), EngineStatus::Running { version: "9.9.9".into() });
    }
}
