import { state } from "./state.js";

interface StatusTone {
  frequency: number;
  offset: number;
  duration: number;
  type: OscillatorType;
}

const STATUS_TONES: Readonly<Partial<Record<string, readonly StatusTone[]>>> = Object.freeze({
  new: [
    { frequency: 523.25, offset: 0, duration: 0.11, type: "sine" }
  ],
  learning: [
    { frequency: 392, offset: 0, duration: 0.12, type: "triangle" },
    { frequency: 493.88, offset: 0.09, duration: 0.14, type: "triangle" }
  ],
  known: [
    { frequency: 523.25, offset: 0, duration: 0.11, type: "sine" },
    { frequency: 659.25, offset: 0.075, duration: 0.12, type: "sine" },
    { frequency: 783.99, offset: 0.15, duration: 0.18, type: "sine" }
  ],
  ignored: [
    { frequency: 369.99, offset: 0, duration: 0.13, type: "triangle" },
    { frequency: 277.18, offset: 0.09, duration: 0.18, type: "sine" }
  ]
});

let audioContext: AudioContext | null = null;

function statusSoundContext() {
  if (audioContext) return audioContext;
  if (typeof window === "undefined") return null;
  const AudioContextConstructor = window.AudioContext
    || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContext = new AudioContextConstructor();
  return audioContext;
}

export function playStatusSound(status: string, options: { volume?: number } = {}) {
  const tones = STATUS_TONES[status];
  if (!tones || state.preferences?.statusSoundsEnabled === false) return false;
  const volume = Math.max(0, Math.min(1, Number(options.volume ?? state.preferences?.statusSoundVolume ?? 0.55)));
  if (!volume) return false;

  try {
    const context = statusSoundContext();
    if (!context) return false;
    if (context.state === "suspended") void context.resume();
    const start = context.currentTime + 0.008;
    const master = context.createGain();
    master.gain.setValueAtTime(volume * 0.18, start);
    master.connect(context.destination);

    for (const tone of tones) {
      const toneStart = start + tone.offset;
      const toneEnd = toneStart + tone.duration;
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      oscillator.type = tone.type;
      oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
      envelope.gain.setValueAtTime(0.0001, toneStart);
      envelope.gain.exponentialRampToValueAtTime(1, toneStart + 0.018);
      envelope.gain.exponentialRampToValueAtTime(0.0001, toneEnd);
      oscillator.connect(envelope);
      envelope.connect(master);
      oscillator.start(toneStart);
      oscillator.stop(toneEnd + 0.01);
    }
    return true;
  } catch (error) {
    console.warn("Status sound playback failed", error);
    return false;
  }
}
