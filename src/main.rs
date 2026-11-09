//! RBWR Demands – desktop app.
//!
//! Serves the board (the `public/` folder, embedded into the program at build
//! time) and proxies the public RBWR server API at `/api/servers`, because
//! browsers aren't allowed to call that API directly (it sends no CORS
//! headers). Upstream is asked at most once per `CACHE_SECONDS`, however many
//! windows are open.
//!
//! With the `desktop` feature (default) the board opens in the app's own
//! window; `--browser` uses the default browser instead, and hosts
//! (`SERVER_PORT` set) run without any window.
//!
//! `--export DIR` writes the site plus a data snapshot to `DIR` instead; the
//! GitHub Pages workflow uses that.

// No black console window behind the app window on Windows.
#![cfg_attr(all(windows, feature = "desktop"), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::io::{IsTerminal, Write};
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use include_dir::{include_dir, Dir};
use serde_json::{json, Map, Value};
use tiny_http::{Header, Method, Request, Response, Server};

static PUBLIC: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/public");

const DEFAULT_UPSTREAMS: [&str; 2] = [
    "https://hydrogen.realisticbwr.org/api/public/servers",
    "https://realisticbwr.org/api/public/servers",
];
const ROBLOX_URL: &str = "https://games.roblox.com/v1/games/11765852158/servers/Public?limit=100";
const ROBLOX_TTL: Duration = Duration::from_secs(60);
const DEFAULT_PORT: u16 = 3000;
const PORT_TRIES: u16 = 10;
const WORKERS: usize = 4;
const USER_AGENT: &str = concat!("RBWR-Demands/", env!("CARGO_PKG_VERSION"));
const APP_ID: &str = "rbwr-demands";

const HELP: &str = "\
RBWR Demands – live grid demands for every RBWR server

Usage: rbwr-demands [options]

  --port N        Port to use (default 3000, or the next free one)
  --lan           Also reachable from other devices on your network (phone, tablet)
  --browser       Open the board in your browser instead of the app window
  --no-browser    No window and no browser: just run the server
  --demo          Open the board with demo data
  --export DIR    Write the website and a data snapshot to DIR, then exit
  -h, --help      Show this help

Environment: PORT / SERVER_PORT, HOST, CACHE_SECONDS, UPSTREAM_URLS (comma-separated)
";

// ---- configuration -----------------------------------------------------------

/// Where the board is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ui {
    /// The app's own window (needs the `desktop` feature).
    Window,
    /// The default web browser.
    Browser,
    /// Nothing: server only.
    None,
}

#[derive(Debug, Clone)]
struct Config {
    host: String,
    port: u16,
    fixed_port: bool,
    lan: bool,
    ui: Ui,
    demo: bool,
    export: Option<PathBuf>,
    cache_ttl: Duration,
    upstreams: Vec<String>,
}

fn parse_config(args: &[String], var: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
    // SERVER_PORT is set by Pterodactyl-style hosts (e.g. Waifly): headless, public.
    let hosted = var("SERVER_PORT").is_some();
    let env_port = var("PORT").or_else(|| var("SERVER_PORT"));
    let mut cfg = Config {
        host: var("HOST").unwrap_or_else(|| if hosted { "0.0.0.0" } else { "127.0.0.1" }.into()),
        port: DEFAULT_PORT,
        fixed_port: false,
        lan: false,
        ui: if hosted {
            Ui::None
        } else if cfg!(feature = "desktop") {
            Ui::Window
        } else {
            Ui::Browser
        },
        demo: false,
        export: None,
        cache_ttl: Duration::from_secs(
            var("CACHE_SECONDS").and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(15).max(5),
        ),
        upstreams: var("UPSTREAM_URLS")
            .map(|v| v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_else(|| DEFAULT_UPSTREAMS.iter().map(|s| s.to_string()).collect()),
    };
    if let Some(p) = env_port {
        cfg.port = p.trim().parse().map_err(|_| format!("Invalid port: {p}"))?;
        cfg.fixed_port = true;
    }

    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--port" => {
                let v = it.next().ok_or("--port needs a number")?;
                cfg.port = v.parse().map_err(|_| format!("Invalid port: {v}"))?;
                cfg.fixed_port = true;
            }
            "--lan" => {
                cfg.lan = true;
                cfg.host = "0.0.0.0".into();
            }
            "--browser" => cfg.ui = Ui::Browser,
            "--no-browser" | "--no-window" => cfg.ui = Ui::None,
            "--demo" => cfg.demo = true,
            "--export" => cfg.export = Some(PathBuf::from(it.next().ok_or("--export needs a folder")?)),
            "-h" | "--help" => return Err(HELP.into()),
            other => return Err(format!("Unknown option: {other}\n\n{HELP}")),
        }
    }
    Ok(cfg)
}

