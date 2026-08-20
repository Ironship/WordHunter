use super::{ACTIVE_SYNTHESIS, MAX_CONCURRENT_SYNTHESIS, SynthesisPermit, cached_with, rate_for, runtime, voice_for};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

// The permit counter is a process-global, so the two tests that mutate it
// must not run concurrently with each other (cargo test runs tests in the
// same binary in parallel threads).
static PERMIT_TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn runtime_stays_alive_after_initialization() {
    // C15 regression: caching only a Handle drops the Runtime, so the next
    // block_on panics with "A Tokio 1.x context was found, but it is being
    // shutdown."
    runtime()
        .expect("runtime init should succeed")
        .block_on(async { tokio::time::sleep(Duration::from_millis(1)).await });
}

#[test]
fn failed_init_is_not_cached_and_the_next_call_retries() {
    let cache: Mutex<Option<u32>> = Mutex::new(None);
    let calls = AtomicUsize::new(0);
    let init_fail = || {
        calls.fetch_add(1, Ordering::Relaxed);
        Err::<u32, _>("temporary failure".to_string())
    };
    let init_ok = || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(7)
    };
    assert_eq!(
        cached_with(&cache, init_fail),
        Err("temporary failure".to_string())
    );
    // The failure must NOT be cached: the next call runs `init` again.
    assert_eq!(cached_with(&cache, init_ok), Ok(7));
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

#[test]
fn successful_init_is_cached_across_calls() {
    let cache: Mutex<Option<u32>> = Mutex::new(None);
    let calls = AtomicUsize::new(0);
    let init = || {
        calls.fetch_add(1, Ordering::Relaxed);
        Ok(7)
    };
    assert_eq!(cached_with(&cache, init), Ok(7));
    assert_eq!(cached_with(&cache, || Ok(9)), Ok(7));
    assert_eq!(cached_with(&cache, || Ok(9)), Ok(7));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
}

#[test]
fn maps_only_supported_rate_presets() {
    assert_eq!(rate_for("slow"), "-25%");
    assert_eq!(rate_for("normal"), "+0%");
    assert_eq!(rate_for("fast"), "+25%");
    assert_eq!(rate_for("<prosody rate='999%'>"), "+0%");
}

#[test]
fn maps_known_languages_to_native_voices() {
    assert_eq!(voice_for("pl"), "pl-PL-MarekNeural");
    assert_eq!(voice_for("en"), "en-US-AriaNeural");
    assert_eq!(voice_for("de"), "de-DE-ConradNeural");
    assert_eq!(voice_for("zh"), "zh-CN-YunjianNeural");
    assert_eq!(voice_for("grc"), "el-GR-NestorasNeural");
}

#[test]
fn falls_back_to_english_for_unknown() {
    assert_eq!(voice_for("xx"), "en-US-AriaNeural");
    assert_eq!(voice_for(""), "en-US-AriaNeural");
}

#[test]
fn synthesis_permits_reject_at_capacity_and_release_on_drop() {
    let _serial = PERMIT_TEST_LOCK.lock().unwrap();
    let first = SynthesisPermit::acquire().expect("first permit");
    let second = SynthesisPermit::acquire().expect("second permit");
    assert_eq!(
        SynthesisPermit::acquire().err().as_deref(),
        Some("TTS is busy; retry")
    );
    drop(first);
    let replacement = SynthesisPermit::acquire().expect("released permit");
    drop((second, replacement));
    assert_eq!(ACTIVE_SYNTHESIS.load(Ordering::Relaxed), 0);
}

/// The free-synthesis slot must be safe when two threads race to acquire a
/// permit at the same instant. The slot is an atomic counter
/// (`ACTIVE_SYNTHESIS`), not a Mutex-free/check-then-act value, and the same
/// `active < MAX_CONCURRENT_SYNTHESIS` check is what `synthesize()` runs right
/// before its blocking await — so no interleaving can let a stale "free" count
/// admit more than the configured number of concurrent syntheses.
#[test]
fn synthesis_slot_is_atomic_across_parallel_threads() {
    let _serial = PERMIT_TEST_LOCK.lock().unwrap();
    let baseline = ACTIVE_SYNTHESIS.load(Ordering::Relaxed);
    assert_eq!(baseline, 0, "slot must be idle before the race");

    // Release both workers at the exact same barrier round so their
    // ACTIVE_SYNTHESIS.fetch_update calls genuinely overlap.
    let ready = std::sync::Arc::new(std::sync::Barrier::new(3)); // 2 workers + main
    let both_held = std::sync::Arc::new(std::sync::Barrier::new(2)); // 2 workers only
    let release_gate = std::sync::Arc::new(std::sync::Barrier::new(2)); // 2 workers only
    let observed = std::sync::Arc::new(std::sync::Mutex::new(Vec::<usize>::new()));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let ready = ready.clone();
            let both_held = both_held.clone();
            let release_gate = release_gate.clone();
            let observed = observed.clone();
            std::thread::spawn(move || {
                ready.wait();
                let permit = SynthesisPermit::acquire().expect("parallel thread permit");
                // Both workers pass this gate only after BOTH acquired a permit,
                // so the next sample is taken while both are still held.
                both_held.wait();
                observed
                    .lock()
                    .unwrap()
                    .push(ACTIVE_SYNTHESIS.load(Ordering::Relaxed));
                // Neither worker may drop (and decrement) until both have
                // sampled, so the counter read above is deterministic.
                release_gate.wait();
                drop(permit);
            })
        })
        .collect();
    ready.wait();
    for worker in workers {
        worker.join().unwrap();
    }

    // Both racing threads held a permit simultaneously. The atomic counter
    // must have reached exactly MAX_CONCURRENT_SYNTHESIS in flight (never
    // more, never less) — a shared "free count + plain check" slot could
    // admit a third overlap, an atomic one cannot.
    let observed = observed.lock().unwrap();
    assert_eq!(observed.len(), 2, "both workers sampled the counter");
    assert!(
        observed.iter().all(|&value| value == MAX_CONCURRENT_SYNTHESIS),
        "both parallel permits held at once, counter must be exactly \
         MAX_CONCURRENT_SYNTHESIS, got {observed:?}"
    );

    // Every permit was released on drop, so the global counter is back to the
    // pre-race idle state.
    assert_eq!(ACTIVE_SYNTHESIS.load(Ordering::Relaxed), baseline);
}
