const FNV_OFFSET: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;
const SAMPLE_PREFIX: usize = 1536;
const SAMPLE_MIDDLE: usize = 2048;
const SAMPLE_SUFFIX: usize = 1536;
const SAMPLE_MIDDLE_OFFSET: usize = 1024;
const MAX_FULL_SAMPLE: usize = 4096;

pub fn sample_text(value: &str) -> String {
    if value.len() <= MAX_FULL_SAMPLE {
        return value.to_string();
    }
    let middle_start = value.len() / 2;
    let middle = middle_start.saturating_sub(SAMPLE_MIDDLE_OFFSET);
    let middle_end = (middle + SAMPLE_MIDDLE).min(value.len());
    let suffix_start = value.len() - SAMPLE_SUFFIX;
    let mut out = String::with_capacity(SAMPLE_PREFIX + 1 + SAMPLE_MIDDLE + 1 + SAMPLE_SUFFIX);
    out.push_str(&value[..SAMPLE_PREFIX]);
    out.push('|');
    out.push_str(&value[middle..middle_end]);
    out.push('|');
    out.push_str(&value[suffix_start..]);
    out
}

pub fn fnv1a_hash(value: &str) -> u32 {
    let mut hash = FNV_OFFSET;
    for byte in value.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

pub fn fnv1a_hash_base36(value: &str) -> String {
    base36(fnv1a_hash(value))
}

fn base36(mut value: u32) -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(ALPHABET[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("base36 digits are ASCII")
}
