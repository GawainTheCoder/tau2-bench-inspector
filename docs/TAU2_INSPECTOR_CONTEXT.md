# Tau2 Inspector: project context and evaluation record

Last updated: 2026-08-20

This document is the durable context for the `tau2-bench-inspector` fork. It
records what was changed, what was measured, how the current conclusions were
formed, what remains canonical Tau2 behavior, and what future agents must not
silently conflate.

## 1. Repository identity and provenance

- Upstream: `sierra-research/tau2-bench`
- Upstream baseline: `a2c024725189473d2d7cea3a5cfdbcc67478e41f`
- Current default branch: `main`
- Domain used for the current investigation: `airline`
- Python: 3.12.5
- Local `uv` used for verification: 0.6.8
- Canonical airline catalog in this baseline: 50 tasks and 14 runtime tools

The upstream task definitions, policy, database fixtures, and evaluator targets
were not edited for the reported 50-task run. That boundary matters: the 31/50
score is comparable to the selected upstream task set at the recorded commit.

The upstream default agent and user models in `src/tau2/config.py` remain
`gpt-4.1-2025-04-14`. For this investigation, “default model” means the chosen
run convention and the cohort selected by the Inspector: `gpt-5.4-mini` with
Responses API transport and medium reasoning for the agent. We intentionally did
not rewrite Tau2's global defaults.

## 2. Objective and scope evolution

The work began as a strict setup task: clone current Tau2, follow the README,
configure an ignored `.env`, verify Python and `uv`, run `tau2 intro`, run tests,
understand saved results, and manually inspect one airline task.

The investigation then expanded in deliberate stages:

1. Determine which models and API surfaces Tau2 actually uses.
2. Test `gpt-5.6-luna`, diagnose its reasoning/tool-call incompatibility on Chat
   Completions, and add a narrow Responses API transport.
3. Adopt `gpt-5.4-mini` as the working evaluation model while retaining
   `gpt-4.1` as a comparison.
4. Run individual and small task cohorts, especially repeated Task 3 trials.
5. Build a local browser-based Inspector for tasks, policy, databases, tools,
   conversations, tool trajectories, rewards, and saved results.
6. Add structured/raw tool-result rendering, dark mode, task filtering, and live
   refresh.
7. Run all 50 airline tasks once with `gpt-5.4-mini`, Responses API, and medium
   reasoning.
8. Build an Evaluation Workbench for all failed tasks and for inefficient or
   brittle successful trajectories.

The project has not built an automated “root-cause” classifier. The Workbench
stores evidence-backed reviewer descriptions of what happened and keeps those
descriptions separate from official Tau2 rewards.

## 3. OpenAI API and model routing

### Original behavior

Tau2's generic LLM utility called LiteLLM's Chat Completions-compatible
`completion()` path. `gpt-4.1` worked through that transport.

The first `gpt-5.6-luna` reasoning/tool run ended as an infrastructure error:

> Function tools with reasoning_effort are not supported for gpt-5.6-luna in
> /v1/chat/completions. To use function tools, use /v1/responses or set
> reasoning_effort to 'none'.

This was not a provider-agnostic abstraction failure in the general sense. The
model, endpoint, reasoning option, and function-tool combination was invalid on
the selected Chat Completions transport. Provider abstraction does not guarantee
that every provider or model supports every transport-level feature combination.

### Implemented transport

`src/tau2/utils/llm_utils.py` now routes only these model names through
`litellm.responses(...)`:

- `gpt-5.4-mini`
- `gpt-5.6-luna`

The adapter:

- converts Tau2 user, system, assistant, function-call, and function-output
  messages into Responses API input items;
- converts Chat Completions-style tool schemas into Responses function tools;
- maps `reasoning_effort` into the Responses `reasoning` object;
- omits temperature when reasoning is active;
- maps `max_tokens` to `max_output_tokens` when needed;
- defaults `store` to `false`;
- reconstructs Tau2 `AssistantMessage` content, tool calls, raw response data,
  usage, cost, and timing from the Responses result.

All other models retain the upstream Chat Completions path. The implementation
does not use the OpenAI Agents SDK. Therefore:

- inspect Responses API logs for `gpt-5.4-mini` and `gpt-5.6-luna` runs;
- inspect Chat Completions logs for `gpt-4.1` runs;
- do not expect Agents SDK traces for any of these runs.

Focused unit tests cover Responses input conversion, tool schema conversion,
reasoning/temperature handling, tool-call reconstruction, usage, cost, raw data,
and preservation of the existing Chat Completions path.

## 4. Saved experiment record

