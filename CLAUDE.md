# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Sentinel is a crime intelligence and case-management platform for the Karnataka State Police, built on Zoho Catalyst. A React SPA talks to exactly one serverless function.

## Commands

The `catalyst` CLI is installed under **node v20.20.2**, not the default node 22, so it is not on PATH by default. Prepend that bin directory so the CLI finds its own node:

```bash
PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" catalyst serve --http 3000
```

`catalyst serve` without node 20 present silently skips the function and serves only the client — check the log for "skipping serve of function [rag]".

| Task | Command |
|---|---|
| Run everything locally | `catalyst serve --http 3000` → client at `/app/`, function at `/server/rag/` |
| Build the client | `cd react-app && npm run build` |
| Backend tests | `cd functions/rag && npm test` |
| One backend test | `node functions/rag/guard.test.js` |
| Frontend tests | `cd react-app && CI=true npm test -- --watchAll=false` |
| One frontend test | `cd react-app && CI=true npm test -- --watchAll=false src/__smoke__/link.test.js` |
| Lint (what CI enforces) | `cd react-app && npx eslint src --ext .js --ignore-pattern '__smoke__'` |
| Accessibility gate | `node scripts/a11y-check.test.js && node scripts/a11y-check.js` |
| Assistant benchmark | `node functions/rag/bench/run.js` |
| Regenerate the dataset | `cd ksp/fir && python3 generate_fir_dataset.py && python3 generate_accused_network.py && python3 enrich_personnel.py` |

Always build with `npm run build`, never `npx react-scripts build`: the `postbuild` step copies `build/index.html → build/404.html`, which is the SPA fallback Catalyst serves for client routes. Without it a hard refresh on any route shows Catalyst's 404 page. (Client routes returning HTTP 404 with the SPA as the body is normal and works.)

`npm install` in `react-app` needs `--legacy-peer-deps` — react-scripts 5 pins typescript ^3||^4 against the installed 5.x.

## Deployment

`git push origin main` is the deploy. `.github/workflows/ci.yml` runs tests, lint, the a11y gate and the production build, then a separate `deploy` job pushes to the **Development** environment when `verify` is green. Pull requests build and test but never deploy.

CI verifies the deploy actually landed rather than trusting it: it greps the live bundle, asserts `GROQ_API_KEY` survived, and checks the API still rejects anonymous callers.

Deploying the function with an `env_variables` map in `functions/rag/catalyst-config.json` **overwrites** whatever is set in the Catalyst console. That has silently wiped provider keys before, which is why the post-deploy assertion exists.

## Architecture

### One function, one gate

The entire backend is `functions/rag/index.js` (~6k lines) plus sibling modules it requires. It is a Catalyst **advancedio** function: a single exported `async (req, res)` handler that dispatches on `path.endsWith('/some/route')`. There is no Express app and no router library.

Request order in that handler matters and is load-bearing:

1. `POST` only — anything else is 405.
2. `/health` — **the only route ahead of the gates**. Reports whether config is present (booleans, never values); CI asserts against it.
3. `originAllowed()` — CSRF gate. A request carrying an `Origin` must carry one of ours; a request with none passes to the session gate (curl/CI omit it, and browsers cannot suppress it).
4. `ipBlocked()` — denylist from `BLOCKED_IPS`.
5. `requireSession()` — identity comes from the Catalyst session cookie, **never** from the request body. This is at the router, not in handlers, so a new endpoint is authenticated by default.
6. Rate limit — per officer per minute, stricter for `METERED_ROUTES` (LLM, transcription, OCR, PDF).
7. Route dispatch.

When adding an endpoint, add it after the gate and it inherits all of the above. `apigate.test.js` asserts this ordering and fails if a route is ever added ahead of it.

### Where state actually lives

Two stores, and the split is not obvious:

- **Data Store (ZCQL)** holds the 26-table synthetic FIR schema — `CaseMaster`, `Accused`, `Employee`, etc. Read-only in practice.
- **Stratus** (object storage, bucket from `CONV_BUCKET`) holds nearly all app state as JSON blobs: roles (`access/roles.json`), the audit trail (`audit/logs/<day>/`), investigation diaries, digitised records, Report Studio documents, shares. Most features are blob reads/writes, not SQL.

Routes that accept an object key from the client pass it through `confineKey(key, prefix)` — prefix confinement plus traversal/control-character rejection. Never use a bare `startsWith`.

### Assistant lanes

