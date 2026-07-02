use std::{env, path::PathBuf};

use cmake::Config;

use crate::download;

pub fn build_dnnl(link: bool) {
    let out_dir = if let Ok(dir) = env::var("CARGO_TARGET_DIR") {
        PathBuf::from(dir)
    } else {
        let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
        PathBuf::from(manifest_dir).join("target")
    }
    .join("dnnl");
    let dnnl_version = "3.1.1";
    let dnnl_archive = format!("v{}.tar.gz", dnnl_version);
    let dnnl_url = format!(
        "https://github.com/oneapi-src/oneDNN/archive/refs/tags/{}",
        dnnl_archive
    );

    let source_dir = out_dir.join(format!("oneDNN-{}", dnnl_version));

    if !source_dir.exists() {
        if download::download(&dnnl_url, &out_dir) != 200 {
            panic!("Failed to download oneDNN");
        }
    }
    let mut cmake = Config::new(source_dir);

    let dst = cmake
        .define("CMAKE_POLICY_VERSION_MINIMUM", "3.5")
        .define("ONEDNN_LIBRARY_TYPE", "STATIC")
        .define("ONEDNN_BUILD_EXAMPLES", "OFF")
        .define("ONEDNN_BUILD_TESTS", "OFF")
        .define("ONEDNN_ENABLE_WORKLOAD", "INFERENCE")
        .define("ONEDNN_ENABLE_PRIMITIVE", "CONVOLUTION;REORDER")
        .define("ONEDNN_BUILD_GRAPH", "OFF")
        .build();
    println!("cargo:rustc-link-search=native={}/lib", dst.display());
    if link {
        println!("cargo:rustc-link-lib=static=dnnl");
    }
    println!("cargo:include={}/include", dst.display());
}