// ---- upstream data -----------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn host_of(url: &str) -> &str {
    let rest = url.split("://").nth(1).unwrap_or(url);
    rest.split(['/', '?']).next().unwrap_or(rest)
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn get_json(agent: &ureq::Agent, url: &str, timeout: Duration) -> Result<Value, String> {
    let host = host_of(url);
    match agent.get(url).timeout(timeout).set("Accept", "application/json").call() {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| format!("{host}: {e}"))?;
            serde_json::from_str(&text).map_err(|e| format!("{host}: invalid JSON ({e})"))
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("{host} answered HTTP {code}")),
        Err(ureq::Error::Transport(t)) => Err(format!("{host}: {t}")),
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct App {
    cfg: Config,
    agent: ureq::Agent,
    cache: Mutex<Option<(Instant, Value)>>,
    fetch_lock: Mutex<()>,
    roblox: Mutex<Option<(Instant, Value)>>,
}

impl App {
    fn new(cfg: Config) -> Self {
        let agent = ureq::AgentBuilder::new()
            .user_agent(USER_AGENT)
            .timeout_connect(Duration::from_secs(10))
            .try_proxy_from_env(true)
            .build();
        App { cfg, agent, cache: Mutex::new(None), fetch_lock: Mutex::new(()), roblox: Mutex::new(None) }
    }

    fn fresh(&self) -> Option<Value> {
        match &*lock(&self.cache) {
            Some((at, body)) if at.elapsed() < self.cfg.cache_ttl => Some(body.clone()),
            _ => None,
        }
    }

    /// The body for /api/servers: cached, refreshed by one request at a time,
    /// and the last good data (marked stale) if upstream is down.
    fn servers(&self) -> Result<Value, String> {
        if let Some(body) = self.fresh() {
            return Ok(body);
        }
        let _one_at_a_time = lock(&self.fetch_lock);
        if let Some(body) = self.fresh() {
            return Ok(body);
        }
        match self.refresh() {
            Ok(body) => {
                *lock(&self.cache) = Some((Instant::now(), body.clone()));
                Ok(body)
            }
            Err(err) => {
                eprintln!("[upstream] {err}");
                match lock(&self.cache).clone() {
                    Some((_, mut body)) => {
                        body["stale"] = Value::Bool(true);
                        body["error"] = Value::String(err);
                        Ok(body)
                    }
                    None => Err(err),
                }
            }
        }
    }

    fn refresh(&self) -> Result<Value, String> {
        let mut errors = Vec::new();
        for url in &self.cfg.upstreams {
            match get_json(&self.agent, url, Duration::from_secs(20)) {
                Ok(upstream) => {
                    return Ok(json!({
                        "ok": true,
                        "source": host_of(url),
                        "fetchedAt": now_ms(),
                        "upstream": upstream,
                        "roblox": self.roblox(),
                    }))
                }
                Err(e) => errors.push(e),
            }
        }
        Err(if errors.is_empty() { "no upstream configured".into() } else { errors.join("; ") })
    }

