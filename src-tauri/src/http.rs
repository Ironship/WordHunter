use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn agent() -> ureq::Agent {
    agent_with_timeouts(CONNECT_TIMEOUT, READ_TIMEOUT)
}

fn agent_with_timeouts(connect_timeout: Duration, read_timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(connect_timeout)
        .timeout_read(read_timeout)
        .build()
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::io::{self, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    use super::agent_with_timeouts;

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
}
