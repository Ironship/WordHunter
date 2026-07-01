fn main() {
    println!("cargo:rerun-if-changed=../src/web");
    tauri_build::build()
}
