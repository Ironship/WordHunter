/// Compute type (example) — adjust to match your C API
#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ComputeType {
    Default = 0,
    Auto = 1,
    Float32 = 2,
    Int8 = 3,
    Int8Float32 = 4,
    Int8Float16 = 5,
    Int8Bfloat16 = 6,
    Int16 = 7,
    BFfloat16 = 8,
    Float16 = 9,
}