    /// Roblox public server list: player counts and which servers are public.
    fn roblox(&self) -> Value {
        if let Some((at, v)) = &*lock(&self.roblox) {
            if at.elapsed() < ROBLOX_TTL {
                return v.clone();
            }
        }
        match self.load_roblox() {
            Ok(v) => {
                *lock(&self.roblox) = Some((Instant::now(), v.clone()));
                v
            }
            Err(e) => {
                eprintln!("[roblox] {e}");
                lock(&self.roblox).as_ref().map(|(_, v)| v.clone()).unwrap_or(Value::Null)
            }
        }
    }

    fn load_roblox(&self) -> Result<Value, String> {
        let mut servers = Map::new();
        let mut cursor = String::new();
        let mut complete = false;
        for _ in 0..5 {
            let url = if cursor.is_empty() {
                ROBLOX_URL.to_string()
            } else {
                format!("{ROBLOX_URL}&cursor={}", url_encode(&cursor))
            };
            let page = get_json(&self.agent, &url, Duration::from_secs(10))?;
            for s in page["data"].as_array().into_iter().flatten() {
                if let Some(id) = s["id"].as_str() {
                    servers.insert(
                        id.to_string(),
                        json!({ "playing": s["playing"].as_u64().unwrap_or(0), "maxPlayers": s["maxPlayers"].as_u64().unwrap_or(0) }),
                    );
                }
            }
            match page["nextPageCursor"].as_str() {
                Some(c) if !c.is_empty() => cursor = c.to_string(),
                _ => {
                    complete = true;
                    break;
                }
            }
        }
        Ok(json!({ "complete": complete, "servers": servers }))
    }
}

// ---- HTTP --------------------------------------------------------------------

type Resp = Response<std::io::Cursor<Vec<u8>>>;

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn respond(status: u16, content_type: &str, body: Vec<u8>) -> Resp {
    Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-cache"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"))
}

fn respond_json(status: u16, body: &Value) -> Resp {
    respond(status, "application/json; charset=utf-8", body.to_string().into_bytes())
        .with_header(header("Cache-Control", "no-store"))
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Maps a request path to a file inside the embedded `public/` folder.
fn resolve(path: &str) -> Option<(&'static [u8], &'static str)> {
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() || rel.ends_with('/') { format!("{rel}index.html") } else { rel.to_string() };
    if rel.split('/').any(|seg| seg == ".." || seg == "." || seg.contains('\\')) {
        return None;
    }
    PUBLIC.get_file(&rel).map(|f| (f.contents(), mime(&rel)))
}

fn handle(app: &App, req: Request) {
    let resp = if *req.method() != Method::Get && *req.method() != Method::Head {
        respond(405, "text/plain; charset=utf-8", b"Method not allowed".to_vec()).with_header(header("Allow", "GET, HEAD"))
    } else {
        let path = req.url().split(['?', '#']).next().unwrap_or("/").to_string();
        match path.as_str() {
            "/api/servers" => match app.servers() {
                Ok(mut body) => {
                    body["now"] = json!(now_ms());
                    respond_json(200, &body)
                }
                Err(e) => respond_json(502, &json!({ "ok": false, "error": e, "now": now_ms() })),
            },
            "/api/health" => respond_json(200, &json!({ "ok": true, "app": APP_ID, "version": env!("CARGO_PKG_VERSION") })),
            p if p.starts_with("/api/") => respond_json(404, &json!({ "ok": false, "error": "Unknown endpoint" })),
            p => match resolve(p) {
                Some((data, ct)) => respond(200, ct, data.to_vec()),
                None => respond(404, "text/plain; charset=utf-8", b"Not found".to_vec()),
            },
        }
    };
    let _ = req.respond(resp);
}

/// If RBWR Demands already runs on this port (e.g. the shortcut was clicked
/// twice), returns its address so we can just open the browser there.
fn already_running(port: u16) -> Option<String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_millis(800)).build();
    let text = agent.get(&format!("http://127.0.0.1:{port}/api/health")).call().ok()?.into_string().ok()?;
    let body: Value = serde_json::from_str(&text).ok()?;
    (body["app"] == APP_ID).then(|| format!("http://localhost:{port}/"))
}