`index.js` routes a question to one of several lanes, decided by an LLM classifier with a keyword fallback:

- **ZCQL** — `zcql.js` turns text into a query. **Single-table only; no JOINs.** Cross-table facts are assembled in code afterwards using `masters.json` for id→name enrichment and district rollup. The validator (`validator.test.js`) masks string literals, denies non-SELECT keywords, enforces one table, and clamps `LIMIT`; it sits outside the model's reach.
- **RAG** — QuickML knowledge base retrieval.
- **TOOLS** — a bounded tool-calling loop on Claude, with clearance-filtered tools; falls through to the older lanes on failure.

Provider chain is `PROVIDER_ORDER` (Groq, then Claude). Groq retired the llama models; current ones are `gpt-oss-120b` and `qwen3.6-27b`, which emit reasoning tokens that `callGroq` has to strip.

### The safety modules

These are the ones worth reading before touching answer generation:

- `guard.js` — prompt-injection defence. The threat model is **indirect** injection (attachments, OCR, seized documents), not officers typing jailbreaks. Retrieved content is wrapped in a per-request random nonce fence so a hostile document cannot close the fence and impersonate the system.
- `redaction.js` / clearance filtering — happens **before** rows reach the prompt, so the model is never shown what it may not reveal. This is the primary control; the guard is defence in depth.
- `grounding.js` — did the answer stay inside what was read.
- `sources.js` — the unified `sources` contract and single response exit (`respondWith`).
- `integrity.js` — tamper-evidence for the audit trail (per-day seals).
- `assurance.js` — runtime self-test proving the controls are live in the deployed environment, surfaced at `/assurance`.

### Frontend

Create React App 5, JavaScript with some TypeScript, `react-router-dom` 7, Leaflet for mapping, i18n in three languages (English, Kannada, Hindi). Pages under `src/pages/`, shared logic in `src/utils/`.

`src/data/hierarchyStore.js` loads map data from a Stratus bucket **as executable ES modules** at runtime via `import(/* webpackIgnore: true */ url)`. Anything with write access to that bucket runs JavaScript in every officer's browser — keep its write permissions closed, and do not reintroduce `new Function`, which would force `unsafe-eval` into the CSP.

The CSP lives in `react-app/public/index.html`. The build emits no inline script, so `script-src` is a real allowlist with no `unsafe-eval` and no hashes. Adding either would undo the only load-bearing line in that file.

## Testing conventions

The backend uses **no test framework**. Each `*.test.js` is a plain node script with a local `check(name, cond)` helper that prints `ok`/`FAIL` and exits non-zero on failure; `npm test` loops over them. Add a new suite by dropping in a `*.test.js` file — it is picked up automatically.

Several suites read `index.js` as text and evaluate a fragment with `new Function` to exercise the real implementation rather than asserting on how the source reads. Follow that pattern instead of regex-matching source: a guard tested by regex is a guard that passes while doing nothing.

## Local development gotchas

`catalyst serve` has **no standalone data plane**. Data Store and Stratus calls from Local proxy to and mutate **real Development data**. Serving is safe for testing function logic; it is not safe for testing destructive data operations.

Local serve has no signed-in session, so authenticated UI paths (map imagery, Records upload, evidence playback) will sit at "Checking access…" until you sign in through the browser.

`catalyst deploy` is flaky — it sometimes hangs, and at the end of long `&&` chains it can silently no-op while the chain reports success. Prefer pushing to main and letting CI deploy; if deploying by hand, verify by fetching `/app/index.html`, extracting the `static/js/main.*.js` bundle name, and grepping the live bundle for a string unique to the new code.

## Data

CSVs under `ksp/` are gitignored — the Python generators are the tracked source of truth, and CI regenerates the dataset on the runner. `ksp/fir/Section.csv` is the deliberate exception (35 rows of reference data that `legal.test.js` asserts against).

`Accused.PersonID` is a **global** offender id across FIRs, which is what makes the co-offending network and case-linkage features work.

Data Store has no CLI delete; resetting a table has historically required a temporary function endpoint. `ds:import` needs CSVs staged in Stratus and prompts interactively for a bucket unless given `--config`.

## Design system
Use @DESIGN-linear.app.md as the source of truth for all UI and visual design work.
When creating or modifying interfaces:
- follow existing tokens and component patterns
- preserve the visual principles described in DESIGN.md
- reuse existing patterns before introducing new ones
- flag intentional deviations