Raw saved results remain local under `data/simulations/` and are intentionally
gitignored. The following summary was extracted from the current local artifacts
before publication:

| Cohort | Model/configuration | Evaluated | Passed | Purpose |
|---|---:|---:|---:|---|
| `manual_airline_one` | gpt-4.1 | 1 | 1 | Initial working baseline |
| `manual_airline_one_gpt_5_6_luna` | gpt-5.6-luna reasoning on Chat Completions | 0 | 0 | Infrastructure-error reproduction |
| `manual_airline_one_gpt_5_6_luna_none` | gpt-5.6-luna, reasoning none | 1 | 0 | Endpoint-compatible behavior check |
| `manual_airline_one_gpt_5_6_luna_responses_medium*` | gpt-5.6-luna, Responses medium | 2 | 2 | Responses smoke and confirmation |
| `manual_airline_task_1_gpt_5_4_mini` | gpt-5.4-mini | 1 | 1 | First mini task check |
| `manual_airline_tasks_2_6_gpt_5_4_mini` | gpt-5.4-mini | 5 | 4 | Next-five task cohort |
| `manual_airline_task_3_gpt_4_1` | gpt-4.1 | 1 | 1 | Task 3 comparison |
| `manual_airline_task_3_gpt_5_6_luna_medium` | gpt-5.6-luna medium | 1 | 1 | Task 3 comparison |
| `manual_airline_task_3_gpt_5_4_mini_two_more` | gpt-5.4-mini | 2 | 1 | Additional stochastic evidence |
| `airline_task_3_gpt_5_4_mini_none_responses` | gpt-5.4-mini Responses none | 5 | 3 | Reasoning-effort comparison |
| `airline_task_3_gpt_5_4_mini_medium` | gpt-5.4-mini Responses medium | 5 | 5 | Reasoning-effort comparison |
| `airline_all_50_gpt_5_4_mini_medium_responses` | gpt-5.4-mini Responses medium | 50 | 31 | Full canonical airline cohort |

These small samples are diagnostic, not leaderboards. In particular, a 5/5
Task 3 result does not establish broad superiority, and the 50-task run has one
trial per task rather than repeated estimates of per-task pass probability.

## 5. Reproducing the documented full run

Create `.env` from the example and place the OpenAI API key only in `.env`:

```bash
cp .env.example .env
uv sync
uv run tau2 intro
```

The reproducible command matching the saved cohort metadata is:

```bash
uv run tau2 run \
  --domain airline \
  --agent-llm gpt-5.4-mini \
  --agent-llm-args '{"reasoning_effort":"medium"}' \
  --user-llm gpt-5.4-mini \
  --user-llm-args '{"temperature":0.0}' \
  --num-trials 1 \
  --seed 300 \
  --save-to airline_all_50_gpt_5_4_mini_medium_responses
```

No `--task-ids` filter means all 50 base airline tasks. Tau2 saves the result to
`data/simulations/airline_all_50_gpt_5_4_mini_medium_responses/results.json`.

The stored artifact records:

- upstream git commit `a2c024725189473d2d7cea3a5cfdbcc67478e41f`;
- agent model `gpt-5.4-mini` and reasoning effort `medium`;
- user model `gpt-5.4-mini` and temperature `0.0`;
- one trial, seed 300, 200 maximum steps, and 10 maximum consecutive errors;
- 50 completed and evaluated simulations with no infrastructure errors.

## 6. Official outcome and reviewer layer

### Official Tau2 outcome

- Total: 50
- Passed: 31
- Failed: 19
- Success rate: 62%
- Every failed run had DB reward 0.
- Fifteen failures still had COMMUNICATE reward 1.
- Tasks 7, 11, 14, and 23 failed both DB and COMMUNICATE.

The official reward describes whether the configured evaluator target passed. It
does not establish that the trajectory was efficient, robust, or the only valid
way to serve the user.

### Provisional failed-run taxonomy

| Code | Observed mechanism | Count | Tasks |
|---|---|---:|---|
| A | Missing prerequisite information | 2 | 20, 35 |
| B | Policy/eligibility reasoning error | 1 | 39 |
| C | Premature mutation | 1 | 12 |
| D | Wrong mutation/tool arguments | 5 | 10, 14, 21, 22, 25 |
| E | Required confirmation missing | 1 | 24 |
| F | Workflow abandoned before completion | 1 | 7 |
| G | Correct state change, wrong communication | 0 | — |
| H | Unnecessary/escalated path | 6 | 11, 17, 23, 29, 32, 37 |
| I | Other or unclear | 2 | 42, 44 |