fn bind(cfg: &Config) -> Result<(Server, u16), String> {
    let tries = if cfg.fixed_port { 1 } else { PORT_TRIES };
    let mut last = String::new();
    for offset in 0..tries {
        let port = cfg.port.saturating_add(offset);
        match Server::http((cfg.host.as_str(), port)) {
            Ok(server) => return Ok((server, port)),
            Err(e) => last = format!("Port {port}: {e}"),
        }
    }
    Err(if cfg.fixed_port { last } else { format!("No free port between {} and {}. {last}", cfg.port, cfg.port + tries - 1) })
}

/// Address of this computer in the local network (no packets are sent).
fn lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

// ---- export (GitHub Pages) ---------------------------------------------------

fn write_dir(dir: &Dir, out: &Path) -> std::io::Result<()> {
    for file in dir.files() {
        let target = out.join(file.path());
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(target, file.contents())?;
    }
    for sub in dir.dirs() {
        write_dir(sub, out)?;
    }
    Ok(())
}

fn export(app: &App, out: &Path) -> Result<(), String> {
    let mut body = app.refresh()?;
    body["snapshot"] = Value::Bool(true);
    body["now"] = json!(now_ms());
    write_dir(&PUBLIC, out).map_err(|e| format!("Writing {}: {e}", out.display()))?;
    let api = out.join("api");
    fs::create_dir_all(&api).map_err(|e| e.to_string())?;
    fs::write(api.join("servers.json"), body.to_string()).map_err(|e| e.to_string())?;
    let count = body["upstream"]["data"]["servers"].as_array().map_or(0, |a| a.len());
    println!("Exported site with {count} servers to {}", out.display());
    Ok(())
}

// ---- main --------------------------------------------------------------------

/// On Windows a double-clicked program closes its window right away; keep
/// error messages readable.
fn fail(msg: &str) -> ! {
    show_console();
    eprintln!("\n{msg}");
    if std::io::stdin().is_terminal() {
        eprint!("\nPress Enter to close.");
        let _ = std::io::stderr().flush();
        let _ = std::io::stdin().read_line(&mut String::new());
    }
    process::exit(1);
}

/// The app is built without a console on Windows; give it one when there is
/// something to read (browser mode, errors).
#[cfg(all(windows, feature = "desktop"))]
fn show_console() {
    // SAFETY: plain Win32 call without arguments; failing (e.g. a console
    // already exists) is harmless.
    unsafe {
        windows_sys::Win32::System::Console::AllocConsole();
    }
}

#[cfg(not(all(windows, feature = "desktop")))]
fn show_console() {}

#[cfg(feature = "desktop")]
mod desktop {
    //! The app window: a native window with a web view showing the board.

    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoop};
    use tao::window::{Icon, WindowBuilder};
    use wry::{NewWindowResponse, WebContext, WebViewBuilder};

    static ICON_RGBA: &[u8] = include_bytes!("../assets/icon-64.rgba");

    /// Opens the window and runs until it is closed (then the process ends).
    /// Returns only if the window can't be created.
    pub fn run(url: &str, home: &str, title: &str) -> Result<(), String> {
        let event_loop = EventLoop::new();
        let window = WindowBuilder::new()
            .with_title(title)
            .with_inner_size(LogicalSize::new(1320.0, 900.0))
            .with_min_inner_size(LogicalSize::new(380.0, 480.0))
            .with_window_icon(Icon::from_rgba(ICON_RGBA.to_vec(), 64, 64).ok())
            .build(&event_loop)
            .map_err(|e| e.to_string())?;

        // Keep the web view's storage (pinned servers, sort order) in one
        // place per user, not next to wherever the program file lives.
        let data_dir = std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("XDG_DATA_HOME"))
            .map(|base| std::path::PathBuf::from(base).join("RBWR Demands"));
        let mut context = WebContext::new(data_dir);

        // Links that leave the board (Join, Roblox, GitHub) open in the
        // normal browser, so Roblox can start the game.
        let home = home.to_string();
        let builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(url)
            .with_navigation_handler(move |target| {
                if target.starts_with(&home) || target.starts_with("about:") {
                    true
                } else {
                    let _ = webbrowser::open(&target);
                    false
                }
            })
            .with_new_window_req_handler(|target, _| {
                let _ = webbrowser::open(&target);
                NewWindowResponse::Deny
            });

        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let webview = builder.build(&window).map_err(|e| e.to_string())?;
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            let vbox = window.default_vbox().ok_or("no GTK container for the web view")?;
            builder.build_gtk(vbox).map_err(|e| e.to_string())?
        };

        event_loop.run(move |event, _, control_flow| {
            let _keep_alive = (&window, &webview, &context);
            *control_flow = ControlFlow::Wait;
            if let Event::WindowEvent { event: WindowEvent::CloseRequested, .. } = event {
                *control_flow = ControlFlow::Exit;
            }
        })
    }
}

