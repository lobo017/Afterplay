# Working rules for this repo

- docs/SPEC.md is the source of truth. Read it at the start of every task.
- Track progress in docs/PROGRESS.md: phase status, decisions, deviations from the spec
  (with reasons), known issues, and measured performance numbers.
- Work one phase at a time. Before writing code, add a short plan to PROGRESS.md (files to
  add or change, risks).
- A phase is done only when all of these pass, run by you:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - the phase's end-to-end tests

  Fix failures yourself. Never report done otherwise.
- Commit at the end of every phase as "Phase N: <summary>". Smaller commits within a phase
  are fine.
- No placeholder code, no TODO-stubbed features, and no buttons that do nothing. If
  something can't be done, write that in PROGRESS.md.
- Never break earlier phases. All earlier end-to-end tests must keep passing.
- The website makes zero runtime network requests. The only exception is the capture
  extension in extension/ (Phase 5b), which may access lichess.org, www.chess.com, and
  api.chess.com. Network access is also allowed in dev-time scripts under scripts/
  (e.g. dataset downloads). If your sandbox blocks a download, write the script and tell
  me the command to run.
- Ask me before: adding a dependency not named in the spec, deleting or weakening tests,
  changing the license, or doing anything destructive outside this repo.
- legacy/index.html is the old 3D app. Use it as reference only (port the audio synth and
  visual theme ideas); don't import it.
- After a UI change, take Playwright screenshots and look at them yourself before calling
  the work done.
- Run every command non-interactively and with a timeout. Never use npx for a package that isn't in package.json, since it can stall on an install prompt; ask me to add the dependency instead.