This is a review taxonomy, not a causal model. The complete per-task mechanisms,
evidence, write arguments, confirmation state, and prerequisite state live in
`viewer/workbench_annotations.json` and are joined to saved trajectories at
runtime.

The main observed failure patterns were:

- unnecessary transfers while a supported task path remained available;
- incorrect flight, payment, payment-split, or mutation arguments;
- retrieved facts not being retained or reused;
- one intent being dropped in a multi-intent conversation;
- mutation before price or eligibility facts were established;
- confirmation applying to different terms than the eventual write;
- complex itinerary-time or segment-duration relationships being misread.

### Successful-run trajectory review

The 31 official successes were reviewed independently of the reward:

- 18 clean;
- 3 inefficient: Tasks 18, 33, and 41;
- 9 brittle: Tasks 6, 13, 27, 34, 43, 45, 47, 48, and 49;
- 1 inefficient and brittle: Task 15.

These labels are reviewer judgments. They must not be presented as official
Tau2 metrics.

Across the successful runs:

- 146 tool calls total;
- median 4 tools and 16 stored messages;
- median duration 23.22 seconds;
- median cost approximately $0.013446;
- total agent-plus-user cost approximately $0.436421;
- only Task 33 repeated calls with exactly identical names and arguments;
- ten successful runs transferred to a human agent.

Important interpretations:

- Task 4 used 17 tools but was a clean, parallel fan-out success. High tool count
  or repeated tool names alone is not evidence of inefficiency.
- Task 33 repeated the same two flight searches, had the highest successful-run
  cost, and had the longest duration.
- Tasks 18 and 41 performed mostly necessary reads but serialized them across
  many LLM turns instead of batching independent lookups.
- Tasks 15 and 16 form a useful comparison: Task 15 explored a prohibited EWR
  destination branch and used 8 more messages, about $0.0113 more cost, and
  about 12.3 more seconds than Task 16.
- Several official successes transferred prematurely or stopped with incomplete
  service. Official success must not be equated with a clean trajectory.

## 7. Task 7 and benchmark-validity boundaries

Task 7 is intentionally retained as an official failure, but it is not a clean
model-only failure.

The evaluator expected the agent to:

1. inspect `XEHM4B` and `59XX6W`;
2. upgrade and cancel `XEHM4B`;
3. cancel insured `59XX6W` because the hidden scenario says the user is sick;
4. communicate an upcoming-flight total of $1,628.

The agent completed the `XEHM4B` actions, did not cancel `59XX6W`, and reported
$1,332. It later asked for the second reservation's cancellation reason again,
and the run stopped after the user repeated it.

There are also two evaluation ambiguities:

- the hidden scenario says the user is sick, but the simulated user explicitly
  says “change of plan” twice; change of plan is not an insured health reason;
- the expected $1,628 includes the original $296 cost of `XEHM4B`, while the
  agent answered after cancelling it and omitted that amount.

The correct handling is not to rewrite Task 7 and mix it back into the canonical
score. Preserve 31/50, annotate the ambiguity, and use a separately named task
variant for diagnosis. Agent prompt improvements should still be tested against
the untouched canonical task.

## 8. Tau2 Inspector architecture

The Inspector is a dependency-light FastAPI application under `viewer/`:

- `server.py`: read-only API, schema extraction, result discovery, stable run
  keys, raw-detail opt-in, and loopback server entrypoint;
- `workbench.py`: deterministic metric extraction, cohort selection, evidence
  joining, failure records, success metrics, and ranking data;
- `workbench_annotations.json`: human-reviewed failure mechanisms and successful
  path judgments for the named 50-task cohort;
- `static/index.html`, `app.js`, and `styles.css`: single-page browser UI;
- `static/result_utils.mjs`: safe JSON-ish tool-result parsing helpers;
- Python and Node tests with no live API dependency.

The UI exposes:

- all 50 tasks and user scenarios;
- task evaluation actions, required communication, and raw definitions;
- airline policy navigation;
- paginated users, reservations, and flight fixtures;
- 14 runtime-derived tool contracts and mutability labels;
- saved simulations filtered by task and model;
- conversations, structured/raw tool results, tool trajectories, rewards,
  provider metadata, usage, cost, behavior summaries, and raw result opt-in;
- an Evaluation Workbench with failed-task and successful-run tabs;
- evidence drawers and direct drill-through to the exact saved run;
- persistent light/dark mode and responsive layouts;
- automatic refresh when tasks, policy, database, tools, results, or annotations
  change.

The backend supports both Tau2 result representations:

