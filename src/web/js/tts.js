import { state } from "./state.js";

let speaking = false;
let currentAudio = null;
let onFinishCallback = null;

function getTtsLang(lang) {
  const map = { en: "en-US", de: "de-DE", es: "es-ES", fr: "fr-FR", it: "it-IT", pl: "pl-PL", uk: "uk-UA", ru: "ru-RU", ja: "ja-JP" };
  return map[lang] || "en-US";
}

function getTtsRate(rate) {
  if (rate === "slow") return 0.75;
  if (rate === "fast") return 1.25;
  return 1.0;
}

export function speakWord(word) {
  if (state.preferences.useEdgeTts === true) {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    
    const lang = state.preferences.learningLanguage || "en";
    const url = `/__tts?text=${encodeURIComponent(word)}&lang=${lang}`;
    
    currentAudio = new Audio(url);
    currentAudio.playbackRate = getTtsRate(state.preferences.ttsRate || "normal");
    
    currentAudio.play().catch(err => {
      console.warn("Edge TTS audio play failed", err);
      // Only fall back to local if it was a real load failure and not an intentional abort/pause
      if (err.name !== "AbortError") {
        speakWordLocal(word);
      }
    });
  } else {
    speakWordLocal(word);
  }
}

function speakWordLocal(word) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  
  const lang = state.preferences.learningLanguage || "en";
  const ttsLang = getTtsLang(lang);
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    const hasVoice = voices.some(v => v.lang.toLowerCase().startsWith(ttsLang.split('-')[0].toLowerCase()));
    if (!hasVoice) {
      import("./toast.js").then(m => {
        import("./i18n.js").then(i => {
          m.showToast(i.t("toast.ttsMissing"));
        });
      });
    }
  }

  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = getTtsLang(state.preferences.learningLanguage || "en");
  utterance.rate = getTtsRate(state.preferences.ttsRate || "normal");
  window.speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  speaking = false;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  clearHighlights();
  if (onFinishCallback) {
    onFinishCallback();
    onFinishCallback = null;
  }
}

export function speakText(text, containerElement, onFinish) {
  stopSpeaking();
  onFinishCallback = onFinish;

  const selectedText = window.getSelection().toString().trim();
  const textToRead = selectedText || text;

  // Split text into sentences for better pacing
  const sentences = textToRead.match(/[^.!?\n。！？]+[.!?\n).！？]+|[^.!?\n。！？]+$/g) || [textToRead];
  
  speaking = true;
  
  if (state.preferences.useEdgeTts === true) {
    readNextSentenceEdge(sentences, 0, containerElement);
  } else {
    readNextSentenceLocal(sentences, 0, containerElement);
  }
}

function readNextSentenceEdge(sentences, index, containerElement) {
  if (!speaking || index >= sentences.length) {
    stopSpeaking();
    return;
  }

  const sentence = sentences[index].trim();
  if (!sentence) {
    readNextSentenceEdge(sentences, index + 1, containerElement);
    return;
  }

  const lang = state.preferences.learningLanguage || "en";
  const url = `/__tts?text=${encodeURIComponent(sentence)}&lang=${lang}`;
  
  currentAudio = new Audio(url);
  currentAudio.playbackRate = getTtsRate(state.preferences.ttsRate || "normal");
  
  currentAudio.onplay = () => {
    highlightContainer(containerElement);
  };
  
  currentAudio.onended = () => {
    if (speaking) {
      readNextSentenceEdge(sentences, index + 1, containerElement);
    }
  };
  
  currentAudio.play().catch(err => {
    console.warn("Edge TTS play failed", err);
    if (!speaking) return; // Stopped or changed intentionally
    
    if (err.name !== "AbortError") {
      speakSentenceLocal(sentence, () => {
        if (speaking) {
          readNextSentenceEdge(sentences, index + 1, containerElement);
        }
      });
    }
  });
}

function readNextSentenceLocal(sentences, index, containerElement) {
  if (!speaking || index >= sentences.length) {
    stopSpeaking();
    return;
  }

  const sentence = sentences[index].trim();
  if (!sentence) {
    readNextSentenceLocal(sentences, index + 1, containerElement);
    return;
  }

  const lang = state.preferences.learningLanguage || "en";
  const ttsLang = getTtsLang(lang);
  const voices = window.speechSynthesis.getVoices();
  if (voices.length > 0) {
    const hasVoice = voices.some(v => v.lang.toLowerCase().startsWith(ttsLang.split('-')[0].toLowerCase()));
    if (!hasVoice) {
      import("./toast.js").then(m => {
        import("./i18n.js").then(i => {
          m.showToast(i.t("toast.ttsMissing"));
        });
      });
    }
  }

  const utterance = new SpeechSynthesisUtterance(sentence);
  utterance.lang = getTtsLang(state.preferences.learningLanguage || "en");
  utterance.rate = getTtsRate(state.preferences.ttsRate || "normal");
  
  utterance.onstart = () => {
    highlightContainer(containerElement);
  };
  
  utterance.onend = () => {
    if (speaking) {
      readNextSentenceLocal(sentences, index + 1, containerElement);
    }
  };
  
  utterance.onerror = (e) => {
    console.warn("TTS Error", e);
    stopSpeaking();
  };

  window.speechSynthesis.speak(utterance);
}

function speakSentenceLocal(sentence, onEnd) {
  if (!window.speechSynthesis) {
    if (onEnd) onEnd();
    return;
  }
  const utterance = new SpeechSynthesisUtterance(sentence);
  utterance.lang = getTtsLang(state.preferences.learningLanguage || "en");
  utterance.rate = getTtsRate(state.preferences.ttsRate || "normal");
  utterance.onend = () => {
    if (onEnd) onEnd();
  };
  utterance.onerror = () => {
    if (onEnd) onEnd();
  };
  window.speechSynthesis.speak(utterance);
}

function highlightContainer(containerElement) {
  if (!containerElement) return;
  containerElement.classList.add('reading-active');
}

function clearHighlights() {
  document.querySelectorAll('.reading-active').forEach(el => el.classList.remove('reading-active'));
}
