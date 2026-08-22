// Static shell template for the Settings view (phase-1 general panels).
// Kept in its own module so events/settings.ts stays focused on behaviour;
// all localizable strings use data-i18n attributes applied at runtime by i18n.
export const SETTINGS_VIEW_HTML = `
        <div class="settings-grid">
          <section class="panel" aria-labelledby="appearance-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.appearanceEyebrow">Appearance</p>
              <h2 id="appearance-heading" data-i18n="settings.appearanceHeading">Theme and interface</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupLanguage">Language and interface</p>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.theme">Theme</span>
                  <small data-i18n="settings.themeHint">The theme is shared by all learning languages. Familiar themes stay dark on desktop and follow the system mode on Pocket.</small>
                </span>
                <select id="pref-theme" data-pref="theme">
                  <option value="familiar" data-i18n="settings.themeFamiliar">Familiar (cool blue)</option>
                  <option value="alternative-familiar" data-i18n="settings.themeAlternativeFamiliar">Alternative familiar (aubergine and orange)</option>
                  <option value="classic-auto" data-i18n="settings.themeClassicAuto">Word Hunter Classic (system)</option>
                  <option value="classic-light" data-i18n="settings.themeClassicLight">Word Hunter Classic (light)</option>
                  <option value="classic-dark" data-i18n="settings.themeClassicDark">Word Hunter Classic (dark)</option>
                </select>
              </label>
              <label class="setting-row language-setting-row">
                <span class="language-setting-title" data-i18n="settings.interfaceLanguageTitle">App interface language</span>
                <span class="language-select-wrap">
                  <img class="language-select-flag" data-language-flag="locale" src="flags/en.svg" alt="" aria-hidden="true">
                  <select id="pref-locale-settings" aria-label="App interface language" data-i18n-attr="aria-label=settings.interfaceLanguageTitle">
                    <option value="pl" data-i18n="languages.pl">Polish</option>
                    <option value="en" data-i18n="languages.en">English</option>
                    <option value="de" data-i18n="languages.de">German</option>
                    <option value="es" data-i18n="languages.es">Spanish</option>
                    <option value="fr" data-i18n="languages.fr">French</option>
                    <option value="it" data-i18n="languages.it">Italian</option>
                    <option value="uk" data-i18n="languages.uk">Українська</option>
                    <option value="ru" data-i18n="languages.ru">Muscovite State</option>
                    <option value="ja" data-i18n="languages.ja">Japanese</option>
                    <option value="zh" data-i18n="languages.zh">Chinese (Simplified)</option>
                  </select>
                </span>
              </label>
              <label class="setting-row language-setting-row">
                <span class="language-setting-title" data-i18n="settings.learningLanguageTitle">Learning language (profile)</span>
                <span class="language-select-wrap">
                  <img class="language-select-flag" data-language-flag="learning" src="flags/de.svg" alt="" aria-hidden="true">
                  <select id="pref-learning-language-settings" aria-label="Learning language (profile)" data-i18n-attr="aria-label=settings.learningLanguageTitle">
                    <option value="en" data-i18n="languages.en">English</option>
                    <option value="de" data-i18n="languages.de">German</option>
                    <option value="es" data-i18n="languages.es">Spanish</option>
                    <option value="it" data-i18n="languages.it">Italian</option>
                    <option value="fr" data-i18n="languages.fr">French</option>
                    <option value="pl" data-i18n="languages.pl">Polish</option>
                    <option value="uk" data-i18n="languages.uk">Українська</option>
                    <option value="ru" data-i18n="languages.ru">Muscovite State</option>
                    <option value="ja" data-i18n="languages.ja">Japanese</option>
                    <option value="zh" data-i18n="languages.zh">Chinese (Simplified)</option>
                    <option value="la" data-i18n="languages.la">Latin</option>
                    <option value="grc" data-i18n="languages.grc">Ancient Greek</option>
                    <option value="other" data-i18n="languages.other">Other</option>
                  </select>
                </span>
              </label>
              <div class="setting-row pocket-only-setting">
                <span>
                  <span data-i18n="nav.help">Help</span>
                  <small data-i18n="help.tipsTitle">Useful Tips</small>
                </span>
                <button class="secondary-button" type="button" data-open-view="help" data-i18n="nav.help">Help</button>
              </div>
              <label class="setting-row desktop-only-setting">
                <span id="pref-ui-scale-label"></span>
                <input id="pref-ui-scale" type="range" min="80" max="150" step="5" aria-labelledby="pref-ui-scale-label">
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.touchControls">Larger controls</span>
                  <small data-i18n="settings.touchControlsHint">On desktop, makes buttons and spacing roomier for touch screens, laptops, and tablets.</small>
                </span>
                <input id="pref-touch-controls" type="checkbox" data-pref="touchControls">
              </label>
              <p class="settings-subheading" data-i18n="settings.groupLearningDisplay">Learning display</p>
              <label class="setting-row">
                <span data-i18n="settings.reviewGraphType">Flashcard chart</span>
                <select id="pref-review-graph-type">
                  <option value="heatmap" data-i18n="settings.reviewGraphHeatmap">Heatmap</option>
                  <option value="dueForecast" data-i18n="settings.reviewGraphDue">Due forecast (21 days)</option>
                  <option value="intervals" data-i18n="settings.reviewGraphIntervals">Intervals</option>
                  <option value="easeDistribution" data-i18n="settings.reviewGraphEase">Ease (EF)</option>
                  <option value="repetitions" data-i18n="settings.reviewGraphReps">Repetitions</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.statusColors">Status colors</span>
                <div class="color-pickers-group">
                  <input type="color" id="pref-color-new" class="color-picker-lg" data-i18n-attr="title=vocab.statusNew,aria-label=vocab.statusNew">
                  <input type="color" id="pref-color-learning" class="color-picker-lg" data-i18n-attr="title=vocab.statusLearning,aria-label=vocab.statusLearning">
                  <input type="color" id="pref-color-known" class="color-picker-lg" data-i18n-attr="title=vocab.statusKnown,aria-label=vocab.statusKnown">
                  <input type="color" id="pref-color-ignored" class="color-picker-lg" data-i18n-attr="title=vocab.statusIgnored,aria-label=vocab.statusIgnored">
                </div>
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.dynamicLearningColors">Learning word color by SRS level</span>
                  <small data-i18n="settings.dynamicLearningColorsHint">Level 1 starts orange and level 5 ends green. Adjust the colors below.</small>
                </span>
                <input id="pref-dynamic-learning-colors" type="checkbox">
              </label>
              <div class="setting-row" id="pref-learning-colors-row" hidden>
                <span data-i18n="settings.learningColorPalette">Learning color palette (levels 1–5)</span>
                <div class="color-pickers-group">
                  <input type="color" class="color-picker-lg" data-learning-color="0">
                  <input type="color" class="color-picker-lg" data-learning-color="1">
                  <input type="color" class="color-picker-lg" data-learning-color="2">
                  <input type="color" class="color-picker-lg" data-learning-color="3">
                  <input type="color" class="color-picker-lg" data-learning-color="4">
                </div>
              </div>

              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.cardStats">Stats on book cards</span>
                  <small data-i18n="settings.cardStatsHint">Shows each book's reading progress and vocabulary count in the Library cards.</small>
                </span>
                <input id="pref-card-stats" type="checkbox">
              </label>
              <label class="setting-row" id="pref-card-stats-mode-row">
                <span>
                  <span data-i18n="settings.cardStatsMode">Book statistics values</span>
                  <small data-i18n="settings.cardStatsModeHint">Show percentages, exact occurrence counts, or both.</small>
                </span>
                <select id="pref-card-stats-mode">
                  <option value="percentages" data-i18n="settings.cardStatsModePercentages">Percentages</option>
                  <option value="counts" data-i18n="settings.cardStatsModeCounts">Counts</option>
                  <option value="both" data-i18n="settings.cardStatsModeBoth">Percentages and counts</option>
                </select>
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.covers">Book Covers</span>
                  <small data-i18n="settings.coversHint">Shows book cover thumbnails when Gutenberg metadata provides one; books without covers stay text-only.</small>
                </span>
                <input id="pref-covers" type="checkbox">
              </label>
              <div class="setting-row desktop-only-setting">
                <span data-i18n="settings.ocrGpuAcceleration">OCR acceleration</span>
                <output id="ocr-gpu-status" aria-live="polite" data-i18n="settings.ocrGpuChecking">Checking…</output>
              </div>
            </div>
          </section>


          <!-- Phase 2 (#127 P3): Reader and Translator & Dictionary panels stay
               static in index.html until renderSettingsView() covers them. -->
          <section class="panel" aria-labelledby="reader-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.readerEyebrow">Reader</p>
              <h2 id="reader-prefs-heading" data-i18n="settings.readerHeading">Typography and behaviour</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupReader">Reader layout</p>
              <label class="setting-row">
                <span data-i18n="settings.font">Reader font</span>
                <select id="pref-font" data-pref="readerFont">
                  <option value="serif" data-i18n="settings.fontSerif">Serif (Georgia)</option>
                  <option value="sans" data-i18n="settings.fontSans">Sans-serif (Segoe UI)</option>
                  <option value="mono" data-i18n="settings.fontMono">Monospace (mono)</option>
                  <option value="atkinson" data-i18n="settings.fontAtkinson">Atkinson Hyperlegible</option>
                  <option value="dyslexic" data-i18n="settings.fontDyslexic">OpenDyslexic (dyslexia-friendly)</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.lineHeight">Line height</span>
                <select id="pref-line-height" data-pref="readerLineHeight">
                  <option value="compact" data-i18n="settings.lineCompact">Compact</option>
                  <option value="normal" data-i18n="settings.lineNormal">Normal</option>
                  <option value="loose" data-i18n="settings.lineLoose">Loose</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.textAlign">Text alignment</span>
                <select id="pref-text-align" data-pref="readerTextAlign">
                  <option value="left" data-i18n="settings.alignLeft">Left</option>
                  <option value="justify" data-i18n="settings.alignJustify">Justified</option>
                </select>
              </label>
              <label class="setting-row">
                <span data-i18n="settings.maxWidth">Page width</span>
                <select id="pref-max-width" data-pref="readerMaxWidth">
                  <option value="narrow" data-i18n="settings.widthNarrow">Narrow</option>
                  <option value="medium" data-i18n="settings.widthMedium">Medium</option>
                  <option value="wide" data-i18n="settings.widthWide">Wide</option>
                  <option value="full" data-i18n="settings.widthFull">Full width</option>
                </select>
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.readerFocusMode">Reader focus mode</span>
                  <small data-i18n="settings.readerFocusModeHint">On desktop, hides the top bar, book metadata, and shortcut hints to leave more room for text.</small>
                </span>
                <input id="pref-reader-focus-mode" type="checkbox" data-pref="readerFocusMode">
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.readerWordPanelVisible">Word panel</span>
                  <small data-i18n="settings.readerWordPanelVisibleHint">Lets you hide the right panel and read at full width when you do not need it.</small>
                </span>
                <input id="pref-reader-word-panel-visible" type="checkbox" data-pref="readerWordPanelVisible">
              </label>
              <details class="word-panel-items-setting">
                <summary id="word-panel-items-heading" class="settings-subheading" data-i18n="settings.wordPanelItemsHeading"></summary>
                <div class="word-panel-items-setting-body">
                  <p id="word-panel-items-hint" class="muted-copy" data-i18n="settings.wordPanelItemsHint"></p>
                  <ol id="pref-selected-word-panel-items" class="word-panel-item-list" aria-labelledby="word-panel-items-heading" aria-describedby="word-panel-items-hint"></ol>
                </div>
              </details>
              <label class="setting-row">
                <span data-i18n="settings.wordsPerPage">Words per page</span>
                <select id="pref-words-per-page">
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                  <option value="2000">2000</option>
                  <option value="5000">5000</option>
                  <option value="999999" data-i18n="settings.wordsAll">All</option>
                </select>
              </label>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.wordAlgorithm">Word recognition</span>
                  <small data-i18n="settings.wordAlgorithmHint">New detects languages without spaces and short subtitle lines better, for example Japanese or Chinese. Classic splits only letter runs, so it can be more predictable for simple texts.</small>
                </span>
                <select id="pref-word-algorithm">
                  <option value="modern" data-i18n="settings.wordAlgorithmModern">New (default)</option>
                  <option value="classic" data-i18n="settings.wordAlgorithmClassic">Classic</option>
                </select>
              </label>
              <label class="setting-row">
                <span id="pref-font-size-label"></span>
                <input id="pref-font-size" type="range" min="14" max="28" step="1" aria-labelledby="pref-font-size-label">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.highlight">Highlight word status in text</span>
                  <small data-i18n="settings.highlightHint">Underlines saved words in the reader using their learning-status colors. Turn off for plain text.</small>
                </span>
                <input id="pref-highlight" type="checkbox" data-pref="highlightTokens">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.hideKnownIgnored">Hide known and ignored</span>
                  <small data-i18n="settings.hideKnownIgnoredHint">Leaves known and ignored words unmarked, so only words that still need attention stand out.</small>
                </span>
                <input id="pref-hide-known" type="checkbox" data-pref="hideKnownIgnored">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoLearn">Auto-mark as “Learning”</span>
                  <small data-i18n="settings.autoLearnHint">First click on an unknown word immediately saves it as Learning instead of leaving it New.</small>
                </span>
                <input id="pref-auto-learn" type="checkbox" data-pref="autoLearnOnClick">
              </label>
              <p class="settings-subheading" data-i18n="settings.groupFeedbackSounds">Feedback sounds</p>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.statusSounds">Feedback sounds</span>
                  <small data-i18n="settings.statusSoundsHint">Plays a short sound after rating a flashcard or changing a word status.</small>
                </span>
                <input id="pref-status-sounds-enabled" type="checkbox" data-pref="statusSoundsEnabled">
              </label>
              <label class="setting-row">
                <span id="pref-status-sound-volume-label" data-i18n="settings.statusSoundVolume">Feedback sound volume: {n}%</span>
                <input id="pref-status-sound-volume" type="range" min="0" max="100" step="5" data-pref="statusSoundVolume" aria-labelledby="pref-status-sound-volume-label">
              </label>
              <p class="settings-subheading" data-i18n="settings.groupTts">Text to speech</p>
              <label class="setting-row">
                <span data-i18n="settings.ttsRate">TTS Speech Rate</span>
                <select id="pref-tts-rate" data-pref="ttsRate">
                  <option value="slow" data-i18n="settings.rateSlow">Slow</option>
                  <option value="normal" data-i18n="settings.rateNormal">Normal</option>
                  <option value="fast" data-i18n="settings.rateFast">Fast</option>
                </select>
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoTtsOnWordFocus">Read word on focus</span>
                  <small data-i18n="settings.autoTtsOnWordFocusHint">Plays pronunciation whenever word focus changes by click or keyboard navigation.</small>
                </span>
                <input id="pref-auto-tts-on-word-focus" type="checkbox" data-pref="autoTtsOnWordFocus">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.ttsWordHighlight">Highlight spoken word</span>
                  <small data-i18n="settings.ttsWordHighlightHint">Shows a yellow outline on the word currently being read when the TTS engine reports word timing.</small>
                </span>
                <input id="pref-tts-word-highlight" type="checkbox" data-pref="ttsWordHighlight">
              </label>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.useEdgeTts">Edge Neural TTS (online)</span>
                  <small data-i18n="settings.useEdgeTtsHint" class="muted-fw-400"></small>
                </span>
                <input id="pref-use-edge-tts" type="checkbox" data-pref="useEdgeTts">
              </label>
            </div>
          </section>

          <section class="panel" aria-labelledby="flashcard-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.flashcardEyebrow">Flashcards</p>
              <h2 id="flashcard-prefs-heading" data-i18n="settings.flashcardHeading">Reviews and algorithm</h2>
            </div>
            <div class="settings-body">
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoAddLearningOnly">Flashcards: only 'Learning' words</span>
                  <small data-i18n="settings.autoAddLearningOnlyHint">Only Learning words enter the review queue. New words stay out until you mark them Learning.</small>
                </span>
                <input id="pref-auto-add-learning" type="checkbox" data-pref="autoAddLearningOnly">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.autoTtsOnFlashcardOpen">Read new flashcards automatically</span>
                  <small data-i18n="settings.autoTtsOnFlashcardOpenHint">Plays pronunciation when you move to another word in Flashcards.</small>
                </span>
                <input id="pref-auto-tts-on-flashcard-open" type="checkbox" data-pref="autoTtsOnFlashcardOpen">
              </label>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.inTextReview">Reviews while reading</span>
                  <small data-i18n="settings.inTextReviewHint">For Learning words, guess the translation first, then rate your recall from 1 to 5. (Reader review becomes available no sooner than the following day after first learning the word.)</small>
                </span>
                <input id="pref-in-text-review" type="checkbox">
              </label>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.srsAlgorithm">Flashcard algorithm</span>
                  <small data-i18n="settings.srsAlgorithmHint">SM-2 schedules from your last grade and ease factor. FSRS estimates stability and difficulty from review history, so due dates can change more aggressively.</small>
                </span>
                <select id="pref-srs-algorithm">
                  <option value="sm2" data-i18n="settings.srsAlgorithmSm2">SM-2 (classic)</option>
                  <option value="fsrs" data-i18n="settings.srsAlgorithmFsrs">FSRS (optional)</option>
                </select>
              </label>
              <label class="setting-row">
                <span>
                  <span data-i18n="settings.removalBehavior">Word removal behavior</span>
                  <small data-i18n="settings.removalBehaviorHint">Ignore keeps the entry and hides it from learning. Delete removes it completely, so the word appears as New again.</small>
                </span>
                <select id="pref-removal-behavior" data-pref="removalBehavior">
                  <option value="ignored" data-i18n="settings.removalBehaviorIgnored">Ignore (keep translation)</option>
                  <option value="delete" data-i18n="settings.removalBehaviorDelete">Delete (reset as 'new')</option>
                </select>
              </label>
            </div>
          </section>


          <!-- Phase 2 (#127 P3): Translator & Dictionary panel stays
               static in index.html until renderSettingsView() covers them. -->
          <section class="panel" aria-labelledby="translator-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.translatorEyebrow">Translator &amp; Dictionary</p>
              <h2 id="translator-prefs-heading" data-i18n="settings.translatorHeading">Translations and links</h2>
            </div>
            <div class="settings-body">
              <div id="pref-translation-language-settings" hidden>
                <label class="setting-row stack">
                  <span>
                    <span data-i18n="settings.translationSourceLanguage">Translation source language</span>
                    <small data-i18n="settings.translationLanguageHint">Enter a language code such as nl, pt-BR, or eo. The pair is shared by every translation engine in this profile.</small>
                  </span>
                  <input id="pref-translation-source-language" type="text" list="translation-language-codes" autocomplete="off" spellcheck="false" data-i18n-attr="placeholder=settings.translationSourceLanguagePlaceholder" class="input">
                </label>
                <label class="setting-row stack">
                  <span data-i18n="settings.translationTargetLanguage">Translation target language</span>
                  <input id="pref-translation-target-language" type="text" list="translation-language-codes" autocomplete="off" spellcheck="false" data-i18n-attr="placeholder=settings.translationTargetLanguagePlaceholder" class="input">
                </label>
                <datalist id="translation-language-codes">
                  <option value="de"></option>
                  <option value="en"></option>
                  <option value="es"></option>
                  <option value="fr"></option>
                  <option value="it"></option>
                  <option value="ja"></option>
                  <option value="pl"></option>
                  <option value="ru"></option>
                  <option value="uk"></option>
                  <option value="zh"></option>
                  <option value="la"></option>
                  <option value="grc"></option>
                </datalist>
              </div>
              <label class="setting-row toggle-row desktop-only-setting">
                <span>
                  <span data-i18n="settings.offlineTranslator">Advanced offline translator</span>
                  <small data-i18n="settings.offlineTranslatorHint">Enables local CTranslate2 translation for words and full sentences. Works offline after downloading language packs (~100-200MB each).</small>
                </span>
                <input id="pref-offline-translator" type="checkbox">
              </label>
              <label class="setting-row">
                <span data-i18n="settings.translationProvider">Translation engine</span>
                <select id="pref-translation-provider">
                  <option value="offline" data-i18n="settings.translationProviderOffline">Offline CTranslate2</option>
                  <option value="deepl" data-i18n="settings.translationProviderDeepL">DeepL</option>
                  <option value="google" data-i18n="settings.translationProviderGoogle">Google Translate</option>
                  <option value="lmstudio" data-i18n="settings.translationProviderLmStudio">LM Studio</option>
                </select>
              </label>
              <label id="pref-deepl-key-row" class="setting-row stack" hidden>
                <span data-i18n="settings.deeplApiKey">DeepL API key</span>
                <input id="pref-deepl-api-key" type="password" data-i18n-attr="placeholder=settings.deeplApiKeyPlaceholder" class="input">
              </label>
              <label id="pref-lmstudio-endpoint-row" class="setting-row desktop-only-setting stack" hidden>
                <span data-i18n="settings.lmStudioEndpoint">LM Studio endpoint</span>
                <input id="pref-lmstudio-endpoint" type="text" class="input">
              </label>
              <label id="pref-lmstudio-model-row" class="setting-row desktop-only-setting stack" hidden>
                <span data-i18n="settings.lmStudioModel">LM Studio model</span>
                <input id="pref-lmstudio-model" type="text" data-i18n-attr="placeholder=settings.lmStudioModelPlaceholder" class="input">
              </label>
              <label id="pref-auto-translate-row" class="setting-row toggle-row dimmed">
                <span>
                  <span data-i18n="settings.autoTranslate">Auto-fill translation</span>
                  <small data-i18n="settings.autoTranslateHint">When a saved word has an empty translation, fills it with the selected translation engine. Manual translations stay untouched.</small>
                </span>
                <input id="pref-auto-translate" type="checkbox" data-pref="autoTranslateWords">
              </label>
              <label id="pref-argos-as-dict-row" class="setting-row toggle-row desktop-only-setting dimmed">
                <span>
                  <span data-i18n="settings.argosAsDict">Dictionary button opens translator</span>
                  <small data-i18n="settings.argosAsDictHint">Makes the dictionary button (M) open the built-in offline translator for the selected word instead of your dictionary URL.</small>
                </span>
                <input id="pref-argos-as-dict" type="checkbox" data-pref="argosAsDict">
              </label>
              <label class="setting-row desktop-only-setting">
                <span data-i18n="settings.dictionaryMode">Open Dictionary in</span>
                <select id="pref-dictionary-mode" data-pref="dictionaryMode">
                  <option value="internal" data-i18n="settings.dictModeInternal">Internal window</option>
                  <option value="external" data-i18n="settings.dictModeExternal">External browser</option>
                </select>
              </label>
              <label class="setting-row desktop-only-setting">
                <span data-i18n="settings.youglishMode">Opening YouGlish</span>
                <select id="pref-youglish-mode" data-pref="youglishMode">
                  <option value="internal" data-i18n="settings.dictModeInternal">Internal window</option>
                  <option value="external" data-i18n="settings.dictModeExternal">External browser</option>
                </select>
              </label>
              <label class="setting-row stack">
                <span data-i18n="settings.dictionaryUrl">Dictionary URL (use {{word}})</span>
                <input id="pref-dictionary-url" type="text" data-pref="dictionaryUrl" data-i18n-attr="placeholder=settings.dictionaryUrlPlaceholder" placeholder="https://en.wiktionary.org/wiki/{{word}}" class="input">
              </label>
            </div>
          </section>

          <section class="panel" aria-labelledby="ai-prefs-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.aiEyebrow">AI explanations</p>
              <h2 id="ai-prefs-heading" data-i18n="settings.aiHeading">AI explanations of words and phrases</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupAi">Language assistant</p>
              <p class="muted-copy" data-i18n="settings.aiHint">Explains the selected word or phrase based on the sentence it appears in. Works with any OpenAI-compatible server — local (LM Studio, llama.cpp, Ollama) or remote (e.g. opencode.ai, OpenAI, DeepSeek).</p>
              <label class="setting-row toggle-row">
                <span>
                  <span data-i18n="settings.aiExplanations">Enable AI explanations</span>
                  <small data-i18n="settings.aiExplanationsHint">Adds an “Explain” button to the word panel. The API key is stored locally and sent only to the endpoint you choose.</small>
                </span>
                <input id="pref-ai-explanations" type="checkbox">
              </label>
              <label id="pref-ai-endpoint-row" class="setting-row stack" hidden>
                <span data-i18n="settings.aiEndpoint">Endpoint (OpenAI-compatible)</span>
                <input id="pref-ai-endpoint" type="text" class="input">
              </label>
              <div id="pref-ai-model-row" class="setting-row stack" hidden>
                <label for="pref-ai-model" data-i18n="settings.aiModel">Model</label>
                <div class="ai-model-picker">
                  <div class="ai-model-input-row">
                    <input id="pref-ai-model" type="text" autocomplete="off" data-i18n-attr="placeholder=settings.aiModelPlaceholder" class="input">
                    <button id="pref-ai-model-refresh" type="button" class="secondary-button" data-i18n="settings.aiModelsRefresh">Refresh models</button>
                  </div>
                  <input id="pref-ai-model-search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="pref-ai-model-options" autocomplete="off" enterkeyhint="done" data-i18n-attr="placeholder=settings.aiModelsSearch,aria-label=settings.aiModelsSearch" class="input">
                  <small id="pref-ai-model-status" class="ai-model-status" role="status" aria-live="polite"></small>
                  <div id="pref-ai-model-options" class="ai-model-options" role="listbox" data-i18n-attr="aria-label=settings.aiModel" hidden></div>
                </div>
              </div>
              <label id="pref-ai-key-row" class="setting-row stack" hidden>
                <span data-i18n="settings.aiApiKey">API key</span>
                <input id="pref-ai-api-key" type="password" data-i18n-attr="placeholder=settings.aiApiKeyPlaceholder" class="input">
              </label>
              <label id="pref-ai-effort-row" class="setting-row stack" hidden>
                <span>
                  <span data-i18n="settings.aiEffort">Reasoning effort</span>
                  <small data-i18n="settings.aiEffortHint">How much effort the model should put into reasoning. Empty = do not send — the endpoint uses its own default.</small>
                </span>
                <select id="pref-ai-effort" class="input">
                  <option value="" data-i18n="settings.aiEffortAuto">Automatic (do not send)</option>
                  <option value="minimal" data-i18n="settings.aiEffortMinimal">Minimal</option>
                  <option value="low" data-i18n="settings.aiEffortLow">Low</option>
                  <option value="medium" data-i18n="settings.aiEffortMedium">Medium</option>
                  <option value="high" data-i18n="settings.aiEffortHigh">High</option>
                  <option value="max" data-i18n="settings.aiEffortMax">Maximum</option>
                </select>
              </label>
              <label id="pref-ai-auto-trigger-row" class="setting-row toggle-row" hidden>
                <span>
                  <span data-i18n="settings.aiAutoTrigger">Explain new words automatically</span>
                  <small data-i18n="settings.aiAutoTriggerHint">When a word without an AI explanation is opened, the explanation is fetched automatically and appended to the word's note.</small>
                </span>
                <input id="pref-ai-auto-trigger" type="checkbox">
              </label>
            </div>
          </section>

          <section class="panel" aria-labelledby="data-heading">
            <div class="panel-header stacked">
              <p class="eyebrow" data-i18n="settings.dataEyebrow">Local data</p>
              <h2 id="data-heading" data-i18n="settings.dataHeading">Import and export</h2>
            </div>
            <div class="settings-body">
              <p class="settings-subheading" data-i18n="settings.groupLocalData">Data on this device</p>
              <p class="muted-copy" id="storage-summary"></p>
              <p class="muted-copy" id="data-directory"></p>
              <div class="data-actions compact-actions desktop-only-setting">
                <button id="choose-data-directory" type="button" class="secondary-button desktop-only-control" data-i18n="settings.chooseDataFolder">Choose local data folder</button>
              </div>
              <div id="recovery-status-panel" class="recovery-status-panel" hidden>
                <div id="recovery-status-list" class="recovery-status-list"></div>
              </div>
              <p class="settings-subheading" data-i18n="settings.groupBackup">Backup and import</p>
              <div class="data-actions">
                <section class="data-action-row desktop-only-setting">
                  <div class="data-action-copy">
                    <h3 data-i18n="update.checkTitle">App updates</h3>
                    <p data-i18n="update.checkHint">Manually check whether a newer version of Word Hunter is available.</p>
                  </div>
                  <div class="data-action-buttons">
                    <button class="secondary-button" type="button" id="check-updates" data-i18n="update.checkButton">Check for updates</button>
                  </div>
                </section>
                <section class="data-action-row">
                  <div class="data-action-copy">
                    <h3 data-i18n="settings.resetTitle">Restore settings</h3>
                    <p data-i18n="settings.resetHint">Resets theme, reader, dictionary, TTS, and other preferences to defaults. It does not delete words or texts.</p>
                  </div>
                  <div class="data-action-buttons">
                    <button class="secondary-button" type="button" id="reset-prefs" data-i18n="settings.resetPrefs">Reset Preferences</button>
                  </div>
                </section>

              </div>
            </div>
          </section>

        </div>
  `;
