//! A tiny HTTP/1.1 GET against the core on loopback (no HTTP client crate:
//! one request, `Connection: close`, read to the end). The core checks the
//! Host header, so it is exactly `127.0.0.1:<port>`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoreStatus {
    pub approvals: u64,
    pub questions: u64,
    pub phones_online: u64,
}

impl CoreStatus {
    pub fn waiting(&self) -> u64 {
        self.approvals + self.questions
    }
}

pub fn get(port: u16, path: &str, token: Option<&str>) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    parse(&String::from_utf8_lossy(&buf))
}

fn parse(raw: &str) -> Option<(u16, String)> {
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let code = head.split_whitespace().nth(1)?.parse().ok()?;
    // The core answers JSON without chunking for these routes; tolerate a chunked body anyway.
    let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(body)
    } else {
        body.to_owned()
    };
    Some((code, body))
}

fn dechunk(mut s: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = s.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        s = rest[n..].trim_start_matches("\r\n");
    }
    out
}

/// Is a core answering on this port? (`/api/health` needs no token.)
pub fn healthy(port: u16) -> bool {
    matches!(get(port, "/api/health", None), Some((200, _)))
}

/// What the tray shows, from `/api/status`.
pub fn status(port: u16, token: &str) -> Option<CoreStatus> {
    let (code, body) = get(port, "/api/status", Some(token))?;
    if code != 200 {
        return None;
    }
    parse_status(&body)
}

pub fn parse_status(body: &str) -> Option<CoreStatus> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let n = |p: &str| v.pointer(p).and_then(|x| x.as_u64()).unwrap_or(0);
    Some(CoreStatus {
        approvals: n("/waiting/approvals"),
        questions: n("/waiting/questions"),
        phones_online: n("/link/phonesOnline"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_and_a_chunked_answer() {
        let plain = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        assert_eq!(parse(plain), Some((200, "{\"ok\":true}".into())));
        let chunked =
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n";
        assert_eq!(parse(chunked), Some((200, "{\"a\":1}".into())));
    }

    #[test]
    fn counts_what_waits_on_the_person() {
        let s =
            parse_status(r#"{"ok":true,"waiting":{"approvals":2,"questions":1},"link":{"phonesOnline":1}}"#)
                .unwrap();
        assert_eq!(s.waiting(), 3);
        assert_eq!(s.phones_online, 1);
        assert_eq!(parse_status(r#"{"ok":true,"waiting":{},"link":null}"#).unwrap().waiting(), 0);
    }
}
