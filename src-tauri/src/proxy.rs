use std::io::{Read, Take};
use tiny_http::Request;
use url::Url;

use crate::response;

pub const USER_AGENT: &str = concat!("WordHunter/", env!("CARGO_PKG_VERSION"), " (Tauri)");
const MAX_PROXY_BODY: u64 = 10_485_760;
const MAX_PROXY_REDIRECTS: usize = 5;

#[derive(Debug)]
enum ProxyFetchError {
    Forbidden,
    Other(String),
}

fn validate_proxy_url(target: &Url) -> Result<(), ProxyFetchError> {
    if !matches!(target.scheme(), "http" | "https") {
        return Err(ProxyFetchError::Forbidden);
    }
    let host = target.host_str().unwrap_or_default();
    let allowed = matches!(host, "gutenberg.org" | "www.gutenberg.org" | "gutendex.com")
        || cfg!(test) && host == "127.0.0.1";
    if !allowed {
        return Err(ProxyFetchError::Forbidden);
    }
    Ok(())
}

fn fetch_proxy_target(mut target: Url) -> Result<ureq::Response, ProxyFetchError> {
    for redirect_count in 0..=MAX_PROXY_REDIRECTS {
        validate_proxy_url(&target)?;
        let response = crate::http::no_redirect_agent()
            .get(target.as_str())
            .set("User-Agent", USER_AGENT)
            .call()
            .map_err(|error| ProxyFetchError::Other(error.to_string()))?;
        if !matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
            if (300..400).contains(&response.status()) {
                return Err(ProxyFetchError::Other(format!(
                    "unsupported upstream redirect status {}",
                    response.status()
                )));
            }
            return Ok(response);
        }
        if redirect_count == MAX_PROXY_REDIRECTS {
            return Err(ProxyFetchError::Other(
                "upstream redirect limit exceeded".to_string(),
            ));
        }
        let location = response.header("Location").ok_or_else(|| {
            ProxyFetchError::Other("upstream redirect is missing Location".to_string())
        })?;
        target = target.join(location).map_err(|error| {
            ProxyFetchError::Other(format!("invalid upstream redirect: {error}"))
        })?;
    }
    unreachable!("bounded redirect loop must return")
}

/// Proxy endpoint — fetch remote resources for allowed domains only.
/// Currently permits gutenberg.org and gutendex.com.
pub fn serve_proxy(request: Request, query: &str) -> Result<(), String> {
    let params = response::parse_query(query);
    let Some(target) = params.get("url") else {
        return response::error_response(request, 400, "bad url");
    };
    let parsed = Url::parse(target).map_err(|e| e.to_string())?;
    let resp = match fetch_proxy_target(parsed) {
        Ok(response) => response,
        Err(ProxyFetchError::Forbidden) => {
            return response::error_response(request, 403, "domain not allowed");
        }
        Err(ProxyFetchError::Other(error)) => return Err(error),
    };
    let content_type = resp
        .header("Content-Type")
        .unwrap_or("text/plain; charset=utf-8")
        .to_string();
    let mut reader: Take<_> = resp.into_reader().take(MAX_PROXY_BODY);
    let mut body = Vec::new();
    reader.read_to_end(&mut body).map_err(|e| e.to_string())?;
    if body.len() as u64 >= MAX_PROXY_BODY {
        return response::error_response(request, 413, "response too large");
    }
    response::respond(request, 200, body, &content_type, false)
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    use url::Url;

    use super::{ProxyFetchError, fetch_proxy_target, validate_proxy_url};

    fn read_request(stream: &mut TcpStream) {
        let mut request = Vec::new();
        let mut chunk = [0u8; 1024];
        while !request
            .windows(4)
            .any(|window| window == b"\x0d\x0a\x0d\x0a")
        {
            let count = stream.read(&mut chunk).expect("request should be readable");
            if count == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..count]);
        }
    }

    #[test]
    fn follows_an_allowed_redirect_after_validating_the_next_hop() {
        let target = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let target_port = target.local_addr().unwrap().port();
        let target_thread = thread::spawn(move || {
            let (mut stream, _) = target.accept().unwrap();
            read_request(&mut stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\x0d\x0aContent-Type: text/plain\x0d\x0aContent-Length: 9\x0d\x0aConnection: close\x0d\x0a\x0d\x0abook text")
                .unwrap();
            stream.flush().unwrap();
        });

        let source = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let source_port = source.local_addr().unwrap().port();
        let source_thread = thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            read_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 302 Found\x0d\x0aLocation: http://127.0.0.1:{target_port}/book.txt\x0d\x0aContent-Length: 0\x0d\x0aConnection: close\x0d\x0a\x0d\x0a"
            )
            .unwrap();
            stream.flush().unwrap();
        });

        let initial = Url::parse(&format!("http://127.0.0.1:{source_port}/start")).unwrap();
        let response = fetch_proxy_target(initial).expect("allowed redirect should resolve");
        assert_eq!(response.status(), 200);
        assert_eq!(response.into_string().unwrap(), "book text");
        source_thread.join().unwrap();
        target_thread.join().unwrap();
    }

    #[test]
    fn rejects_redirect_targets_outside_the_proxy_allowlist() {
        let current = Url::parse("https://www.gutenberg.org/ebooks/1.txt.utf-8").unwrap();
        let redirected = current.join("https://example.com/private").unwrap();

        assert!(matches!(
            validate_proxy_url(&redirected),
            Err(ProxyFetchError::Forbidden)
        ));
        assert!(validate_proxy_url(&current).is_ok());
    }
}
