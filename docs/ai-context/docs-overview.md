# Documentation overview

Back to @CLAUDE.md · File tree: @docs/ai-context/project-structure.md

## Tiers

| Tier | File | Covers |
|------|------|--------|
| 1 | `CLAUDE.md` | What the project is, commands, architecture, security rules, conventions |
| 1 | `docs/ai-context/project-structure.md` | Tech stack, file tree, routing, D1 tables |
| 1 | `docs/ai-context/docs-overview.md` | This map |
| 2 | `src/CONTEXT.md` | The Worker: API methods, auth, storage, how to add a method |
| 2 | `public/js/CONTEXT.md` | Browser modules: generation pipeline, pages, sign-in |
| — | `README.md` | User guide: using the generator, how the art works, API reference, deploying |

There are no Tier 3 (feature) folders: the code is two flat directories.

## Where to look for…

| Topic | Read |
|-------|------|
| API methods, params, return values | `README.md` → *API*, and `src/spec.js` (the served spec) |
| Who may call what | `METHODS` in `src/worker.js`; summary in `src/CONTEXT.md` |
| Author-token isolation rules | `CLAUDE.md` → *Rules that must hold* |
| How the logo becomes the pattern | `README.md` → *How the logo gets into the pattern*; headers of `art.js`, `fragment.js` |
| Scan-reliability scoring | `README.md` → *Testing scan reliability*; `verify.js` |
| Short links and scan stats | `README.md` → *Short links*; `src/CONTEXT.md` → *Scans* |
| Using codes from another project | `README.md` → *Using codes from other projects* |
| Deploying | `README.md` → *Deploy to Cloudflare*; `deploy.cmd` |
| Known limits | `README.md` → *Limitations* |

## Keeping docs in step

When an API method changes, update the handler (`worker.js`), its spec entry (`spec.js`), the
README API table, and a test in `test/worker.test.mjs`. Update `src/CONTEXT.md` if roles,
tables or invariants change, and `project-structure.md` if files are added or removed.
