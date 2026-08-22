# Release notes — template and pre-publish checklist

Every release body published on GitHub **must** start from this file, be
edited by a human, and pass the checklist below. `docs/releases/<version>.md`
is the source of the GitHub release body — whatever lands there goes to users
verbatim.

## Template

```markdown
# Word Hunter <version>

One short paragraph: who this release is for and what it improves. Plain,
factual language — no marketing filler.

## New

- **Feature name** — what it does for the user, in one or two sentences.

## Fixes

- **Area** — what was broken and what happens now (user-visible behavior only).

## Known issues

- (or "None reported.")

## Upgrade notes

- Only when users must act (migration, install constraints).
```

## Pre-publish checklist

- [ ] No tool output: no shell commands (`npm run …`, `scripts/…`), no exit
      codes, no test counters ("684/684 PASS"), no versionCode arithmetic.
- [ ] No AI/prompt artifacts: no phrases like "quality-of-life", "focused
      catalog", "wave", "supersedes the never-published…", no bullet cadence
      that reads like a changelog generator. Read every line aloud; if it
      sounds like nobody human would say it, rewrite it.
- [ ] No internal jargon: branch names, PR numbers, reviewer notes,
      "(not merged)" annotations, security-fix wave labels.
- [ ] Every bullet describes user-visible behavior, not the implementation.
- [ ] Known issues section present (explicit "None reported." is fine).
- [ ] Version string matches the tag and all version sinks
      (`scripts/check-version-sinks.sh <version>`).
- [ ] Second person read-through by someone who did not write the notes.

## Rationale

Release 1.1.0-rc.4 shipped CI verification output and machine-styled copy in
the public body. Users read release notes as promises; internal build detail
and unedited generated text erode trust and look unprofessional.
