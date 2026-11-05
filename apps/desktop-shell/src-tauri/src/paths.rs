//! Where the core lives and how to start it.
//!
//! The shell never holds state of its own: everything is in the core's data
//! directory (`$ALCA_DATA_DIR`, default `~/.alca`), the same one the headless
//! core and `alca service` use.

use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The core's data folder, as the core will see it: a `--data-dir` in `$ALCA_CORE_CMD` /
/// `$ALCA_CORE_ARGS` (the core takes its flag over the environment), else `$ALCA_DATA_DIR`,
/// else `~/.alca`. The shell reads the port and the local token from the same folder.
pub fn data_dir() -> PathBuf {
    let mut args = env_words("ALCA_CORE_CMD");
    args.extend(env_words("ALCA_CORE_ARGS"));
    if let Some(d) = flag_value(&args, "--data-dir") {
        return expand_home(&d);
    }
    std::env::var_os("ALCA_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".alca"))
}

fn env_words(key: &str) -> Vec<String> {
    std::env::var(key).ok().and_then(|s| split_words(&s).ok()).unwrap_or_default()
}

/// Split `$ALCA_CORE_CMD` / `$ALCA_CORE_ARGS` the way a shell would (mac test 2026-11-04b D2:
/// `split_whitespace` broke `node "/Users/me/claude code/alca/apps/desktop/src/main.ts"`).
/// Single quotes keep everything literally; double quotes keep spaces and undo `\"`, `\\`,
/// `\$` and `` \` ``; outside quotes a backslash escapes the next character (on Windows only
/// before `"` or another backslash, so `C:\Program Files\…` paths keep their separators).
/// No variables, globs or `~` are expanded here: the core expands `~` in its own flags, and the
/// program itself goes through [`expand_home`]. An unterminated quote is an error, never a
/// guess.
pub fn split_words(s: &str) -> Result<Vec<String>, String> {
    split_words_with(s, !cfg!(windows))
}

fn split_words_with(s: &str, posix: bool) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\'' => {
                in_word = true;
                loop {
                    match it.next() {
                        Some('\'') => break,
                        Some(ch) => cur.push(ch),
                        None => return Err("單引號沒有結束".to_owned()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match it.next() {
                        Some('"') => break,
                        Some('\\') => match it.peek().copied() {
                            Some(n) if n == '"' || n == '\\' || (posix && (n == '$' || n == '`')) => {
                                cur.push(n);
                                it.next();
                            }
                            Some('\n') if posix => {
                                it.next();
                            }
                            _ => cur.push('\\'),
                        },
                        Some(ch) => cur.push(ch),
                        None => return Err("雙引號沒有結束".to_owned()),
                    }
                }
            }
            '\\' => {
                in_word = true;
                match it.peek().copied() {
                    Some('\n') if posix => {
                        it.next();
                    }
                    Some(n) if posix || n == '"' || n == '\\' => {
                        cur.push(n);
                        it.next();
                    }
                    None if posix => return Err("結尾多了一個反斜線".to_owned()),
                    _ => cur.push('\\'),
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    Ok(out)
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None if p == "~" => home(),
        None => PathBuf::from(p),
    }
}

/// The last value of `--flag v` / `--flag=v` (the core's parser keeps the last one).
pub fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let eq = format!("{flag}=");
    let mut found = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            if let Some(v) = args.get(i + 1) {
                found = Some(v.clone());
            }
            i += 2;
            continue;
        }
        if let Some(v) = args[i].strip_prefix(&eq) {
            found = Some(v.to_owned());
        }
        i += 1;
    }
    found
}

/// `args` plus `--engine` / `--data-dir` unless the command or the extra flags already name
/// them (mac test 2026-11-04: a custom `--data-dir` in `ALCA_CORE_CMD` was overridden), then
/// the extra flags.
pub fn with_defaults(mut args: Vec<String>, engine: &str, data: &str, extra: &[String]) -> Vec<String> {
    let all: Vec<String> = args.iter().chain(extra.iter()).cloned().collect();
    if flag_value(&all, "--engine").is_none() {
        args.extend(["--engine".to_owned(), engine.to_owned()]);
    }
    if flag_value(&all, "--data-dir").is_none() {
        args.extend(["--data-dir".to_owned(), data.to_owned()]);
    }
    args.extend(extra.iter().cloned());
    args
}

/// Logs of a core the shell started (the service writes to the same folder).
pub fn log_dir() -> PathBuf {
    data_dir().join("logs")
}