- monolithic `results.json` with embedded simulations;
- directory format with `results.json`, `simulation_index`, and
  `simulations/<uuid>.json`.

Run keys include the stable simulation ID rather than a positional array index.
Directory-format simulations are loaded lazily. Full-duplex tick trajectories
are flattened with stable synthetic turn indexes, and tool results are paired by
requestor plus call ID to avoid agent/user ID collisions.

## 9. Inspector security decisions

- Default host is `127.0.0.1`.
- Non-loopback binding requires `--allow-network` and prints a warning.
- There is no login or authorization layer; do not deploy this server publicly.
- API and static responses use `Cache-Control: no-store`.
- Security headers restrict scripts, resources, framing, referrers, browser
  permissions, cross-origin loading, and MIME sniffing.
- The pre-paint theme bootstrap is an external local script so the CSP does not
  require inline JavaScript.
- Tool output and fixture data are escaped before HTML insertion.
- Recursive structured-result rendering is depth- and item-limited to avoid
  freezing on large or malicious local payloads.
- `.env`, simulations, Playwright state, outputs, private keys, and caches are
  excluded from Git publication.

See `SECURITY.md` for the operating and publication checklist.

## 10. Starting and verifying the Inspector

```bash
uv run --frozen python viewer/server.py
```

It opens `http://127.0.0.1:8005`. To avoid opening the browser automatically:

```bash
uv run --frozen python viewer/server.py --no-open
```

Automated verification:

```bash
uv run --frozen python -m unittest viewer.test_server
uv run --frozen pytest tests/test_llm_utils.py
node --check viewer/static/app.js
node --check viewer/static/result_utils.mjs
node --check viewer/static/theme_bootstrap.js
node --test viewer/test_result_utils.mjs
```

The browser verification covered the 50/19/31 cohort counts, taxonomy filtering,
success ranking, evidence drawers, exact-run drill-through, raw/structured tool
results, dark mode, 390-pixel mobile layout, live-refresh state preservation, and
zero console errors.

The publication-time core suite completed with 235 passing tests, one expected
failure, and two failures in live `gpt-3.5-turbo` behavioral simulations. One
simulation reached `max_steps`; the other did not produce the evaluator payload
that a stochastic assertion expected. Both use the unchanged Chat Completions
path, not the new Responses model branch. The deterministic model-adapter,
Inspector, lint, format, and Node suites pass independently; the two live tests
are recorded rather than repeatedly spending API calls until a favorable sample
appears.

## 11. Known limitations and non-goals

- The Inspector is currently airline-focused.
- It imports Tau2 repository internals and is not yet an independent package.
- Review annotations are human judgments tied to a named result artifact.
- Raw result artifacts are intentionally absent from Git, so a fresh clone must
  run or receive results before the Workbench can recreate the full local view.
- The 50-task result uses one trial per task. It is an outcome census, not a
  robust estimate of each task's stochastic pass probability.
- “Necessary,” “avoidable,” “clean,” and “brittle” remain review judgments.
  Objective metrics and annotations are kept conceptually separate.
- No benchmark task was “fixed,” no custom evaluator was substituted, and no
  macro-analysis model was trained.
- The viewer is not a hosted multi-user product and must not be exposed as one.

## 12. Guidance for future work

1. Keep canonical and diagnostic task sets separate and versioned.
2. Improve workflow control before changing models: maintain active intents,
   reuse retrieved facts, validate eligibility and exact write arguments, tie
   confirmation to the final terms, and reconcile pending intents after writes.
3. Test prompt or orchestration changes on untouched tasks and use held-out or
   repeated trials before claiming improvement.
4. Do not automate causal labels from outcome rewards or tool counts alone.
5. Prefer batching independent reads, while respecting the domain policy's tool
   call constraints.
6. If extracting the Inspector into its own package, first define a versioned
   result/task schema boundary and test it against multiple Tau2 commits.
7. Preserve upstream attribution and keep `upstream` separate from the fork's
   `origin` remote.

## 13. Source-of-truth map

- Upstream project instructions: `AGENTS.md`
- This fork's security boundary: `SECURITY.md`
- Inspector operation: `viewer/README.md`
- Full project record: this document
- OpenAI transport: `src/tau2/utils/llm_utils.py`
- Transport tests: `tests/test_llm_utils.py`
- Inspector API: `viewer/server.py`
- Workbench analysis: `viewer/workbench.py`
- Human review layer: `viewer/workbench_annotations.json`
- Browser application: `viewer/static/`

When records disagree, trust the current code and saved artifact metadata first,
then update this document explicitly rather than silently changing the narrative.
