# Tau2 Inspector

Tau2 Inspector is a local, read-only browser for the airline benchmark. It reads
the existing task catalog, policy, database fixtures, runtime tool schemas, and
saved simulation results directly from this checkout.

For the complete project history, model/API decisions, 50-task findings, and
benchmark-validity boundaries, see `docs/TAU2_INSPECTOR_CONTEXT.md`. Read
`SECURITY.md` before sharing results or changing the server bind address.

## Start it

From the repository root:

```bash
uv run --frozen python viewer/server.py
```

The viewer opens `http://127.0.0.1:8005` automatically. Stop it with `Ctrl-C`.
To start it without opening a browser:

```bash
uv run --frozen python viewer/server.py --no-open
```

The viewer binds to loopback by default. Binding to another interface requires
the explicit `--allow-network` flag because the UI exposes hidden task
scenarios, realistic fixture records, and optional raw provider payloads.

## What it shows

- The 50 airline tasks, train/test membership, user scenarios, reference
  actions, required communication, assertions, and raw task definition
- The current airline policy with section navigation
- Searchable, paginated flights, users, and reservations
- Runtime-derived tool schemas, mutability classes, source signatures, and
  return schemas
- Airline simulation results, including infrastructure errors and evaluated
  failures
- An Evaluation Workbench that auto-selects the most complete saved cohort,
  catalogs evidence-backed observed failure mechanisms, and ranks successful
  runs by tools, turns, duration, cost, repeated calls, and escalations
- Conversation turns, model usage/cost, provider metadata, tool requests and
  structured or raw tool results, paired tool trajectories, agent behavior, reward components,
  evaluator diagnostics, and the task/policy snapshot used by each run
- Monolithic text results and directory-format/full-duplex results
- Persistent light and dark themes

The browser checks for changed task, policy, database, tool, and result files
every two seconds. Workbench review annotations are watched too. New or updated
simulations appear without restarting the server, and every workbench row links
back to its full conversation, tool trajectory, rewards, and task snapshot.

## Verify it

```bash
uv run --frozen python -m unittest viewer.test_server
node --check viewer/static/app.js
node --check viewer/static/theme_bootstrap.js
node --test viewer/test_result_utils.mjs
```
