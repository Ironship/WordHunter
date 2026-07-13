# Frontend reliability audit

This document records the critical frontend boundaries and the implementation
checklist for validation-only CSS and JavaScript tooling. The production
frontend remains the source under `src/web`; no generated frontend bundle is
shipped.

## Non-negotiable boundaries

- [x] Keep Tauri pointed directly at `src/web`.
- [x] Keep runtime theme switching based on CSS custom properties.
- [x] Keep first-paint theme application synchronous to avoid a light/dark flash.
- [x] Keep validation tools read-only: no CSS transformation and no JS emission.
- [x] Keep npm dependencies out of Windows, Android, and Flatpak packages.
- [x] Keep `scripts/build.bat` release targets independent of `node_modules`.
- [x] Treat localStorage, HTTP bridge responses, and Android bridge data as untrusted.
- [x] Preserve WebView2, WebKitGTK, and Android System WebView compatibility rules.

## Critical source map

| Boundary | Source of truth | Required protection |
| --- | --- | --- |
| Theme names and resolution | `src/web/js/theme.js` | JSDoc unions and parity tests |
| Theme palettes | `src/web/theme.css` | Stylelint and contrast contracts |
| First paint | `src/web/index.html` | Synchronous boot and parity tests |
| Runtime theme application | `src/web/js/preferences.js` | No full Reader rerender |
| State defaults | `src/web/js/state/defaults.js` | checkJs |
| Untrusted state normalization | `src/web/js/state/normalize.js` | checkJs and migration tests |
| Live state replacement | `src/web/js/state.js` | Replacement event tests |
| Outbound persistence payload | `src/web/js/api.js` | checkJs wire types |
| Native store requests | `src/web/js/store-bridge.js` | unknown response boundary |
| Bridge commit/reload | `src/web/js/bridge-commit.js` | checked call signatures |
| Android bridge detection | `src/web/js/platform.js` | ambient bridge declarations |
| Popup theme rendering | `src/web/templates/translator-popup.html` | shared palette and Rust template test |
| Repository validation | `scripts/validate.sh` | one read-only frontend gate |
| Pull request validation | `.github/workflows/validate.yml` | pinned npm install and gate |
| Artifact validation | `.github/workflows/artifact-validation.yml` | one prerequisite validation job |

## Implementation checklist

### Baseline

- [x] Audit theme state, CSS cascade, contrast, bridge migration, and test gaps.
- [x] Commit the behavior fixes separately as `81b8ab6`.
- [x] Confirm focused theme tests pass before structural refactoring.
- [x] Record the final validation commands and outcomes below.

### CSS simplification

- [x] Extract palette-only declarations from `styles.css` to `theme.css`.
- [x] Load `theme.css` before component and Pocket styles.
- [x] Reuse `theme.css` in the offline translator popup.
- [x] Remove duplicated popup surface, text, line, shadow, and mode palettes.
- [x] Preserve popup-specific accent and hover behavior with component aliases.
- [x] Remove redundant `--border` and `--text` aliases.
- [x] Preserve a non-`color-mix()` focus fallback for older WebViews.
- [x] Verify Classic, Familiar, and Alternative Familiar in light and dark modes.

### CSS validation

- [x] Add a private root validation package with exact dependency versions.
- [x] Add a committed lockfile.
- [x] Add Stylelint with a correctness-focused configuration.
- [x] Parse CSS embedded in HTML with `postcss-html`.
- [x] Fix baseline findings instead of broadly disabling rules.
- [x] Do not add Sass, Autoprefixer, CSS minification, or `--fix` to CI.

### JavaScript validation

- [x] Add a no-emit `tsconfig.check-js.json`.
- [x] Add ambient declarations outside the shipped web assets.
- [x] Opt in only critical theme, state, persistence, and bridge modules.
- [x] Keep fetched and injected snapshots typed as `unknown` until validation.
- [x] Resolve bridge call-signature drift rather than suppressing it.
- [x] Do not add broad `@ts-ignore` or `@ts-nocheck` directives.
- [x] Do not convert runtime `.js` modules to `.ts` in this stage.

### CI and packaging

- [x] Run `npm run check:frontend` from `scripts/validate.sh`.
- [x] Install validation dependencies once in the PR validation job.
- [x] Add one validation prerequisite job to artifact validation.
- [x] Run the repository gate for `release/**` pushes.
- [x] Run frontend tests and JSON validation before artifact packaging.
- [x] Keep package jobs free of npm installation.
- [x] Exclude `node_modules` from Git and Flatpak directory sources.
- [x] Document bootstrap and validation commands.

### Regression protection

- [x] Assert shared stylesheet order in the main app and popup.
- [x] Assert every named palette contains required tokens and contrast pairs.
- [x] Assert the popup does not contain copied named palettes.
- [x] Assert theme changes do not rerender Reader content.
- [x] Assert bridge legacy theme migration before defaults are applied.
- [x] Assert tooling is no-emit, read-only, pinned, and wired into CI.
- [x] Run frontend module linking, shared, desktop, and Android tests.
- [x] Run JSON/i18n validation and `git diff --check`.

## Deferred work

- [ ] Add rendered computed-style screenshots after choosing a pinned browser matrix.
- [ ] Opt additional native event consumers into checkJs one module at a time.
- [ ] Consider stricter indexed-access checks after the first typed boundary is stable.
- [ ] Consider a generated theme manifest only if boot/runtime parity regresses again.
- [ ] Pin the external Flatpak Cargo generator and its Python dependency floor.
- [ ] Add a local Flatpak preflight that verifies the Flathub remote.

The deferred items are deliberately outside the first gate. They require browser
binaries or a broader type migration and must not block the smaller reliability
improvements above.

## Validation log

- `npm ci --ignore-scripts --no-audit --no-fund`: passed with Node 22.
- `npm run check:frontend`: Stylelint and TypeScript no-emit checks passed.
- Full Node frontend suite: 268 tests passed, 0 failed.
- JSON/i18n validation: 18 JSON files and 9 locales passed.
- `git diff --check`: passed.
- Runtime frontend source: reduced by removing duplicated palettes and dead bridge arguments.
- Native Rust compilation remains covered by repository CI after the commit is pushed.
