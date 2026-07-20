fn main() {
    #[cfg(target_os = "linux")]
    {
        // ort-sys ships ONNX Runtime as a static archive. A regular
        // rustc-link-lib directive is emitted before Rust's static rlibs and
        // gets discarded by --as-needed before the WebGPU symbols appear.
        // Keep Dawn at the end of the linker command, after ort-sys.
        println!("cargo:rustc-link-arg-bin=wordhunter-paddleocr=-lwebgpu_dawn");
    }
}
