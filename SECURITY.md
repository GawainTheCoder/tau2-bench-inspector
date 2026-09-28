# Security policy for this fork

This repository contains a local evaluation viewer layered onto Tau2. The
benchmark code is public, but credentials, simulation artifacts, provider
payloads, and workstation-generated files are not publication-safe by default.

## Secrets

- Put provider credentials only in `.env` or the process environment.
- Never put an API key in a command, test fixture, screenshot, result annotation,
  issue, commit message, or documentation example.
- `.env` and `.env.*` are ignored; `.env.example` is the only allowed exception
  and must contain placeholders, never usable credentials.
- Private keys and common certificate bundles (`*.key`, `*.pem`, `*.p12`, and
  `*.pfx`) are ignored as a final defensive measure.
- If a secret is ever committed, rotate it immediately. Removing it from the
  current tree is not sufficient because it remains in Git history.

## Simulation and fixture data

`data/simulations/` is ignored. Saved runs can include:

- complete conversations and hidden user-simulator instructions;
- tool arguments and realistic fixture records;
- provider request or response metadata and session identifiers;
- costs, usage, timestamps, evaluator outputs, and failure details.

Do not publish raw results without a deliberate data review. The committed
`viewer/workbench_annotations.json` contains derived reviewer judgments for the
named 50-run cohort, not raw provider payloads or credentials.

## Local viewer threat model

Tau2 Inspector is a local research tool, not an authenticated web service.

- It binds to `127.0.0.1` by default.
- A non-loopback host is rejected unless `--allow-network` is explicitly set.
- Do not expose it to a shared network or the public internet. The flag is an
  acknowledgement, not an authentication or authorization mechanism.
- HTTP responses disable caching and include a restrictive Content Security
  Policy, same-origin resource policy, clickjacking protection, MIME sniffing
  protection, no-referrer behavior, and a restrictive permissions policy.
- Dynamic benchmark content is treated as untrusted data. Client rendering must
  continue to escape keys, values, text, and raw JSON before inserting HTML.
- Raw-result endpoints are intentionally available to the local browser. They
  are another reason the server must remain loopback-only.

## OpenAI transport

The fork routes `gpt-5.4-mini` and `gpt-5.6-luna` through LiteLLM's Responses API
adapter and sets `store=false` unless explicitly overridden. This controls API
response storage behavior but does not replace the operator's organization-level
logging, retention, or access policies.

The repository does not use the OpenAI Agents SDK and does not generate Agents
SDK traces. Inspect OpenAI Responses API request logs for these models.

## Safe publication checklist

Before every push:

1. Inspect `git status`, the staged diff, and the exact staged file list.
2. Stage named paths only; never stage the whole working tree blindly.
3. Confirm `.env`, `data/simulations/`, `.playwright-cli/`, `output/`, caches,
   logs, and raw provider files are absent from the index.
4. Run a secret scan over the staged blobs and commit history being introduced.
5. Run the relevant Python and JavaScript tests.
6. Verify the target repository, visibility, branch, and remotes before pushing.
7. After pushing, inspect the remote file tree and GitHub secret-scanning status.

## Dependency and supply-chain discipline

- Use `uv run --frozen` for reproducible local verification.
- Do not commit lockfile rewrites caused only by a different `uv` serialization
  format.
- Review dependency additions separately from application changes.
- This viewer has no npm dependency installation or browser CDN dependency.

## Reporting a vulnerability

Keep unpublished evaluation analysis out of commits and review derived results
before publishing them.
Report a suspected credential or data exposure privately to the repository owner;
do not open a public issue containing secrets or raw trajectories.
