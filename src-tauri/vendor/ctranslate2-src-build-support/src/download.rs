use std::path::Path;

use ureq::http::StatusCode;

pub fn download(url: &str, out: &Path) -> StatusCode {
    let response = ureq::get(url).call().expect("Failed to send request");
    let status = response.status();

    if response.status().as_u16() != 200 {
        return status;
    }

    let mut body = response.into_body();
    let reader = body.as_reader();

    let mut gz = flate2::read::GzDecoder::new(reader);

    let mut archive = tar::Archive::new(&mut gz);
    archive.unpack(&out).expect("Failed to extract archive");
    status
}

pub fn download_helper(url: &str, out_dir: &Path, check: bool) -> Option<()> {
    if check {
        if out_dir.exists() {
            return Some(());
        }
    }

    let mut status = StatusCode::from_u16(500).unwrap();
    for _ in 0..3 {
        status = download(url, out_dir);
        if status.is_success() || status.as_u16() == 404 {
            break;
        }
    }
    if !status.is_success() {
        return None;
    }
    Some(())
}
