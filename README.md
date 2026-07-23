<div align="center">

# 🛡️ Sentinel

### Crime Intelligence & Case-Management Platform for Karnataka State Police

Sentinel unifies crime analytics, an AI assistant, digital investigation case files, and
governance into a single platform — built natively on the **CCTNS / BNSS** framework and
running end-to-end on **Zoho Catalyst**.

</div>

---

## Live Demo & Judge Login

**Live app:** <https://sentinel-60073599957.development.catalystserverless.in/app/index.html>

Sign in with the shared evaluation account below. It has full **Admin** access, so every
feature — including the **Access & Audit** console and role management — is visible:

| Field | Value |
| --- | --- |
| **Email** | `deepujohn.t01@gmail.com` |
| **Password** | `Zohohack2026!` |

---

## Table of Contents

1. [Live Demo & Judge Login](#live-demo--judge-login)
2. [Overview](#overview)
3. [Key Features](#key-features)
4. [Architecture](#architecture)
5. [Tech Stack](#tech-stack)
6. [Repository Structure](#repository-structure)
7. [Prerequisites](#prerequisites)
8. [Setup & Installation](#setup--installation)
9. [Running Locally](#running-locally)
10. [Build & Deploy](#build--deploy)
11. [Roles & Access](#roles--access)
12. [Security & Compliance](#security--compliance)
13. [Project Scripts](#project-scripts)
14. [Troubleshooting](#troubleshooting)
15. [Disclaimer](#disclaimer)

---

## Overview

Police forces sit on vast volumes of data and paperwork that stay locked and hard to use —
hard to query, slow to investigate, impossible to predict from, and weakly audited. Sentinel
unlocks it end to end:

- **Data → insight** — FIR data becomes queryable in plain language and visible as trends, maps, and risk boards.
- **Paper → digital investigation** — a full digital Case Diary (BNSS S.172) with live voice-to-text and OCR testimony capture.
- **Reactive → proactive** — forecasting, district-risk scoring, and cross-case link detection.
- **Weak oversight → accountability** — rank-based access control and a tamper-evident audit trail.

It runs on a realistic **synthetic** Karnataka FIR dataset (26-table CCTNS-aligned schema), with
production use explicitly gated behind legal sign-off.

---

## Key Features

| Module | What it does |
| --- | --- |
| **Home Dashboard** | Live FIR analytics — trends, composition, lifecycle funnels, workload metrics, interactive Karnataka geo-heatmaps with flexible filters. |
| **Crime Map** | State → district → station drill-down with hotspots and one-tap officer call links. |
| **AI Assistant** | Plain-language querying routed to the live database, a legal knowledge base, or casual chat — with conversation memory, voice input, document reading, and chart/table/map replies. |
| **AI Analytics** | Crime forecasting (with confidence bands), district-risk & recidivism scoring, cross-case link and co-offending network graphs, anomaly detection — cited and guardrail-bound. |
| **Investigation Diary** | Digital BNSS S.172 Case Diary mapped to CCTNS IIF1–IIF5: diary entries, S.161 statements, evidence with chain-of-custody, persons, timeline, findings. Testimony capture by **voice-to-text** or **scan OCR**, playable evidence, AI cited case summaries, and full PDF export. |
| **Personnel** | Officer directory, weekly duty roster, per-district organisation chart. |
| **Case Files** | Direct browse and filter of the underlying FIR records. |
| **Access & Audit** | Rank-based role access + a tamper-evident, CSV/XLSX-exportable audit trail of every action. |

---

## Architecture

The frontend reads the Data Store **directly** from the browser via ZCQL for dashboards, maps,
and record browsing. Everything that **writes, uses AI, handles media, or renders PDFs** goes
through a single serverless function (`rag`) that holds all credentials server-side and enforces
role + audit checks.

```
Browser (React SPA)  ──ZCQL read──►  Catalyst Data Store (FIR schema)
        │
        └──HTTPS /server/rag/*──►  rag function (Node.js, Advanced I/O)
                                        ├─► Data Store (ZCQL, admin)
                                        ├─► Stratus (diary, media, audit, profiles)
                                        ├─► Zia (OCR, Speech-to-Text)
                                        ├─► SmartBrowz (HTML → PDF)
                                        ├─► QuickML (RAG retrieval)
                                        └─► Groq LLM API (routing, chat, summaries)
```

> Full PlantUML component, use-case, and wireframe diagrams live in [`docs/`](docs/).

---

## Tech Stack

**Frontend** — React + React Router (TypeScript/JS), lucide-react, d3-geo + topojson (maps),
SheetJS/`xlsx` (exports), jsPDF + html2canvas (client PDF), i18next, Web Speech / MediaRecorder APIs.

**Backend** — Node.js 20 (Catalyst Advanced I/O function), `zcatalyst-sdk-node`, Groq LLM API,
OAuth 2.0 (refresh-token flow), `form-data`.

**Zoho Catalyst services** — Web Hosting, Data Store (ZCQL), Stratus (object storage),
Functions, Authentication / User Management, Zia (OCR + STT), SmartBrowz (HTML→PDF), QuickML (RAG).

**Data tooling** — Python (Pandas, Pillow, NumPy) for dataset generation and seeding.

---

## Repository Structure

```
sentinel/
├── catalyst.json              # Catalyst project config (client + functions targets)
├── react-app/                 # React single-page app  (deployed to Web Hosting, served at /app)
│   ├── src/
│   │   ├── pages/             # Feature screens (Reports, CrimeMap, Assistant, InvestigationDiary…)
│   │   ├── components/        # Charts, maps, sidebar, renderers…
│   │   ├── context/           # AuthContext, AccessContext (RBAC)
│   │   └── utils/             # datastore (ZCQL), investigation, access, audit, reportPdf…
│   └── package.json
├── functions/
│   └── rag/                   # Node.js Advanced I/O function (the entire backend)
│       ├── index.js           # All endpoints: assistant, diary, media, OCR, audit, PDF…
│       ├── zcql.js            # text→ZCQL router + row enrichment
│       ├── masters.json       # snapshot of master tables for enrichment
│       └── catalyst-config.template.json   # env-var template (copy → catalyst-config.json)
├── ksp/                       # Synthetic Karnataka FIR dataset + generators + import configs
│   └── fir/import/            # CSVs and ds:import configs for the 26-table schema
├── scripts/
│   └── rotate-rag-token.sh    # renews the OAuth refresh token
└── docs/                      # Architecture / use-case / wireframe diagrams
```

---

## Prerequisites

- **Node.js 18+** and npm (the function targets the Node 20 runtime)
- A **Zoho Catalyst** account → <https://catalyst.zoho.in>
- **Catalyst CLI** — `npm install -g zcatalyst-cli`
- A **Zoho Self-Client** (for the OAuth refresh token) → <https://api-console.zoho.in>
- A **Groq API key** → <https://console.groq.com>

---

## Setup & Installation

### 1. Clone and link the Catalyst project

```bash
git clone <your-repo-url> sentinel
cd sentinel
catalyst login
# Associate this directory with YOUR Catalyst project:
catalyst init          # choose "Associate project", pick your project (keep client + functions)
```

### 2. Install dependencies

```bash
# Frontend
cd react-app && npm install && cd ..

# Backend function
cd functions/rag && npm install && cd ../..
```

### 3. Configure backend secrets

Copy the template and fill in your values (keep real secrets **out of version control**):

```bash
cp functions/rag/catalyst-config.template.json functions/rag/catalyst-config.json
```

| Variable | Where it comes from |
| --- | --- |
| `RAG_CLIENT_ID` / `RAG_CLIENT_SECRET` | Zoho Self-Client (api-console.zoho.in) |
| `RAG_REFRESH_TOKEN` | OAuth refresh token — generate once, then `scripts/rotate-rag-token.sh` renews it |
| `RAG_ORG` | Your Catalyst organisation ID |
| `GROQ_API_KEY` | console.groq.com |

The refresh token needs scopes for **QuickML, Data Store, Stratus, Zia, SmartBrowz, and User Management**.

### 4. Create the Stratus bucket

In the Catalyst console → **Stratus**, create a bucket named **`accused`** (or set a `CONV_BUCKET`
env var to your bucket name). Under **Bucket Permissions**, allow authenticated users at minimum:

```json
"allowed_actions": ["GetObject", "PutObject"]
```

> This is required — investigation records, evidence, audit logs, and profiles are all stored here.
> Without `PutObject`, saving fails with "request denied by resource access policy".

### 5. Load the FIR dataset (Data Store)

Pre-create the 26 tables in the Catalyst **Data Store**, then import the CSVs from `ksp/fir/import/`.
Tables must exist before import (Catalyst does not auto-create them). Stage the CSVs in Stratus and
run the provided `ds:import` configs. See [`ksp/README.md`](ksp/README.md) for the full schema and steps.

### 6. Enable Zia & QuickML

In the console, enable **Zia** (OCR + Speech-to-Text) and set up a **QuickML RAG** knowledge base
(upload the docs in `ksp/rag_docs/`), then put its document IDs in `RAG_DOCUMENT_IDS` if you want to
scope retrieval.

---

## Running Locally

```bash
# Frontend UI (backend calls need the deployed function or `catalyst serve`)
cd react-app && npm start          # http://localhost:3000

# Backend function + client together, locally:
catalyst serve                     # serves functions and client for local testing
```

> The app expects to be served at the `/app` base path (`homepage` in package.json). For full
> functionality (AI, diary, audit) the `rag` function must be reachable at `/server/rag/*` —
> use `catalyst serve` or deploy.

---

## Build & Deploy

```bash
# 1. Build the frontend (postbuild copies index.html → 404.html for SPA routing)
cd react-app && npm run build && cd ..

# 2. Deploy everything (client + functions) to Catalyst
catalyst deploy

# Deploy selectively:
catalyst deploy --only client
catalyst deploy --only functions
```

After deploy, the app is live at:

```
https://<project>-<org>.development.catalystserverless.in/app/index.html
```

> **Tip:** `catalyst deploy` can occasionally hang; if a deploy times out, re-run it and verify the
> live bundle updated (curl the index and check the `main.<hash>.js` name changed).

---

## Roles & Access

Access is tied to the **KSP rank hierarchy**. Roles are assigned by an admin on the **Access & Audit**
page; the `admin` role comes from the Catalyst "App Administrator" project role and cannot be self-assigned.

| Role | Typical access |
| --- | --- |
| **Investigator** | Crime map, incidents, case files, investigation diary |
| **Analyst** | Crime map, AI analytics, assistant |
| **Supervisor** | Broad operational access (above + personnel & roster) |
| **Policymaker** | Analytics, personnel, org chart |
| **Admin** | Everything + role assignment + audit trail |

The feature→role matrix lives in [`react-app/src/utils/access.js`](react-app/src/utils/access.js).

---

## Security & Compliance

- **Credentials stay server-side** — the browser never sees API keys; all AI/media/PDF calls proxy through the `rag` function.
- **Role-based access** enforced on both the sidebar (hides) and routes (blocks), verified server-side from the session.
- **Audit trail** — every feature view, edit, sign-in, denial, and export is logged with user, role, IP, location, and IST timestamp; exportable to CSV/XLSX.
- **AI guardrails** — outputs are advisory and cited; protected attributes (religion, caste, gender) are excluded from risk models; human-in-the-loop throughout.
- Aligns with **DPDP Act / Puttaswamy** need-to-know, proportionality, and accountability principles.

---

## Project Scripts

| Command | Location | Purpose |
| --- | --- | --- |
| `npm start` | `react-app/` | Local dev server |
| `npm run build` | `react-app/` | Production build (+ SPA 404 fallback) |
| `npm run serve:prod` | `react-app/` | Serve the built bundle locally |
| `catalyst serve` | root | Run functions + client locally |
| `catalyst deploy` | root | Deploy build output to Catalyst |
| `scripts/rotate-rag-token.sh` | root | Renew the OAuth refresh token |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **"request denied by resource access policy"** on save | Add `PutObject` to the `accused` bucket's authenticated-user permissions. |
| **Hard-refresh shows a Catalyst 404** | Ensure `npm run build` ran (postbuild copies `index.html → 404.html` for SPA routes). |
| **OCR: "wrong request body or parameters"** | The function must stage the image to a temp file and pass Zia a file stream (not a raw buffer). |
| **Deploy hangs / times out** | Re-run `catalyst deploy`; verify the live `main.<hash>.js` changed. |
| **Assistant returns 500** | Check `functions/rag/catalyst-config.json` env vars are set and the refresh token is valid. |
| **Data Store import fails** | Tables must be pre-created; CSVs must be staged in Stratus (no leading-slash keys). |

---

## Disclaimer

Sentinel runs on a **synthetic** dataset for demonstration and evaluation. It is a decision-support
tool — every AI output is advisory and must be verified by an officer. **Production deployment with
real citizen data requires legal sign-off** (DPDP Act, evidence-handling, and departmental approval).

<div align="center">

Built for the Karnataka State Police · on the CCTNS / BNSS framework · powered by Zoho Catalyst.

</div>