fn read_json(p: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// The loopback port: `$ALCA_PORT`, else `engineering.port` in config.json, else 4317.
pub fn port() -> u16 {
    if let Some(p) = std::env::var("ALCA_PORT").ok().and_then(|v| v.parse().ok()) {
        return p;
    }
    read_json(&data_dir().join("config.json"))
        .and_then(|c| c.pointer("/engineering/port").and_then(|v| v.as_u64()))
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(4317)
}

/// R9.3: the interface language: `advanced.locale` in config.json, `auto` (the default) = the system's.
pub fn locale_is_en() -> bool {
    let config = read_json(&data_dir().join("config.json"));
    let pref = config.as_ref().and_then(|c| c.pointer("/advanced/locale")).and_then(|v| v.as_str());
    resolve_en(pref.unwrap_or("auto"), &system_lang())
}

/// `en` / `zh-Hant-TW` as set; `auto`: English unless the system says zh*, C / POSIX or nothing.
pub fn resolve_en(pref: &str, system: &str) -> bool {
    match pref {
        "en" => true,
        "zh-Hant-TW" => false,
        _ => {
            let s = system.trim();
            !(s.is_empty() || s.starts_with("zh") || s == "C" || s.starts_with("C.") || s == "POSIX")
        }
    }
}

/// The system language: LC_ALL / LC_MESSAGES / LANG, else (macOS) the AppleLocale default.
fn system_lang() -> String {
    let vars = ["LC_ALL", "LC_MESSAGES", "LANG"];
    if let Some(v) = vars.iter().filter_map(|k| std::env::var(k).ok()).find(|v| !v.is_empty()) {
        return v;
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("defaults").args(["read", "-g", "AppleLocale"]).output();
        if let Ok(o) = out {
            return String::from_utf8_lossy(&o.stdout).trim().to_owned();
        }
    }
    String::new()
}

/// The local token (secrets.json, written 0600 by the core on its first start).
pub fn token() -> Option<String> {
    read_json(&data_dir().join("secrets.json"))?.get("core.localToken")?.as_str().map(str::to_owned)
}

/// The URL the window opens: the token travels in the fragment, never in a request. With a
/// launch code (`ui=`, review 2026-11-04b S2.2) the page trades it once for the core's in-memory
/// approve key, so this window can approve and pair.
pub fn ui_url(port: u16, token: &str, launch: Option<&str>, extra: &str) -> String {
    let launch = launch.map(|c| format!("&ui={c}")).unwrap_or_default();
    let extra = if extra.is_empty() { String::new() } else { format!("&{extra}") };
    format!("http://127.0.0.1:{port}/#token={token}{launch}{extra}")
}

/// Bytes in a launch code (48 hex characters; the core accepts 32 to 128).
pub const LAUNCH_CODE_BYTES: usize = 24;

/// Lower-case hex, as the core and the page expect.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

/// A fresh one-time launch code from the OS's random source (`None` if it fails).
pub fn launch_code() -> Option<String> {
    let mut buf = [0u8; LAUNCH_CODE_BYTES];
    getrandom::getrandom(&mut buf).ok()?;
    Some(hex(&buf))
}

/// What the shell writes on the core's stdin for one code: never argv or the environment,
/// which other local processes can read (`ps`, `/proc/<pid>/environ`).
pub fn launch_line(code: &str) -> String {
    format!("{code}\n")
}

/// The packed core inside a release build: one tarball (`scripts/pack-core.ts --tar`, a single
/// top-level `alca/` folder). It is a tarball because the tree holds relative symlinks for the
/// workspace packages, which Node needs (it strips TypeScript types only outside `node_modules`)
/// and which an app bundler would not keep.
pub const BUNDLED_TARBALL: &str = "alca-core.tar.gz";

/// Unpack the bundled core once per app version into `<root>/<version>` with the system `tar`
/// (macOS, Linux and Windows 10+ all ship one), via `<version>.partial` so a half-written copy is
/// never used. Returns the unpacked tree, or `None` when it cannot be used.
pub fn unpack_core(tarball: &Path, root: &Path, version: &str) -> Option<PathBuf> {
    let dest = root.join(version);
    if dest.join("apps/desktop/src/main.ts").exists() {
        return Some(dest);
    }
    let tmp = root.join(format!("{version}.partial"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).ok()?;
    let ok = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(tarball)
        .arg("-C")
        .arg(&tmp)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let tree = tmp.join("alca");
    if !ok || !tree.join("apps/desktop/src/main.ts").exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return None;
    }
    let _ = std::fs::remove_dir_all(&dest);
    let moved = std::fs::rename(&tree, &dest).is_ok();
    let _ = std::fs::remove_dir_all(&tmp);
    moved.then_some(dest)
}

/// How to run the core, first match wins:
/// 1. `$ALCA_CORE_CMD` (split like a shell: `node "/src/my alca/apps/desktop/src/main.ts"`),
/// 2. the copy bundled with the app: the Node runtime in `<resources>/core/node` and either the
///    tarball `<resources>/core/alca-core.tar.gz` (release builds; unpacked into
///    `<data-dir>/bundled/<version>` on first start) or an unpacked `<resources>/core/app`,
/// 3. the copy `scripts/install.sh` put in `~/.alca/app` (with `~/.alca/node/bin/node` or `node` on PATH).
pub fn core_command(resources: Option<&Path>) -> Option<(PathBuf, Vec<String>)> {
    let extra: Vec<String> = match std::env::var("ALCA_CORE_ARGS") {
        Ok(s) => match split_words(&s) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("alca shell: ALCA_CORE_ARGS 看不懂（{e}），不用它");
                Vec::new()
            }
        },
        Err(_) => Vec::new(),
    };
    let engine = std::env::var("ALCA_ENGINE").unwrap_or_else(|_| "claude-code".into());
    let data = data_dir().to_string_lossy().into_owned();
    let tail = |main: PathBuf| -> Vec<String> {
        let main = main.to_string_lossy().into_owned();
        let lead = vec!["--disable-warning=ExperimentalWarning".to_owned(), main];
        with_defaults(lead, &engine, &data, &extra)
    };
    if let Ok(cmd) = std::env::var("ALCA_CORE_CMD") {
        let words = match split_words(&cmd) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("alca shell: ALCA_CORE_CMD 看不懂（{e}）；路徑有空白時用引號包起來");
                return None;
            }
        };
        let mut it = words.into_iter();
        let bin = expand_home(&it.next()?);
        let args = with_defaults(it.collect(), &engine, &data, &extra);
        return Some((bin, args));
    }
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(r) = resources {
        let node = r.join("core").join("node").join(if cfg!(windows) { "" } else { "bin" }).join(node_name);
        let tarball = r.join("core").join(BUNDLED_TARBALL);
        if node.exists() && tarball.exists() {
            let root = data_dir().join("bundled");
            if let Some(tree) = unpack_core(&tarball, &root, env!("CARGO_PKG_VERSION")) {
                return Some((node, tail(tree.join("apps/desktop/src/main.ts"))));
            }
        }
        let main = r.join("core").join("app").join("apps/desktop/src/main.ts");
        if main.exists() && node.exists() {
            return Some((node, tail(main)));
        }
    }
    let installed = data_dir().join("app").join("apps/desktop/src/main.ts");
    if installed.exists() {
        let own = data_dir().join("node").join("bin").join(node_name);
        let node = if own.exists() { own } else { PathBuf::from(node_name) };
        return Some((node, tail(installed)));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_follows_the_setting_then_the_system() {
        assert!(resolve_en("en", "zh_TW.UTF-8"));
        assert!(!resolve_en("zh-Hant-TW", "en_US.UTF-8"));
        assert!(resolve_en("auto", "en_US.UTF-8"));
        assert!(!resolve_en("auto", "zh_TW.UTF-8"));
        assert!(!resolve_en("auto", "C.UTF-8"));
        assert!(!resolve_en("auto", ""));
    }

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn a_custom_data_dir_or_engine_in_the_command_is_kept() {
        let base = v(&["main.ts", "--data-dir", "/tmp/shell-test"]);
        let out = with_defaults(base, "demo", "/home/me/.alca", &[]);
        assert_eq!(out, v(&["main.ts", "--data-dir", "/tmp/shell-test", "--engine", "demo"]));
        let out = with_defaults(v(&["main.ts", "--engine=claude-code"]), "demo", "/d", &v(&["--port", "9"]));
        assert_eq!(out, v(&["main.ts", "--engine=claude-code", "--data-dir", "/d", "--port", "9"]));
        let out = with_defaults(v(&["main.ts"]), "demo", "/d", &v(&["--data-dir=/x"]));
        assert_eq!(out, v(&["main.ts", "--engine", "demo", "--data-dir=/x"]));
        let out = with_defaults(v(&["main.ts"]), "demo", "/d", &[]);
        assert_eq!(out, v(&["main.ts", "--engine", "demo", "--data-dir", "/d"]));
    }

    #[test]
    fn core_cmd_words_follow_shell_quoting() {
        // mac test 2026-11-04b D2: the repo lived in `~/Downloads/claude code`.
        let cmd =
            r#"node "/Users/me/claude code/alca/apps/desktop/src/main.ts" --data-dir ~/x --engine demo"#;
        assert_eq!(
            split_words_with(cmd, true).unwrap(),
            v(&[
                "node",
                "/Users/me/claude code/alca/apps/desktop/src/main.ts",
                "--data-dir",
                "~/x",
                "--engine",
                "demo"
            ])
        );
        assert_eq!(
            split_words_with(r"node /Users/me/claude\ code/main.ts", true).unwrap(),
            v(&["node", "/Users/me/claude code/main.ts"])
        );
        assert_eq!(
            split_words_with(r#"node '/a b/it'"'"'s.ts' "say \"hi\"" --x=''"#, true).unwrap(),
            v(&["node", "/a b/it's.ts", "say \"hi\"", "--x="])
        );
        assert_eq!(split_words_with("  a\t b  \n", true).unwrap(), v(&["a", "b"]));
        assert_eq!(split_words_with("", true).unwrap(), Vec::<String>::new());
        assert!(split_words_with(r#"node "/a b/main.ts"#, true).is_err());
        assert!(split_words_with("node '/a b", true).is_err());
        // Windows: backslashes are path separators, quotes still group.
        assert_eq!(
            split_words_with(r#""C:\Program Files\nodejs\node.exe" C:\alca\main.ts"#, false).unwrap(),
            v(&[r"C:\Program Files\nodejs\node.exe", r"C:\alca\main.ts"])
        );
        let args = split_words_with(r#"main.ts --data-dir "/tmp/my data""#, true).unwrap();
        assert_eq!(flag_value(&args, "--data-dir").as_deref(), Some("/tmp/my data"));
    }

    #[test]
    fn flag_value_takes_the_last_one_in_either_form() {
        assert_eq!(
            flag_value(&v(&["--data-dir", "/a", "--data-dir=/b"]), "--data-dir").as_deref(),
            Some("/b")
        );
        assert_eq!(flag_value(&v(&["--data-dir=/a"]), "--data-dir").as_deref(), Some("/a"));
        assert_eq!(flag_value(&v(&["--data-directory", "/a"]), "--data-dir"), None);
        assert_eq!(flag_value(&v(&["--data-dir"]), "--data-dir"), None);
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("alca-shell-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unpacks_the_bundled_core_once_and_keeps_its_symlinks() {
        let d = scratch("unpack");
        let src = d.join("src").join("alca");
        std::fs::create_dir_all(src.join("apps/desktop/src")).unwrap();
        std::fs::create_dir_all(src.join("packages/core")).unwrap();
        std::fs::create_dir_all(src.join("node_modules/@alca")).unwrap();
        std::fs::write(src.join("apps/desktop/src/main.ts"), "// main").unwrap();
        std::fs::write(src.join("packages/core/index.ts"), "// core").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("../../packages/core", src.join("node_modules/@alca/core")).unwrap();
        let tarball = d.join(BUNDLED_TARBALL);
        let ok = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(d.join("src"))
            .arg("alca")
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let root = d.join("bundled");
        let tree = unpack_core(&tarball, &root, "9.9.9").expect("unpacked");
        assert_eq!(tree, root.join("9.9.9"));
        assert!(tree.join("apps/desktop/src/main.ts").exists());
        assert!(!root.join("9.9.9.partial").exists());
        #[cfg(unix)]
        {
            let link = tree.join("node_modules/@alca/core");
            assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
            assert!(link.join("index.ts").exists());
        }
        // Second start: already there, no tar run needed (the tarball may even be gone).
        std::fs::remove_file(&tarball).unwrap();
        assert_eq!(unpack_core(&tarball, &root, "9.9.9"), Some(root.join("9.9.9")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_broken_tarball_is_not_used_and_leaves_nothing_behind() {
        let d = scratch("broken");
        let tarball = d.join(BUNDLED_TARBALL);
        std::fs::write(&tarball, b"not a tarball").unwrap();
        let root = d.join("bundled");
        assert_eq!(unpack_core(&tarball, &root, "1.0.0"), None);
        assert!(!root.join("1.0.0").exists());
        assert!(!root.join("1.0.0.partial").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ui_url_keeps_the_token_in_the_fragment() {
        assert_eq!(ui_url(4317, "ab", None, ""), "http://127.0.0.1:4317/#token=ab");
        assert_eq!(ui_url(1, "ab", None, "open=pair"), "http://127.0.0.1:1/#token=ab&open=pair");
        assert_eq!(ui_url(1, "ab", Some("c0de"), ""), "http://127.0.0.1:1/#token=ab&ui=c0de");
        assert_eq!(
            ui_url(1, "ab", Some("c0de"), "open=pair"),
            "http://127.0.0.1:1/#token=ab&ui=c0de&open=pair"
        );
    }

    #[test]
    fn launch_codes_are_fresh_lower_hex_and_one_per_line() {
        let a = launch_code().expect("random");
        let b = launch_code().expect("random");
        assert_eq!(a.len(), LAUNCH_CODE_BYTES * 2);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b);
        assert_eq!(hex(&[0, 15, 255]), "000fff");
        assert_eq!(launch_line("ab"), "ab\n");
    }
}
