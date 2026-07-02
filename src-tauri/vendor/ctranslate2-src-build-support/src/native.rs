use std::{
    env,
    path::{Path, PathBuf},
};

use crate::Os;

pub fn build_native(
    path: &Path,
    os: Os,
    cuda: bool,
    cudnn: bool,
    cuda_dynamic_loading: bool,
    aarch64: bool,
    mkl: bool,
    openblas: bool,
    ruy: bool,
    accelarate: bool,
    tensor_parallel: bool,
    msse4_1: bool,
    dnnl: bool,
    openmp_comp: bool,
    openmp_intel: bool,
    flash_attention: bool,
    cuda_small_binary: bool,
    shared: bool,
) -> PathBuf {
    let mut cmake = cmake::Config::new(path);
    cmake
        .define("BUILD_CLI", "OFF")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("WITH_MKL", "OFF")
        .define("OPENMP_RUNTIME", "NONE")
        .define("CMAKE_POLICY_VERSION_MINIMUM", "3.5");
    if shared {
        cmake.define("BUILD_SHARED_LIBS", "ON");
    }
    if os == Os::Win {
        let rustflags = env::var("CARGO_ENCODED_RUSTFLAGS").unwrap_or_default();
        if !rustflags.contains("target-feature=+crt-static") {
            println!(
                "cargo:warning=For Windows compilation, setting the environment variable `RUSTFLAGS=-C target-feature=+crt-static` might be required."
            );
        } else {
            cmake.static_crt(true);
        }

        let target = env::var("TARGET").unwrap_or_default();
        if target.contains("windows-gnu") {
            println!("cargo:rustc-link-arg=-Wl,--allow-multiple-definition");
            cmake.profile("Release");
        } else {
            println!("cargo::rustc-link-arg=/FORCE:MULTIPLE");
            cmake.profile("Release").cxxflag("/EHsc");
        }
    } else if os == Os::Linux {
        cmake.define("CMAKE_POSITION_INDEPENDENT_CODE", "ON");
    }

    if cuda {
        let cuda = cuda_root().expect("CUDA_TOOLKIT_ROOT_DIR is not specified");
        cmake.define("WITH_CUDA", "ON");
        cmake.define("CUDA_TOOLKIT_ROOT_DIR", &cuda);
        cmake.define("CUDA_ARCH_LIST", "5.3;6.0;6.2;7.0;7.2;7.5;8.0;8.6;8.9;9.0");
        cmake.define(
            "CUDA_NVCC_FLAGS",
            format!(
                "{}{}",
                if cuda_small_binary {
                    "-Xfatbin=-compress-all "
                } else {
                    ""
                },
                "-Xcompiler=-fPIC"
            ),
        );

        if cudnn {
            cmake.define("WITH_CUDNN", "ON");
        }
        if cuda_dynamic_loading {
            cmake.define("CUDA_DYNAMIC_LOADING", "ON");
        }
    }
    if os == Os::Mac && aarch64 {
        cmake.define("CMAKE_OSX_ARCHITECTURES", "arm64");
    }

    if mkl {
        cmake.define("WITH_MKL", "ON");
    }
    if openblas {
        cmake.define("WITH_OPENBLAS", "ON");
    }
    if ruy {
        cmake.define("WITH_RUY", "ON");
    }
    if accelarate {
        cmake.define("WITH_ACCELERATE", "ON");
    }
    if tensor_parallel {
        cmake.define("WITH_TENSOR_PARALLEL", "ON");
    }
    if msse4_1 {
        cmake.define("CMAKE_CXX_FLAGS", "-msse4.1");
    }
    if dnnl {
        cmake.define("WITH_DNNL", "ON");
    }
    if openmp_comp {
        cmake.define("OPENMP_RUNTIME", "COMP");
    } else if openmp_intel {
        cmake.define("OPENMP_RUNTIME", "INTEL");
    }
    if flash_attention {
        cmake.define("WITH_FLASH_ATTN", "ON");
    }

    let ctranslate2 = cmake.build();
    ctranslate2.join("build")
}

// The function below was derived and modified from the `cudarc` crate.
// Original source: https://github.com/coreylowman/cudarc/blob/main/build.rs
//
// Copyright (c) 2024 Corey Lowman
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
pub fn cuda_root() -> Option<PathBuf> {
    let env_vars = [
        "CUDA_PATH",
        "CUDA_ROOT",
        "CUDA_TOOLKIT_ROOT_DIR",
        "CUDNN_LIB",
    ];
    let env_vars = env_vars
        .into_iter()
        .map(std::env::var)
        .filter_map(Result::ok);

    let roots = [
        "/usr",
        "/usr/local/cuda",
        "/opt/cuda",
        "/usr/lib/cuda",
        "C:/Program Files/NVIDIA GPU Computing Toolkit",
        "C:/CUDA",
    ];
    let roots = roots.into_iter().map(Into::into);
    env_vars
        .chain(roots)
        .map(Into::<PathBuf>::into)
        .find(|path| path.join("include").join("cuda.h").is_file())
}
