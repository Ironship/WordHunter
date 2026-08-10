use std::sync::LazyLock;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Large-file downloads (offline-translator model packages, up to 400 MB)
/// must not abort when a CDN stalls mid-stream for more than 30 s.
const READ_TIMEOUT_EXTENDED: Duration = Duration::from_secs(300);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);

static AGENT: LazyLock<ureq::Agent> =
    LazyLock::new(|| agent_with_timeouts(CONNECT_TIMEOUT, READ_TIMEOUT));
static DOWNLOAD_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    download_agent_with_timeouts(CONNECT_TIMEOUT, READ_TIMEOUT_EXTENDED, DOWNLOAD_TIMEOUT)
});

pub(crate) fn agent() -> &'static ureq::Agent {
    &AGENT
}

/// Agent with an extended read timeout for large downloads.
pub(crate) fn download_agent() -> &'static ureq::Agent {
    &DOWNLOAD_AGENT
}

fn agent_with_timeouts(connect_timeout: Duration, read_timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(connect_timeout)
        .timeout_read(read_timeout)
        .build()
}

fn download_agent_with_timeouts(
    connect_timeout: Duration,
    read_timeout: Duration,
    overall_timeout: Duration,
) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(connect_timeout)
        .timeout_read(read_timeout)
        .timeout(overall_timeout)
        .build()
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::io::{self, Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    use super::{agent_with_timeouts, download_agent_with_timeouts};

    #[test]
    fn http_agent_builder_enforces_read_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n")
                .unwrap();
            stream.flush().unwrap();
            thread::sleep(Duration::from_millis(200));
        });

        let error = agent_with_timeouts(Duration::from_secs(1), Duration::from_millis(25))
            .get(&format!("http://{address}/"))
            .call()
            .expect_err("incomplete response headers should hit the configured read timeout");
        assert_eq!(error.kind(), ureq::ErrorKind::Io);
        let io_error = error
            .source()
            .and_then(|source| source.downcast_ref::<io::Error>())
            .expect("timeout should retain its io::Error source");
        assert_eq!(io_error.kind(), io::ErrorKind::TimedOut);
        server.join().unwrap();
    }

    #[test]
    fn download_agent_enforces_an_overall_deadline_while_bytes_keep_arriving() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK
\nContent-Length: 1000
\n
\n",
                )
                .unwrap();
            for _ in 0..1000 {
                if stream.write_all(b"x").is_err() {
                    break;
                }
                if stream.flush().is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
        });

        let response = download_agent_with_timeouts(
            Duration::from_secs(1),
            Duration::from_millis(50),
            Duration::from_millis(40),
        )
        .get(&format!("http://{address}/"))
        .call()
        .unwrap();
        let error = response
            .into_reader()
            .read_to_end(&mut Vec::new())
            .expect_err("a continuously active response must still hit the overall deadline");

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        server.join().unwrap();
    }
}