fn open_in_browser(url: &str) {
    if webbrowser::open(url).is_err() {
        println!("Couldn't open the browser. Open {url} yourself.");
    }
}

/// Shows the board at `url` the way the config asks for. Returns only when
/// there's no window to wait for.
fn show(cfg: &Config, url: &str, home: &str, title: &str) {
    match cfg.ui {
        Ui::Window => {
            #[cfg(feature = "desktop")]
            if let Err(e) = desktop::run(url, home, title) {
                show_console();
                eprintln!("Couldn't open the app window ({e}). Using your browser instead.");
                open_in_browser(url);
            }
            #[cfg(not(feature = "desktop"))]
            {
                let _ = (home, title);
                open_in_browser(url);
            }
        }
        Ui::Browser => open_in_browser(url),
        Ui::None => {}
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let cfg = match parse_config(&args, |k| env::var(k).ok()) {
        Ok(cfg) => cfg,
        Err(msg) if msg == HELP => {
            show_console();
            print!("{HELP}");
            return;
        }
        Err(msg) => {
            show_console();
            eprintln!("{msg}");
            process::exit(2);
        }
    };

    let app = Arc::new(App::new(cfg.clone()));

    if let Some(out) = &cfg.export {
        if let Err(e) = export(&app, out) {
            eprintln!("Export failed: {e}");
            process::exit(1);
        }
        return;
    }

    let query = if cfg.demo { "?demo" } else { "" };

    // Already running (shortcut clicked twice)? Just show that one.
    if !cfg.fixed_port && cfg.host == "127.0.0.1" {
        if let Some(home) = already_running(cfg.port) {
            show(&cfg, &format!("{home}{query}"), &home, "RBWR Demands");
            return;
        }
    }

    let (server, port) = bind(&cfg).unwrap_or_else(|e| fail(&format!("Could not start the web server. {e}")));
    let server = Arc::new(server);

    let workers: Vec<_> = (0..WORKERS)
        .map(|_| {
            let server = Arc::clone(&server);
            let app = Arc::clone(&app);
            thread::spawn(move || loop {
                match server.recv() {
                    Ok(req) => handle(&app, req),
                    Err(e) => {
                        eprintln!("[http] {e}");
                        break;
                    }
                }
            })
        })
        .collect();

    // Warm the cache so the first page load is quick.
    {
        let app = Arc::clone(&app);
        thread::spawn(move || {
            let _ = app.servers();
        });
    }

    // 127.0.0.1 rather than "localhost", which may resolve to IPv6 first.
    let home = format!("http://127.0.0.1:{port}/");
    let lan = if cfg.host == "0.0.0.0" { lan_ip().map(|ip| format!("http://{ip}:{port}/")) } else { None };

    if cfg.ui == Ui::Window {
        let title = match &lan {
            Some(lan) => format!("RBWR Demands (on your phone: {lan})"),
            None => "RBWR Demands".to_string(),
        };
        show(&cfg, &format!("{home}{query}"), &home, &title);
    } else if cfg.ui == Ui::Browser {
        show_console();
    }

    // Browser or server-only mode (or the window couldn't be opened).
    println!("RBWR Demands {} is running.", env!("CARGO_PKG_VERSION"));
    println!();
    println!("  On this computer:  http://localhost:{port}/");
    match &lan {
        Some(lan) => println!("  On your network:   {lan}"),
        None => println!("  (Start with --lan to open it on your phone too.)"),
    }
    println!();
    println!("Close this window or press Ctrl+C to stop.");
    if cfg.ui == Ui::Browser {
        show(&cfg, &format!("{home}{query}"), &home, "RBWR Demands");
    }

    for w in workers {
        let _ = w.join();
    }
}

// ---- tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(args: &[&str], vars: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        parse_config(&args, |k| map.get(k).cloned())
    }

    #[test]
    fn serves_embedded_files() {
        let (html, ct) = resolve("/").expect("index.html is embedded");
        assert!(ct.starts_with("text/html"));
        assert!(std::str::from_utf8(html).unwrap().contains("RBWR Demands"));
        assert_eq!(resolve("/js/app.js").unwrap().1, "text/javascript; charset=utf-8");
        assert_eq!(resolve("/fonts/DSEG7Classic-Bold.woff2").unwrap().1, "font/woff2");
        assert!(resolve("/nope.html").is_none());
    }

    #[test]
    fn refuses_path_traversal() {
        assert!(resolve("/../Cargo.toml").is_none());
        assert!(resolve("/js/../../src/main.rs").is_none());
        assert!(resolve("/js/..\\index.html").is_none());
    }

    #[test]
    fn defaults_are_local_with_a_window() {
        let c = cfg(&[], &[]).unwrap();
        assert_eq!(c.host, "127.0.0.1");
        assert_eq!(c.port, 3000);
        assert!(!c.fixed_port);
        assert_eq!(c.ui, if cfg!(feature = "desktop") { Ui::Window } else { Ui::Browser });
        assert_eq!(c.cache_ttl, Duration::from_secs(15));
        assert_eq!(c.upstreams.len(), 2);
    }

    #[test]
    fn options_and_environment() {
        let c = cfg(&["--lan", "--port", "8080", "--no-browser", "--demo"], &[]).unwrap();
        assert_eq!((c.host.as_str(), c.port, c.fixed_port, c.ui, c.demo), ("0.0.0.0", 8080, true, Ui::None, true));
        assert_eq!(cfg(&["--browser"], &[]).unwrap().ui, Ui::Browser);

        let hosted = cfg(&[], &[("SERVER_PORT", "25565"), ("CACHE_SECONDS", "1")]).unwrap();
        assert_eq!((hosted.host.as_str(), hosted.port, hosted.ui), ("0.0.0.0", 25565, Ui::None));
        assert_eq!(hosted.cache_ttl, Duration::from_secs(5), "cache never below 5 s");

        let up = cfg(&[], &[("UPSTREAM_URLS", " https://a.example/x , ,https://b.example/y")]).unwrap();
        assert_eq!(up.upstreams, vec!["https://a.example/x", "https://b.example/y"]);

        assert!(cfg(&["--port", "abc"], &[]).is_err());
        assert!(cfg(&["--wat"], &[]).is_err());
        assert_eq!(cfg(&["--help"], &[]).unwrap_err(), HELP);
    }

    #[test]
    fn helpers() {
        assert_eq!(host_of("https://hydrogen.realisticbwr.org/api/public/servers"), "hydrogen.realisticbwr.org");
        assert_eq!(host_of("https://games.roblox.com?x=1"), "games.roblox.com");
        assert_eq!(url_encode("a b+c/=="), "a%20b%2Bc%2F%3D%3D");
        assert_eq!(mime("x/Y.WOFF2"), "font/woff2");
    }
}
