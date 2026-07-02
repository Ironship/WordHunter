use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build()
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{CONNECT_TIMEOUT, READ_TIMEOUT};

    #[test]
    fn http_agent_has_bounded_timeouts() {
        assert_eq!(CONNECT_TIMEOUT, Duration::from_secs(10));
        assert_eq!(READ_TIMEOUT, Duration::from_secs(30));
    }
}
