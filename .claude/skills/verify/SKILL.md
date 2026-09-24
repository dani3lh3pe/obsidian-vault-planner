---
name: verify
description: Verify procedure for the Vault Planner plugin — run after any code change and before handing a build to Daniel. Runs the deterministic gate (tsc, vitest under TZ=UTC, production build, package) and produces release/vault-planner.zip with a fresh build id. Use when asked to verify, before a commit, or when a build should be tested on the Windows notebook.
---

# Verify

```bash
bash scripts/verify.sh
```

Exit 0 = green, exit 2 = red with the failing output. It runs, in order:

1. `npx tsc --noEmit` — strict types are the only lint.
2. `npm test` — vitest with `TZ=UTC`; a guard test fails if the zone is not UTC.
3. `node esbuild.config.mjs production` — the bundle Obsidian loads.
4. `node scripts/package.mjs` — `release/vault-planner.zip` (plugin) and `release/test-vault.zip`.

The same script is the `Stop` hook (`--hook`): it skips when `git status` is clean and never blocks
twice in a row.

## Handing a build over

After a green run, tell Daniel the build id the script printed (`0.1.0-dev.<timestamp>`) and the
path `release/vault-planner.zip`. He downloads it, unpacks it into
`<Testvault>/.obsidian/plugins/`, toggles the plugin off and on, and checks the id under
Settings → Community plugins. The test vault itself (`release/test-vault.zip`) is downloaded once.

When the change touched Graph writes, vault writes or sign-in, list the manual checks from the
milestone's table in `docs/umsetzungsplan.md` that this change needs — and what each one proves.

## Out of scope

- **Running the plugin.** Obsidian runs on the Windows notebook only; verify proves the bundle
  builds and the pure logic holds, nothing about the running view.
- **Anything touching the tenant.** No sign-in, no Graph call, no event created "to check".
- `/ponytail-review` and `/code-review` are judgement passes on the finished diff, not part of
  this gate.
