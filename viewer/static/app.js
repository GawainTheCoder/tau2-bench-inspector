import { humanizeKey, parseToolResult, valueSummary } from "/assets/result_utils.mjs";

const state = {
  bootstrap: null,
  route: "overview",
  taskId: null,
  taskDetail: null,
  taskSplit: "all",
  runKey: null,
  runDetail: null,
  runTab: "conversation",
  runTask: "all",
  runStatus: "all",
  runModel: "all",
  evaluationKey: null,
  workbench: null,
  workbenchView: "failures",
  workbenchCategory: "all",
  workbenchScenario: "all",
  workbenchReview: "all",
  workbenchRank: "risk_score",
  policy: null,
  dbCollection: "flights",
  dbOffset: 0,
  dbLimit: 24,
  dbData: null,
  query: "",
  autoRefresh: true,
  version: null,
};

const content = document.querySelector("#content");
const globalSearch = document.querySelector("#global-search");
const breadcrumbs = document.querySelector("#breadcrumbs");
const toast = document.querySelector("#toast");
let toastTimer;
let searchTimer;
let taskRequest = 0;
let runRequest = 0;
let workbenchRequest = 0;
let databaseRequest = 0;
let drawerReturnFocus = null;
let resultDomCounter = 0;
const resultModes = new Map();

const escapeHTML = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const formatJSON = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatDate = (value, compact = false) => {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(compact ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const formatDuration = (seconds) => {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
};

const formatCost = (value) => {
  if (value == null) return "—";
  if (value === 0) return "$0";
  return `$${Number(value).toFixed(value < 0.01 ? 4 : 3)}`;
};

const formatNumber = (value) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value || 0);

const scoreText = (reward) => (reward == null ? "—" : Number(reward).toFixed(2));

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const badge = (text, tone = "") =>
  `<span class="badge ${escapeHTML(tone)}">${escapeHTML(text)}</span>`;

async function fetchJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      message = (await response.json()).detail || message;
    } catch {
      // Keep the HTTP status when the body is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function errorState(error, title = "Could not load this view") {
  return `
    <section class="error-state">
      <strong>${escapeHTML(title)}</strong>
      <span>${escapeHTML(error.message || error)}</span>
      <button class="button" data-action="retry">Try again</button>
    </section>`;
}

function pageHeader(eyebrow, title, description, actions = "") {
  return `
    <header class="page-header">
      <div class="page-title">
        <span class="eyebrow">${escapeHTML(eyebrow)}</span>
        <h1>${escapeHTML(title)}</h1>
        <p>${escapeHTML(description)}</p>
      </div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ""}
    </header>`;
}

function outcome(run) {
  if (run.has_error || run.termination_reason === "infrastructure_error") {
    return { label: "Error", cls: "error", mark: "!" };
  }
  if (run.reward === 1) return { label: "Passed", cls: "pass", mark: "✓" };
  if (run.reward != null) return { label: "Failed", cls: "fail", mark: "×" };
  return { label: "Not evaluated", cls: "error", mark: "–" };
}

function runRow(run, selected = false) {
  const status = outcome(run);
  return `
    <button class="run-row ${selected ? "is-selected" : ""}" data-run-key="${escapeHTML(run.key)}">
      <span class="result-dot ${status.cls}">${status.mark}</span>
      <div class="run-main">
        <strong>${escapeHTML(run.folder)}</strong>
        <span>Task ${escapeHTML(run.task_id)} · ${escapeHTML(run.agent_model || "unknown model")}</span>
      </div>
      <div class="run-cell">${escapeHTML(formatDate(run.timestamp, true))}<span class="run-cell-label">Saved</span></div>
      <div class="run-cell">${run.turns == null ? "—" : run.turns} turns<span class="run-cell-label">${run.tool_calls == null ? "—" : run.tool_calls} calls</span></div>
      <div class="run-score">${scoreText(run.reward)}</div>
    </button>`;
}

function setRouteUI() {
  document.querySelectorAll("[data-nav]").forEach((item) => {
    const active = item.dataset.nav === state.route;
    item.classList.toggle("is-active", active);
    item.toggleAttribute("aria-current", active);
  });
  const labels = {
    overview: "Overview",
    tasks: "Tasks & scenarios",
    runs: "Simulation runs",
    workbench: "Evaluation workbench",
    policy: "Airline policy",
    database: "Database",
    tools: "Tools",
  };
  breadcrumbs.innerHTML = `<span>Tau2</span><b>/</b><strong>${labels[state.route] || "Inspector"}</strong>`;
  globalSearch.placeholder = {
    overview: "Search tasks and runs",
    tasks: "Search task purposes",
    runs: "Search runs, tasks, or models",
    workbench: "Search tasks, paths, or observed mechanisms",
    policy: "Search policy sections",
    database: `Search ${state.dbCollection}`,
    tools: "Search tools and parameters",
  }[state.route];
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const route = ["overview", "tasks", "workbench", "runs", "policy", "database", "tools"].includes(parts[0])
    ? parts[0]
    : "overview";
  state.route = route;
  if (route === "tasks" && parts[1]) state.taskId = decodeURIComponent(parts[1]);
  if (route === "runs" && parts[1]) state.runKey = decodeURIComponent(parts[1]);
  if (route === "workbench" && parts[1]) state.evaluationKey = decodeURIComponent(parts[1]);
}

function navigate(route, id = null) {
  const hash = id ? `#/${route}/${encodeURIComponent(id)}` : `#/${route}`;
  if (location.hash === hash) {
    parseRoute();
    renderRoute();
  } else {
    location.hash = hash;
  }
  closeSidebar();
}

function updateChrome() {
  if (!state.bootstrap) return;
  const { stats } = state.bootstrap;
  document.querySelector("#task-nav-count").textContent = stats.task_count;
  document.querySelector("#run-nav-count").textContent = stats.simulation_count;
  const preferredEvaluation = state.bootstrap.evaluations?.[0];
  document.querySelector("#workbench-nav-count").textContent = preferredEvaluation?.evaluated_count ?? "—";
  document.querySelector("#tool-nav-count").textContent = stats.tool_count;
  document.querySelector("#domain-meta").textContent = `${stats.task_count} tasks · ${stats.tool_count} tools`;
  document.querySelector("#last-sync").textContent = `Synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
}

async function loadBootstrap({ silent = false } = {}) {
  try {
    const data = await fetchJSON("/api/bootstrap");
    state.bootstrap = data;
    state.version = data.version;
    updateChrome();
    if (!silent) renderRoute();
    return data;
  } catch (error) {
    if (!silent) content.innerHTML = errorState(error, "Tau2 artifacts could not be read");
    throw error;
  }
}

function renderOverview() {
  const { stats, runs, splits, database } = state.bootstrap;
  const query = state.query.trim().toLowerCase();
  const matchingTasks = state.bootstrap.tasks.filter((task) =>
    `${task.id} ${task.purpose}`.toLowerCase().includes(query),
  );
  const matchingRuns = runs.filter((run) =>
    `${run.folder} ${run.task_id} ${run.purpose} ${run.agent_model}`.toLowerCase().includes(query),
  );
  const recentRuns = (query ? matchingRuns : runs).slice(0, 7);
  const rate = stats.success_rate == null ? "—" : `${Math.round(stats.success_rate * 100)}%`;
  const actions = `<button class="button primary" data-nav="runs">Inspect latest run <span>→</span></button>`;
  content.innerHTML = `
    ${pageHeader(
      "Airline benchmark",
      "Evaluation, at a glance.",
      "Browse the authored scenarios and inspect every saved interaction without leaving the browser.",
      actions,
    )}
    <section class="stats-grid">
      <article class="stat-card">
        <span class="stat-label">Curated tasks</span>
        <strong class="stat-value">${query ? matchingTasks.length : stats.task_count}</strong>
        <span class="stat-note"><span class="stat-trend">${splits.train}</span> train · ${splits.test} held out</span>
      </article>
      <article class="stat-card" style="--stat-tint: var(--blue-soft)">
        <span class="stat-label">Saved simulations</span>
        <strong class="stat-value">${query ? matchingRuns.length : stats.simulation_count}</strong>
        <span class="stat-note">Across ${stats.result_file_count} result files</span>
      </article>
      <article class="stat-card" style="--stat-tint: var(--accent-soft)">
        <span class="stat-label">Evaluated pass rate</span>
        <strong class="stat-value">${rate}</strong>
        <span class="stat-note">${stats.successful_count} of ${stats.evaluated_count} evaluated simulations</span>
      </article>
      <article class="stat-card" style="--stat-tint: var(--amber-soft)">
        <span class="stat-label">Observed tool calls</span>
        <strong class="stat-value">${formatNumber(stats.tool_calls)}</strong>
        <span class="stat-note">${stats.tool_count} tools · ${formatCost(stats.total_cost)} total recorded cost</span>
      </article>
    </section>
    <section class="dashboard-grid">
      <article class="panel">
        <div class="panel-header">
          <div><h2>${query ? "Matching runs" : "Recent simulations"}</h2><p>Completed, failed, and interrupted trajectories</p></div>
          <button class="button compact" data-nav="runs">View all</button>
        </div>
        <div class="run-table">
          ${recentRuns.length ? recentRuns.map((run) => runRow(run)).join("") : emptyInline("No matching runs")}
        </div>
      </article>
      <div class="simple-list" style="gap: 18px">
        <article class="panel">
          <div class="panel-header"><div><h2>Task catalog</h2><p>Current airline split composition</p></div></div>
          <div class="panel-body split-bars">
            ${Object.entries(splits)
              .map(
                ([name, count]) => `
                  <div>
                    <div class="split-bar-head"><strong>${escapeHTML(name)}</strong><span>${count} tasks</span></div>
                    <div class="bar"><span style="width: ${(count / splits.base) * 100}%"></span></div>
                  </div>`,
              )
              .join("")}
          </div>
        </article>
        <article class="panel">
          <div class="panel-header"><div><h2>Live database</h2><p>Searchable benchmark fixtures</p></div></div>
          <div class="panel-body">
            <div class="chip-row">
              ${Object.entries(database)
                .map(([name, count]) => `<button class="button compact" data-db-collection="${name}">${formatNumber(count)} ${name}</button>`)
                .join("")}
            </div>
          </div>
        </article>
        <div class="note-card">
          <strong>Keep held-out tasks clean</strong>
          Opening a task exposes its user scenario and evaluation criteria. Use the train split for manual exploration if you want the test split to remain blind.
        </div>
      </div>
    </section>`;
}

function emptyInline(message) {
  return `<div class="empty-state" style="min-height: 160px"><span>${escapeHTML(message)}</span></div>`;
}

function renderTasks() {
  const tasks = state.bootstrap.tasks;
  if (!state.taskId) state.taskId = tasks[0]?.id;
  const query = state.query.trim().toLowerCase();
  const filtered = tasks.filter((task) => {
    const splitMatch = state.taskSplit === "all" || task.splits.includes(state.taskSplit);
    return splitMatch && `${task.id} ${task.purpose}`.toLowerCase().includes(query);
  });
  if (filtered.length && !filtered.some((task) => task.id === state.taskId)) {
    state.taskId = filtered[0].id;
  }
  if (!filtered.length) state.taskId = null;
  content.innerHTML = `
    ${pageHeader(
      "Scenario library",
      "Tasks & user scenarios",
      "See what each task tests, what the simulated traveler knows, and exactly how success is judged.",
    )}
    <section class="master-detail">
      <aside class="master-pane">
        <div class="master-tools">
          <div class="segmented">
            ${["all", "train", "test"]
              .map((split) => `<button class="${state.taskSplit === split ? "is-active" : ""}" data-task-split="${split}">${split}</button>`)
              .join("")}
          </div>
        </div>
        <div class="list-scroll">
          ${filtered.length
            ? filtered
                .map(
                  (task) => `
                  <button class="master-item ${task.id === state.taskId ? "is-active" : ""}" data-task-id="${escapeHTML(task.id)}">
                    <div class="item-topline">
                      <span class="task-number">TASK ${escapeHTML(task.id.padStart(2, "0"))}</span>
                      <span>${task.reference_actions} actions · ${task.assertions} checks</span>
                    </div>
                    <p>${escapeHTML(task.purpose)}</p>
                  </button>`,
                )
                .join("")
            : emptyInline("No tasks match this filter")}
        </div>
      </aside>
      <article class="detail-pane" id="task-detail">
        ${state.taskId ? `<section class="loading-state"><div class="loading-orbit"><span></span></div><p>Loading task ${escapeHTML(state.taskId)}…</p></section>` : emptyInline("Choose a broader filter to inspect a task")}
      </article>
    </section>`;
  if (state.taskId) loadTaskDetail(state.taskId);
}

async function loadTaskDetail(taskId) {
  const request = ++taskRequest;
  try {
    const detail = await fetchJSON(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (request !== taskRequest || state.route !== "tasks") return;
    state.taskDetail = detail;
    document.querySelector("#task-detail").innerHTML = taskDetailHTML(detail);
  } catch (error) {
    if (request === taskRequest) document.querySelector("#task-detail").innerHTML = errorState(error);
  }
}

function taskDetailHTML(detail) {
  const task = detail.task;
  const description = task.description || {};
  const scenario = task.user_scenario || {};
  const instructions = scenario.instructions || {};
  const criteria = task.evaluation_criteria || {};
  const isTest = detail.splits.includes("test");
  const actions = criteria.actions || [];
  const communicate = criteria.communicate_info || [];
  const assertions = criteria.nl_assertions || [];
  return `
    <div class="detail-scroll">
      <header class="detail-hero">
        <div class="chip-row">
          ${badge(`Task ${task.id}`, "green")}
          ${detail.splits.map((split) => badge(split, split === "test" ? "amber" : "")).join("")}
          ${(criteria.reward_basis || []).map((basis) => badge(basis, "blue")).join("")}
        </div>
        <h2>${escapeHTML(description.purpose || "Untitled airline task")}</h2>
        <div class="metadata-row">
          <span>${actions.length} reference actions</span><span>·</span>
          <span>${assertions.length} natural-language assertions</span><span>·</span>
          <span>${detail.runs.length} saved simulations</span>
        </div>
      </header>
      ${isTest ? `<div class="note-card" style="margin-top: 20px"><strong>Held-out scenario exposed</strong>You are viewing a test task’s hidden user instructions and grading criteria. Treat future results on this task as inspected rather than blind.</div>` : ""}
      <section class="section-block">
        <div class="section-heading"><h3>User scenario</h3><span>Visible to the user simulator, not the agent</span></div>
        <div class="scenario-grid">
          ${scenario.persona ? scenarioCard("Persona", scenario.persona) : ""}
          ${scenarioCard("Reason for call", instructions.reason_for_call, "wide")}
          ${scenarioCard("Known information", instructions.known_info || "No additional known information")}
          ${scenarioCard("Unknown information", instructions.unknown_info || "Nothing explicitly marked unknown")}
          ${scenarioCard("Behavior instructions", instructions.task_instructions, "wide")}
        </div>
      </section>
      <section class="section-block">
        <div class="section-heading"><h3>Evaluation criteria</h3><span>Reward basis: ${(criteria.reward_basis || []).join(" × ") || "Not specified"}</span></div>
        <div class="scenario-grid">
          <div class="criteria-card">
            <span class="mini-label">Required communication</span>
            ${communicate.length ? criteriaItems(communicate) : `<p>No fixed substrings are required for this task.</p>`}
          </div>
          <div class="criteria-card">
            <span class="mini-label">Natural-language assertions</span>
            ${assertions.length ? criteriaItems(assertions) : `<p>No natural-language assertions.</p>`}
          </div>
        </div>
      </section>
      <section class="section-block">
        <div class="section-heading"><h3>Reference tool trajectory</h3><span>One valid path used to derive the target DB state</span></div>
        ${actions.length
          ? `<div class="trajectory-list">${actions.map((action, index) => actionCard(action, index)).join("")}</div>`
          : `<div class="note-card"><strong>No reference calls</strong>The correct outcome is represented by leaving the database unchanged and satisfying communication criteria.</div>`}
      </section>
      ${detail.runs.length ? `
        <section class="section-block">
          <div class="section-heading"><h3>Saved simulations for task ${escapeHTML(task.id)}</h3><button class="button compact" data-nav="runs">Open all runs</button></div>
          <div class="panel" style="box-shadow: none">${detail.runs.slice(0, 5).map((run) => runRow(run)).join("")}</div>
        </section>` : ""}
      <section class="section-block">
        <details><summary>Raw task JSON</summary><pre>${escapeHTML(formatJSON(task))}</pre></details>
      </section>
      ${task.initial_state ? `<section class="section-block"><div class="section-heading"><h3>Initial state</h3><span>Applied before the simulation starts</span></div><pre>${escapeHTML(formatJSON(task.initial_state))}</pre></section>` : ""}
    </div>`;
}

function scenarioCard(label, value, className = "") {
  return `<article class="scenario-card ${className}"><span>${escapeHTML(label)}</span><p>${escapeHTML(value || "Not specified")}</p></article>`;
}

function criteriaItems(items) {
  return `<div class="criteria-list">${items
    .map(
      (item, index) => `
      <div class="criteria-item">
        <span class="criteria-index">${index + 1}</span>
        <p>${escapeHTML(typeof item === "string" ? item : formatJSON(item))}</p>
      </div>`,
    )
    .join("")}</div>`;
}

function actionCard(action, index) {
  return `
    <div class="action-item">
      <span class="step-number">${index + 1}</span>
      <div class="trajectory-card">
        <div class="tool-card-head">
          <h4>${escapeHTML(action.name || "unknown_tool")}</h4>
          ${badge(action.requestor || "assistant", "blue")}
        </div>
        <pre>${escapeHTML(formatJSON(action.arguments || {}))}</pre>
        ${action.compare_args ? `<span class="mini-label">Compared arguments: ${escapeHTML(action.compare_args.join(", "))}</span>` : ""}
      </div>
    </div>`;
}

function filteredRuns() {
  const query = state.query.trim().toLowerCase();
  return state.bootstrap.runs.filter((run) => {
    const status = outcome(run).label.toLowerCase().replace("not evaluated", "unevaluated");
    const taskMatch = state.runTask === "all" || String(run.task_id) === state.runTask;
    const statusMatch = state.runStatus === "all" || status === state.runStatus;
    const modelMatch = state.runModel === "all" || run.agent_model === state.runModel;
    const text = `${run.folder} ${run.file} ${run.task_id} ${run.purpose} ${run.agent_model} ${run.termination_reason}`.toLowerCase();
    return taskMatch && statusMatch && modelMatch && text.includes(query);
  });
}

function renderRuns() {
  const models = [...new Set(state.bootstrap.runs.map((run) => run.agent_model).filter(Boolean))].sort();
  const taskCatalog = new Map(state.bootstrap.tasks.map((task) => [String(task.id), task.purpose]));
  const runTasks = [...state.bootstrap.runs.reduce((tasks, run) => {
    const taskId = String(run.task_id);
    const existing = tasks.get(taskId);
    tasks.set(taskId, {
      id: taskId,
      purpose: run.purpose || taskCatalog.get(taskId) || "Untitled task",
      count: (existing?.count || 0) + 1,
    });
    return tasks;
  }, new Map()).values()].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }));
  if (state.runTask !== "all" && !runTasks.some((task) => task.id === state.runTask)) state.runTask = "all";
  const runs = filteredRuns();
  if (!state.runKey) state.runKey = runs[0]?.key || state.bootstrap.runs[0]?.key;
  if (runs.length && !runs.some((run) => run.key === state.runKey)) state.runKey = runs[0].key;
  if (!runs.length) state.runKey = null;
  content.innerHTML = `
    ${pageHeader(
      "Saved evidence",
      "Simulation runs",
      "Replay the conversation, pair calls with results, and inspect the exact reward breakdown for every simulation.",
    )}
    <section class="master-detail run-master-detail">
      <aside class="master-pane">
        <div class="run-filters">
          <select class="select-field run-task-filter" id="run-task-filter" aria-label="Filter simulations by task">
            <option value="all">All tasks · ${state.bootstrap.runs.length} runs</option>
            ${runTasks.map((task) => `<option value="${escapeHTML(task.id)}" ${state.runTask === task.id ? "selected" : ""}>Task ${escapeHTML(task.id)} · ${escapeHTML(task.purpose)} (${task.count} ${task.count === 1 ? "run" : "runs"})</option>`).join("")}
          </select>
          <select class="select-field" id="run-status-filter" aria-label="Filter by outcome">
            ${["all", "passed", "failed", "error", "unevaluated"].map((value) => `<option value="${value}" ${state.runStatus === value ? "selected" : ""}>${value === "all" ? "All outcomes" : value}</option>`).join("")}
          </select>
          <select class="select-field" id="run-model-filter" aria-label="Filter by model">
            <option value="all">All models</option>
            ${models.map((model) => `<option value="${escapeHTML(model)}" ${state.runModel === model ? "selected" : ""}>${escapeHTML(model)}</option>`).join("")}
          </select>
        </div>
        <div class="list-scroll">
          ${runs.length ? runs.map((run) => runMasterItem(run)).join("") : emptyInline("No runs match these filters")}
        </div>
      </aside>
      <article class="detail-pane" id="run-detail">
        ${state.runKey ? `<section class="loading-state"><div class="loading-orbit"><span></span></div><p>Loading trajectory…</p></section>` : emptyInline("No simulations have been saved yet")}
      </article>
    </section>`;
  if (state.runKey) loadRunDetail(state.runKey, state.runTab === "raw");
}

function runMasterItem(run) {
  const status = outcome(run);
  return `
    <button class="master-item run-item ${run.key === state.runKey ? "is-active" : ""}" data-run-key="${escapeHTML(run.key)}">
      <span class="result-dot ${status.cls}">${status.mark}</span>
      <span>
        <span class="item-topline"><span class="task-number">TASK ${escapeHTML(run.task_id)}</span><span>${escapeHTML(formatDate(run.timestamp, true))}</span></span>
        <p>${escapeHTML(run.folder)}<br>${escapeHTML(run.agent_model || "Unknown model")} · ${run.turns == null ? "—" : run.turns} turns · ${run.tool_calls == null ? "—" : run.tool_calls} calls</p>
      </span>
      <span class="run-item-score">${scoreText(run.reward)}</span>
    </button>`;
}

async function loadRunDetail(runKey, includeRaw = false) {
  const request = ++runRequest;
  try {
    const detail = await fetchJSON(`/api/runs/${encodeURIComponent(runKey)}${includeRaw ? "?include_raw=true" : ""}`);
    if (request !== runRequest || state.route !== "runs") return;
    state.runDetail = detail;
    renderRunDetail();
  } catch (error) {
    if (request === runRequest) document.querySelector("#run-detail").innerHTML = errorState(error);
  }
}

function renderRunDetail() {
  const host = document.querySelector("#run-detail");
  if (!host || !state.runDetail) return;
  const detail = state.runDetail;
  const simulation = detail.simulation || {};
  const info = detail.run_info || {};
  const agentInfo = info.agent_info || {};
  const reward = simulation.reward_info?.reward;
  const status = outcome({
    reward,
    has_error: Boolean(simulation.info?.error),
    termination_reason: simulation.termination_reason,
  });
  const taskPurpose = detail.task?.description?.purpose || `Task ${simulation.task_id}`;
  host.innerHTML = `
    <header class="run-detail-head">
      <div class="chip-row">
        ${badge(status.label, status.cls === "pass" ? "green" : status.cls === "fail" ? "red" : "amber")}
        ${badge(`Task ${simulation.task_id}`, "blue")}
        ${badge(agentInfo.llm || "Unknown model")}
      </div>
      <h2>${escapeHTML(taskPurpose)}</h2>
      <div class="metadata-row">
        <span>${escapeHTML(formatDate(simulation.timestamp || detail.run_timestamp))}</span><span>·</span>
        <span>${escapeHTML(formatDuration(simulation.duration))}</span><span>·</span>
        <span>${detail.messages.length} turns</span><span>·</span>
        <span>${detail.trajectory.length} tool calls</span><span>·</span>
        <span>${escapeHTML(detail.file)}</span>
      </div>
      <nav class="tabs" role="tablist" aria-label="Run detail sections">
        ${[
          ["conversation", "Conversation"],
          ["trajectory", "Tool trajectory"],
          ["rewards", "Rewards"],
          ["behavior", "Agent behavior"],
          ["scenario", "Task & scenario"],
          ["raw", "Raw JSON"],
        ]
          .map(([key, label]) => `<button class="tab ${state.runTab === key ? "is-active" : ""}" role="tab" aria-selected="${state.runTab === key}" data-run-tab="${key}">${label}</button>`)
          .join("")}
      </nav>
    </header>
    <div class="run-detail-content">${runTabHTML(detail)}</div>`;
}

function runTabHTML(detail) {
  switch (state.runTab) {
    case "trajectory":
      return trajectoryHTML(detail);
    case "rewards":
      return rewardsHTML(detail);
    case "behavior":
      return behaviorHTML(detail);
    case "scenario":
      return detail.task ? taskSnapshotHTML(detail) : emptyInline("No task snapshot is available for this run");
    case "raw":
      return rawRunHTML(detail);
    default:
      return conversationHTML(detail);
  }
}

function conversationHTML(detail) {
  const error = detail.simulation?.info;
  if (!detail.messages.length) {
    return `
      ${error?.error ? `<div class="note-card"><strong>${escapeHTML(error.error_type || "Infrastructure error")}</strong>${escapeHTML(error.error)}${error.failed_after_attempts ? `<br><br>Failed after ${error.failed_after_attempts} attempts.` : ""}</div>` : ""}
      ${emptyInline("This simulation ended before any conversation turns were recorded")}`;
  }
  return `
    <div class="conversation">
      ${detail.messages.map((message) => {
        const matchingCall = detail.trajectory.find((step) => step.id === message.id && step.requestor === message.requestor);
        return messageHTML(message, matchingCall?.name);
      }).join("")}
    </div>`;
}

function messageHTML(message, toolName = null) {
  const role = message.role || "system";
  const label = role === "assistant" ? "Agent" : role === "user" ? "Simulated user" : role === "tool" ? `Tool ${message.error ? "error" : "result"}${toolName ? ` · ${toolName}` : ""}` : role;
  const usage = message.usage || {};
  const meta = [
    `Turn ${message.turn_idx ?? message.index}`,
    message.tick_id != null ? `Tick ${message.tick_id}` : null,
    usage.prompt_tokens || usage.completion_tokens ? `${formatNumber((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))} tokens` : null,
    message.cost != null ? formatCost(message.cost) : null,
    message.generation_time_seconds != null ? `${message.generation_time_seconds.toFixed(2)}s` : null,
  ].filter(Boolean);
  const messageBody = role === "tool"
    ? toolResultViewer(message.content ?? message.display_content, `message-${message.index}`, Boolean(message.error))
    : message.display_content
      ? `<div class="message-text">${escapeHTML(message.display_content)}</div>`
      : "";
  return `
    <article class="message-card ${escapeHTML(role)}">
      <span class="message-avatar">${escapeHTML(role.slice(0, 2))}</span>
      <div class="message-bubble">
        <div class="message-meta"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(meta.join(" · "))}</span></div>
        ${messageBody}
        ${(message.tool_calls || []).map((call) => inlineToolCall(call)).join("")}
        ${message.raw_summary ? `<details><summary>Provider metadata</summary><pre>${escapeHTML(formatJSON(message.raw_summary))}</pre></details>` : ""}
      </div>
    </article>`;
}

function inlineToolCall(call) {
  return `
    <div class="tool-call-inline">
      <div class="tool-card-head"><strong>${escapeHTML(call.name || "unknown_tool")}</strong>${badge("Tool request", "green")}</div>
      <pre>${escapeHTML(formatJSON(call.arguments || {}))}</pre>
    </div>`;
}

function trajectoryHTML(detail) {
  if (!detail.trajectory.length) return emptyInline("No tool calls were made in this simulation");
  return `
    <div class="section-heading"><h3>Executed tool path</h3><span>Calls paired to results by call ID</span></div>
    <div class="trajectory-list">
      ${detail.trajectory
        .map(
          (step, index) => `
          <article class="trajectory-step">
            <span class="step-number">${index + 1}</span>
            <div class="trajectory-card">
              <div class="tool-card-head">
                <h4>${escapeHTML(step.name || "unknown_tool")}</h4>
                <div class="chip-row">${badge(step.type, step.type)}${step.error ? badge("Error", "red") : badge("Completed", "green")}</div>
              </div>
              <div class="metadata-row" style="margin-top: 8px"><span>Request turn ${step.turn ?? "—"}</span><span>·</span><span>Result turn ${step.result_turn ?? "—"}</span></div>
              <span class="mini-label" style="margin-top: 13px">Arguments</span>
              <pre>${escapeHTML(formatJSON(step.arguments || {}))}</pre>
              <span class="mini-label">Result</span>
              ${toolResultViewer(step.result, `trajectory-${step.requestor || "unknown"}-${step.id || index}`, Boolean(step.error))}
            </div>
          </article>`,
        )
        .join("")}
    </div>`;
}

function prettyString(value) {
  if (typeof value !== "string") return formatJSON(value);
  try {
    return formatJSON(JSON.parse(value));
  } catch {
    return value;
  }
}

function toolResultViewer(value, key = "result", isError = false) {
  const parsed = parseToolResult(value);
  if (!parsed.structured) {
    return `
      <div class="tool-result-plain ${isError ? "is-error" : ""}">
        <span class="result-kind">${isError ? "Tool error" : "Text result"}</span>
        <div>${escapeHTML(parsed.value ?? "")}</div>
      </div>`;
  }
  const resultId = `tool-result-${slugify(key)}-${resultDomCounter++}`;
  const resultStateKey = `${state.runKey || "run"}:${key}`;
  const selectedMode = resultModes.get(resultStateKey) || "structured";
  const summary = valueSummary(parsed.value);
  return `
    <section class="tool-result-viewer ${isError ? "is-error" : ""}" data-tool-result data-result-key="${escapeHTML(resultStateKey)}">
      <div class="tool-result-toolbar">
        <div class="result-heading"><span class="result-kind">${escapeHTML(summary)}</span>${isError ? badge("Error", "red") : ""}</div>
        <div class="result-mode-switch" role="group" aria-label="Tool result format">
          <button type="button" class="${selectedMode === "structured" ? "is-active" : ""}" aria-pressed="${selectedMode === "structured"}" aria-controls="${resultId}-structured" data-result-mode="structured">Structured</button>
          <button type="button" class="${selectedMode === "raw" ? "is-active" : ""}" aria-pressed="${selectedMode === "raw"}" aria-controls="${resultId}-raw" data-result-mode="raw">Raw JSON</button>
        </div>
      </div>
      <div id="${resultId}-structured" class="result-panel" data-result-panel="structured" ${selectedMode === "structured" ? "" : "hidden"}>
        ${structuredValueHTML(parsed.value)}
      </div>
      <div id="${resultId}-raw" class="result-panel" data-result-panel="raw" ${selectedMode === "raw" ? "" : "hidden"}>
        <pre class="tool-result-raw">${escapeHTML(formatJSON(parsed.value))}</pre>
      </div>
    </section>`;
}

function structuredValueHTML(value, depth = 0) {
  if (value === null || typeof value !== "object") return primitiveValueHTML(value);
  if (depth >= 6) return `<div class="json-more">Maximum preview depth reached · open Raw JSON to continue</div>`;
  if (Array.isArray(value)) return structuredArrayHTML(value, depth);

  const entries = Object.entries(value);
  if (!entries.length) return `<span class="json-empty">Empty object</span>`;
  const visible = entries.slice(0, 24);
  const remaining = entries.length - visible.length;
  return `
    <div class="json-object ${depth === 0 ? "is-root" : ""}">
      ${visible.map(([field, fieldValue]) => structuredFieldHTML(field, fieldValue, depth)).join("")}
      ${remaining > 0 ? `<div class="json-more">+ ${remaining} more fields · open Raw JSON to inspect everything</div>` : ""}
    </div>`;
}

function structuredFieldHTML(field, value, depth) {
  if (value === null || typeof value !== "object") {
    return `
      <div class="json-field">
        <span class="json-key">${escapeHTML(humanizeKey(field))}</span>
        ${primitiveValueHTML(value)}
      </div>`;
  }
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  const noun = Array.isArray(value) ? (count === 1 ? "item" : "items") : (count === 1 ? "field" : "fields");
  return `
    <details class="json-group" ${depth < 1 ? "open" : ""}>
      <summary>
        <span class="json-key">${escapeHTML(humanizeKey(field))}</span>
        <span class="json-count">${count} ${noun}</span>
      </summary>
      <div class="json-group-content">${structuredValueHTML(value, depth + 1)}</div>
    </details>`;
}

function structuredArrayHTML(value, depth) {
  if (!value.length) return `<span class="json-empty">Empty array</span>`;
  const visible = value.slice(0, 24);
  const remaining = value.length - visible.length;
  if (visible.every((item) => item === null || typeof item !== "object")) {
    return `
      <div class="json-chip-list">
        ${visible.map((item) => `<span class="json-chip">${primitiveValueHTML(item, true)}</span>`).join("")}
        ${remaining > 0 ? `<span class="json-more">+ ${remaining} more</span>` : ""}
      </div>`;
  }
  return `
    <div class="json-array">
      ${visible.map((item, index) => `
        <details class="json-array-item" ${depth < 1 && index < 3 ? "open" : ""}>
          <summary><span>Item ${index + 1}</span><span class="json-count">${valueSummary(item)}</span></summary>
          <div class="json-group-content">${structuredValueHTML(item, depth + 1)}</div>
        </details>`).join("")}
      ${remaining > 0 ? `<div class="json-more">+ ${remaining} more items · open Raw JSON to inspect everything</div>` : ""}
    </div>`;
}

function primitiveValueHTML(value, compact = false) {
  const type = value === null ? "null" : typeof value;
  let display = value;
  if (value === null) display = "null";
  if (typeof value === "boolean") display = value ? "true" : "false";
  return `<span class="json-value ${type} ${compact ? "compact" : ""}">${escapeHTML(display)}</span>`;
}

function rewardsHTML(detail) {
  const reward = detail.simulation.reward_info;
  if (!reward) {
    const info = detail.simulation.info || {};
    return `<div class="note-card"><strong>No reward was produced</strong>${escapeHTML(info.error || "The simulation ended before evaluation completed.")}</div>`;
  }
  const score = Number(reward.reward || 0);
  const breakdown = reward.reward_breakdown || {};
  const checks = reward.action_checks || [];
  return `
    <div class="reward-layout">
      <div class="score-card">
        <div class="score-ring" style="--score: ${Math.max(0, Math.min(1, score)) * 360}deg"><strong>${scoreText(reward.reward)}</strong></div>
        <span>Final multiplicative reward</span>
      </div>
      <div class="reward-grid">
        ${Object.entries(breakdown)
          .map(([name, value]) => `<article class="mini-card"><span class="mini-label">${escapeHTML(name)}</span><strong>${scoreText(value)}</strong><small>${reward.reward_basis?.includes(name) ? "Gates final reward" : "Diagnostic only"}</small></article>`)
          .join("")}
        <article class="mini-card"><span class="mini-label">Database match</span><strong>${reward.db_check?.db_match ? "Yes" : "No"}</strong><small>Expected end-state comparison</small></article>
        <article class="mini-card"><span class="mini-label">Reward basis</span><strong style="font-size: 13px">${escapeHTML((reward.reward_basis || []).join(" × ") || "None")}</strong><small>Components multiplied for final score</small></article>
      </div>
    </div>
    <section class="section-block">
      <div class="section-heading"><h3>Reference action diagnostics</h3><span>${checks.filter((check) => check.action_match).length}/${checks.length} matched</span></div>
      ${checks.length
        ? `<div class="check-list">${checks.map((check) => rewardCheckHTML(check)).join("")}</div>`
        : `<p class="message-text">No reference action checks were recorded.</p>`}
    </section>
    <section class="section-block">
      <div class="section-heading"><h3>Evaluator details</h3><span>Null means the check did not run</span></div>
      <pre>${escapeHTML(formatJSON({
        communicate_checks: reward.communicate_checks,
        nl_assertions: reward.nl_assertions,
        env_assertions: reward.env_assertions,
        info: reward.info,
      }))}</pre>
    </section>
    ${diagnosticsHTML(detail.simulation)}`;
}

function diagnosticsHTML(simulation) {
  const diagnostics = {
    review: simulation.review,
    user_only_review: simulation.user_only_review,
    authentication: simulation.auth_classification,
    hallucination_check: simulation.hallucination_check,
    hallucination_retries_used: simulation.hallucination_retries_used,
    provider_session_id: simulation.provider_session_id,
    info: simulation.info,
  };
  const populated = Object.fromEntries(
    Object.entries(diagnostics).filter(([, value]) => value != null && value !== 0),
  );
  if (!Object.keys(populated).length) return "";
  return `
    <section class="section-block">
      <div class="section-heading"><h3>Reviews & diagnostics</h3><span>Optional post-run analysis</span></div>
      <pre>${escapeHTML(formatJSON(populated))}</pre>
    </section>`;
}

function rewardCheckHTML(check) {
  const action = check.action || {};
  return `
    <div class="check-row">
      <span class="check-icon ${check.action_match ? "" : "fail"}">${check.action_match ? "✓" : "×"}</span>
      <span><strong>${escapeHTML(action.name || "Unknown action")}</strong><br><span class="run-cell-label">${escapeHTML(formatJSON(action.arguments || {}))}</span></span>
      ${badge(check.tool_type || "unknown", check.tool_type || "")}
    </div>`;
}

function behaviorHTML(detail) {
  const behavior = detail.behavior;
  const agent = detail.run_info?.agent_info || {};
  const user = detail.run_info?.user_info || {};
  return `
    <div class="behavior-grid">
      ${behaviorCard("Agent model", agent.llm || "Unknown", `Implementation: ${agent.implementation || "unknown"}`)}
      ${behaviorCard("User model", user.llm || "Unknown", `Implementation: ${user.implementation || "unknown"}`)}
      ${behaviorCard("Total tokens", formatNumber(behavior.total_tokens), `${formatNumber(behavior.prompt_tokens)} prompt · ${formatNumber(behavior.completion_tokens)} completion`)}
      ${behaviorCard("Recorded cost", formatCost(behavior.total_cost), `${formatCost(behavior.agent_cost)} agent · ${formatCost(behavior.user_cost)} user`)}
      ${behaviorCard("Tool use", String(behavior.tool_call_count), `${behavior.unique_tools.length} unique tools · ${behavior.tool_errors} errors`)}
      ${behaviorCard("Average generation", behavior.average_generation_seconds == null ? "—" : `${behavior.average_generation_seconds.toFixed(2)}s`, "Across timed participant messages")}
      ${behaviorCard("Termination", behavior.termination_reason || "Unknown", `${detail.simulation.mode || "unknown"} mode`)}
    </div>
    <section class="section-block">
      <div class="section-heading"><h3>Turn composition</h3><span>Recorded message roles</span></div>
      <div class="chip-row">${Object.entries(behavior.role_counts).map(([role, count]) => badge(`${role}: ${count}`, role === "assistant" ? "green" : role === "user" ? "blue" : "amber")).join("")}</div>
    </section>
    <section class="section-block">
      <div class="section-heading"><h3>Tools selected</h3><span>In first-use order is visible in the trajectory tab</span></div>
      <div class="chip-row">${behavior.unique_tools.length ? behavior.unique_tools.map((tool) => badge(tool)).join("") : "No tools used"}</div>
    </section>
    <section class="section-block">
      <div class="section-heading"><h3>Configuration</h3><span>Run-level model arguments</span></div>
      <div class="scenario-grid">
        <div class="scenario-card"><span>Agent arguments</span><pre>${escapeHTML(formatJSON(agent.llm_args || {}))}</pre></div>
        <div class="scenario-card"><span>User arguments</span><pre>${escapeHTML(formatJSON(user.llm_args || {}))}</pre></div>
      </div>
    </section>`;
}

function behaviorCard(label, value, note) {
  return `<article class="mini-card"><span class="mini-label">${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(note)}</small></article>`;
}

function taskSnapshotHTML(detail) {
  const task = detail.task;
  const instructions = task.user_scenario?.instructions || {};
  const criteria = task.evaluation_criteria || {};
  return `
    <div class="note-card"><strong>Run provenance</strong>This is the task snapshot saved with the simulation, so it remains accurate even if the current catalog later changes.</div>
    <section class="section-block">
      <div class="section-heading"><h3>User scenario</h3><span>Hidden from the evaluated agent</span></div>
      <div class="scenario-grid">
        ${scenarioCard("Reason for call", instructions.reason_for_call, "wide")}
        ${scenarioCard("Known information", instructions.known_info || "None")}
        ${scenarioCard("Unknown information", instructions.unknown_info || "None")}
        ${scenarioCard("Behavior instructions", instructions.task_instructions, "wide")}
      </div>
    </section>
    <section class="section-block">
      <div class="section-heading"><h3>Evaluation criteria</h3><span>${escapeHTML((criteria.reward_basis || []).join(" × "))}</span></div>
      <pre>${escapeHTML(formatJSON(criteria))}</pre>
    </section>
    <section class="section-block">
      <details><summary>Policy snapshot used by this simulation</summary><div class="markdown-body" style="margin-top: 12px">${renderMarkdown(detail.policy || "")}</div></details>
    </section>`;
}

function rawRunHTML(detail) {
  if (!detail.raw) {
    return `
      <div class="note-card"><strong>Raw provider payloads are loaded on demand</strong>They can be hundreds of kilobytes and may include encrypted reasoning blobs and provider diagnostics.</div>
      <button class="button primary" style="margin-top: 14px" data-action="load-raw">Load complete raw JSON</button>`;
  }
  return `<pre>${escapeHTML(formatJSON(detail.raw))}</pre>`;
}

function renderPolicy() {
  content.innerHTML = `
    ${pageHeader("Operating rules", "Airline policy", "The complete system policy supplied to the airline agent, with a navigable section outline.")}
    <section id="policy-host"><div class="loading-state"><div class="loading-orbit"><span></span></div><p>Loading policy…</p></div></section>`;
  loadPolicy();
}

async function loadPolicy() {
  try {
    if (!state.policy) state.policy = await fetchJSON("/api/policy");
    if (state.route !== "policy") return;
    const query = state.query.trim().toLowerCase();
    const headings = state.policy.headings.filter((heading) => !query || heading.text.toLowerCase().includes(query));
    document.querySelector("#policy-host").innerHTML = `
      <div class="policy-layout">
        <nav class="policy-outline">
          <strong>${query ? "Matching sections" : "On this page"}</strong>
          ${headings.length ? headings.map((heading) => `<button class="policy-link level-${heading.level}" data-policy-anchor="policy-${slugify(heading.text)}">${escapeHTML(heading.text)}</button>`).join("") : `<span class="run-cell-label">No headings match.</span>`}
        </nav>
        <article class="markdown-body">${renderMarkdown(state.policy.markdown)}</article>
      </div>`;
  } catch (error) {
    document.querySelector("#policy-host").innerHTML = errorState(error);
  }
}

function inlineMarkdown(text) {
  return escapeHTML(text)
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(markdown) {
  const lines = String(markdown).split("\n");
  const output = [];
  let inList = false;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (inList) output.push("</ul>");
    inList = false;
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const list = line.match(/^\s*-\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      output.push(`<h${level} id="policy-${slugify(heading[2])}">${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (list) {
      flushParagraph();
      if (!inList) output.push("<ul>");
      inList = true;
      output.push(`<li>${inlineMarkdown(list[1])}</li>`);
    } else if (!line.trim()) {
      flushParagraph();
      closeList();
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  closeList();
  return output.join("\n");
}

function renderDatabase() {
  const counts = state.bootstrap.database;
  content.innerHTML = `
    ${pageHeader("Environment state", "Airline database", "Search the exact flight, user, and reservation fixtures used by the tool environment.")}
    <section class="panel">
      <div class="database-toolbar">
        <div class="database-tabs">
          ${Object.entries(counts).map(([name, count]) => `<button class="database-tab ${state.dbCollection === name ? "is-active" : ""}" data-db-collection="${name}">${name} · ${formatNumber(count)}</button>`).join("")}
        </div>
        <span class="run-cell-label">Showing 24 records per page</span>
      </div>
      <div id="database-results"><div class="loading-state"><div class="loading-orbit"><span></span></div><p>Loading ${escapeHTML(state.dbCollection)}…</p></div></div>
    </section>`;
  loadDatabase();
}

async function loadDatabase() {
  const request = ++databaseRequest;
  try {
    const params = new URLSearchParams({
      q: state.query,
      offset: state.dbOffset,
      limit: state.dbLimit,
    });
    const data = await fetchJSON(`/api/database/${encodeURIComponent(state.dbCollection)}?${params}`);
    if (request !== databaseRequest || state.route !== "database") return;
    state.dbData = data;
    document.querySelector("#database-results").innerHTML = databaseHTML(data);
  } catch (error) {
    if (request === databaseRequest) document.querySelector("#database-results").innerHTML = errorState(error);
  }
}

function databaseHTML(data) {
  const start = data.total ? data.offset + 1 : 0;
  const end = Math.min(data.offset + data.items.length, data.total);
  return `
    ${data.items.length
      ? `<div class="database-grid">${data.items.map((item) => databaseCard(data.collection, item)).join("")}</div>`
      : emptyInline("No database records match this search")}
    <div class="pagination">
      <button class="button compact" data-db-page="prev" ${data.offset === 0 ? "disabled" : ""}>← Previous</button>
      <span>${start}–${end} of ${formatNumber(data.total)}</span>
      <button class="button compact" data-db-page="next" ${end >= data.total ? "disabled" : ""}>Next →</button>
    </div>`;
}

function databaseCard(collection, item) {
  const value = item.value || {};
  let title = item.id;
  let summary = "";
  if (collection === "flights") {
    title = `${item.id} · ${value.origin || "?"} → ${value.destination || "?"}`;
    summary = `${Object.keys(value.dates || {}).length} dated instances`;
  } else if (collection === "users") {
    const name = value.name || {};
    title = `${name.first_name || ""} ${name.last_name || ""}`.trim() || item.id;
    summary = `${item.id}\n${value.email || ""}\n${(value.reservation_ids || []).length} reservations`;
  } else if (collection === "reservations") {
    title = `${item.id} · ${value.origin || "?"} → ${value.destination || "?"}`;
    summary = `${value.cabin || "Unknown cabin"} · ${(value.passengers || []).length} passengers · ${(value.flights || []).length} segments`;
  }
  return `
    <button class="database-card" data-db-record="${escapeHTML(item.id)}">
      <strong>${escapeHTML(title)}</strong>
      <p>${escapeHTML(summary || JSON.stringify(value).slice(0, 220))}</p>
    </button>`;
}

function renderTools() {
  const query = state.query.trim().toLowerCase();
  const tools = state.bootstrap.tools.filter((tool) =>
    `${tool.name} ${tool.type} ${tool.description} ${tool.signature}`.toLowerCase().includes(query),
  );
  const types = state.bootstrap.tools.reduce((acc, tool) => {
    acc[tool.type] = (acc[tool.type] || 0) + 1;
    return acc;
  }, {});
  content.innerHTML = `
    ${pageHeader(
      "Agent capabilities",
      "Airline tools",
      "Read the exact callable signatures, parameter requirements, side-effect class, and source documentation.",
      `<div class="chip-row">${Object.entries(types).map(([type, count]) => badge(`${count} ${type}`, type)).join("")}</div>`,
    )}
    ${tools.length ? `<section class="tool-grid">${tools.map((tool) => toolCard(tool)).join("")}</section>` : emptyInline("No tools match this search")}`;
}

function toolCard(tool) {
  return `
    <article class="tool-card">
      <div class="tool-card-head">
        <h3>${escapeHTML(tool.name)}</h3>
        ${badge(tool.type, tool.type)}
      </div>
      <p>${escapeHTML(tool.description || "No description supplied.")}</p>
      <div class="signature">${escapeHTML(tool.signature)} → ${escapeHTML(tool.returns || "Any")}</div>
      <div class="parameter-list">
        ${tool.parameters.length
          ? tool.parameters.map((param) => `<div class="parameter-row"><code>${escapeHTML(param.name)}</code><span>${escapeHTML(param.type)}</span><span>${param.required ? "required" : escapeHTML(param.default)}</span></div>`).join("")
          : `<span class="run-cell-label">No parameters</span>`}
      </div>
      <span class="run-cell-label" style="display: block; margin-top: 11px">Source: src/tau2/domains/airline/tools.py:${tool.line}</span>
      ${tool.parameter_schema ? `<details><summary>Full JSON schema</summary><pre>${escapeHTML(formatJSON(tool.parameter_schema))}</pre></details>` : ""}
    </article>`;
}

async function loadWorkbench(evaluationKey = state.evaluationKey) {
  const request = ++workbenchRequest;
  try {
    const query = evaluationKey ? `?evaluation_key=${encodeURIComponent(evaluationKey)}` : "";
    const data = await fetchJSON(`/api/workbench${query}`);
    if (request !== workbenchRequest || state.route !== "workbench") return;
    state.workbench = data;
    state.evaluationKey = data.batch.key;
    const expectedHash = `#/workbench/${encodeURIComponent(state.evaluationKey)}`;
    if (location.hash !== expectedHash) history.replaceState(null, "", expectedHash);
    renderWorkbench();
  } catch (error) {
    if (request === workbenchRequest) content.innerHTML = errorState(error, "Evaluation evidence could not be built");
  }
}

function renderWorkbench() {
  if (!state.workbench || (state.evaluationKey && state.workbench.batch.key !== state.evaluationKey)) {
    content.innerHTML = `
      ${pageHeader("Macro review", "Evaluation workbench", "Building evidence-backed failure and successful-run reviews from the saved cohort.")}
      <section class="loading-state"><div class="loading-orbit"><span></span></div><p>Analyzing saved trajectories…</p></section>`;
    loadWorkbench();
    return;
  }
  const data = state.workbench;
  const summary = data.summary;
  const selector = `
    <label class="workbench-batch-field">
      <span>Evaluation cohort</span>
      <select class="select-field" id="workbench-batch" aria-label="Select evaluation cohort">
        ${data.evaluations.map((evaluation) => `<option value="${escapeHTML(evaluation.key)}" ${evaluation.key === data.batch.key ? "selected" : ""}>${escapeHTML(evaluation.folder)} · ${evaluation.evaluated_count} evaluated · ${Math.round((evaluation.success_rate || 0) * 100)}%</option>`).join("")}
      </select>
    </label>`;
  content.innerHTML = `
    ${pageHeader(
      "Macro review",
      "Evaluation workbench",
      "Review what happened across one saved cohort: outcome failures first, then successful paths that may still be inefficient or brittle.",
      selector,
    )}
    ${workbenchCohortHTML(data)}
    <section class="workbench-shell">
      <div class="workbench-tabs" role="tablist" aria-label="Workbench datasets">
        <button type="button" role="tab" aria-selected="${state.workbenchView === "failures"}" class="workbench-tab ${state.workbenchView === "failures" ? "is-active" : ""}" data-workbench-view="failures">Outcome failures <span>${summary.failure_count}</span></button>
        <button type="button" role="tab" aria-selected="${state.workbenchView === "successes"}" class="workbench-tab ${state.workbenchView === "successes" ? "is-active" : ""}" data-workbench-view="successes">Successful-run review <span>${summary.success_count}</span></button>
      </div>
      <div class="workbench-body">
        ${state.workbenchView === "successes" ? successWorkbenchHTML(data) : failureWorkbenchHTML(data)}
      </div>
    </section>`;
}

function workbenchCohortHTML(data) {
  const summary = data.summary;
  const classifications = summary.success_classifications || {};
  const successTotal = summary.success_count || 1;
  return `
    <section class="cohort-map" aria-label="Evaluation cohort outcome map">
      <div class="cohort-root">
        <span class="eyebrow">Selected evidence set</span>
        <strong>${summary.total_runs}</strong>
        <span>evaluated airline runs</span>
        <small>${escapeHTML(data.batch.agent_model || "unknown model")} · reasoning ${escapeHTML(data.batch.reasoning_effort || "default")} · ${escapeHTML(data.batch.folder)}</small>
      </div>
      <div class="cohort-branch failure-branch">
        <span class="branch-line" aria-hidden="true"></span>
        <div><strong>${summary.failure_count}</strong><span>outcome failures</span></div>
        <p>Every description below states an observed mechanism from the stored trace, not a causal claim.</p>
      </div>
      <div class="cohort-branch success-branch">
        <span class="branch-line" aria-hidden="true"></span>
        <div><strong>${summary.success_count}</strong><span>successful runs</span></div>
        <div class="classification-bar" aria-label="Successful run review classifications">
          ${["clean", "inefficient", "brittle", "inefficient + brittle"].map((key) => {
            const count = classifications[key] || 0;
            return `<span class="classification-segment ${slugify(key)}" style="--share:${(count / successTotal) * 100}%" title="${escapeHTML(key)}: ${count}"></span>`;
          }).join("")}
        </div>
        <p>${classifications.clean || 0} clean · ${classifications.inefficient || 0} inefficient · ${classifications.brittle || 0} brittle · ${classifications["inefficient + brittle"] || 0} both</p>
      </div>
    </section>`;
}

function failureWorkbenchHTML(data) {
  const query = state.query.trim().toLowerCase();
  const scenarios = [...new Set(data.failures.map((row) => row.scenario_type))].sort();
  const rows = data.failures.filter((row) => {
    const categoryMatch = state.workbenchCategory === "all" || row.categories.includes(state.workbenchCategory);
    const scenarioMatch = state.workbenchScenario === "all" || row.scenario_type === state.workbenchScenario;
    const text = `${row.task_id} ${row.purpose} ${row.scenario_type} ${row.tool_names.join(" ")} ${row.observed_failure_mechanism} ${row.category_labels.join(" ")}`.toLowerCase();
    return categoryMatch && scenarioMatch && text.includes(query);
  });
  return `
    <div class="workbench-intro">
      <div><span class="eyebrow">Failure mechanisms</span><h2>${rows.length} of ${data.failures.length} failed tasks</h2><p>${escapeHTML(data.methodology.failure_note)}</p></div>
      <div class="taxonomy-strip">${data.taxonomy.map((item) => `<button type="button" class="taxonomy-chip ${state.workbenchCategory === item.code ? "is-active" : ""}" data-workbench-category="${item.code}" title="${escapeHTML(item.label)}"><b>${item.code}</b><span>${item.count}</span></button>`).join("")}</div>
    </div>
    <div class="workbench-filters">
      <label><span>Taxonomy</span><select class="select-field" id="workbench-category"><option value="all">All mechanisms</option>${data.taxonomy.map((item) => `<option value="${item.code}" ${state.workbenchCategory === item.code ? "selected" : ""}>${item.code} · ${escapeHTML(item.label)} (${item.count})</option>`).join("")}</select></label>
      <label><span>Scenario type</span><select class="select-field" id="workbench-scenario"><option value="all">All scenario types</option>${scenarios.map((scenario) => `<option value="${escapeHTML(scenario)}" ${state.workbenchScenario === scenario ? "selected" : ""}>${escapeHTML(scenario)}</option>`).join("")}</select></label>
      <span class="filter-count">${rows.length} rows</span>
    </div>
    <div class="workbench-table-scroll" role="region" aria-label="Failed-task evidence table" tabindex="0">
      <table class="workbench-table failure-table">
        <thead><tr>
          <th>Task</th><th>Purpose / scenario</th><th>DB</th><th>COMMUNICATE</th><th>Actual tool sequence</th><th>Write?</th><th>Write arguments</th><th>Explicit confirmation?</th><th>Prerequisites first?</th><th>Final outcome</th><th>Turns</th><th>Tools</th><th>Observed failure mechanism</th><th>Inspect</th>
        </tr></thead>
        <tbody>${rows.map((row) => failureRowHTML(row)).join("")}</tbody>
      </table>
    </div>`;
}

function scoreGateHTML(value) {
  if (value == null) return `<span class="gate unknown">Not run</span>`;
  return value === 1 ? `<span class="gate pass">✓ ${scoreText(value)}</span>` : `<span class="gate fail">× ${scoreText(value)}</span>`;
}

function toolPathHTML(steps, max = 12) {
  if (!steps.length) return `<span class="muted-copy">No tool calls</span>`;
  const visible = steps.slice(0, max);
  return `<div class="tool-path">${visible.map((step, index) => `${index ? '<span class="path-arrow">→</span>' : ""}<code class="tool-path-chip ${step.is_write ? "write" : ""}" title="Turn ${escapeHTML(step.turn)}">${escapeHTML(step.name)}</code>`).join("")}${steps.length > max ? `<span class="path-more">+${steps.length - max}</span>` : ""}</div>`;
}

function failureRowHTML(row) {
  const categories = row.categories.map((code, index) => badge(`${code} · ${row.category_labels[index]}`, code === "I" ? "" : code === "D" || code === "C" || code === "E" ? "red" : code === "H" ? "amber" : "blue")).join("");
  const outcomeText = `${row.final_outcome.db_matched ? "DB matched" : "DB mismatch"}; ${row.final_outcome.communication_matched ? "communication met" : "communication missed"}`;
  return `<tr>
    <td><strong class="table-task">${escapeHTML(row.task_id)}</strong></td>
    <td><div class="purpose-cell"><span>${badge(row.scenario_type, "violet")}</span><p>${escapeHTML(row.purpose)}</p></div></td>
    <td>${scoreGateHTML(row.db_reward)}</td>
    <td>${scoreGateHTML(row.communicate_reward)}</td>
    <td>${toolPathHTML(row.tool_sequence)}</td>
    <td>${row.write_tool_called ? badge(`Yes · ${row.write_calls.length}`, "write") : badge("No", "")}</td>
    <td>${row.write_calls.length ? `<details class="table-details"><summary>${row.write_calls.length} write call${row.write_calls.length === 1 ? "" : "s"}</summary>${row.write_calls.map((call) => `<strong>${escapeHTML(call.name)}</strong><pre>${escapeHTML(formatJSON(call.arguments))}</pre>`).join("")}</details>` : `<span class="muted-copy">None</span>`}</td>
    <td>${badge(row.confirmation.label, row.confirmation.status === "yes" ? "green" : row.confirmation.status === "not_applicable" ? "" : "red")}</td>
    <td>${badge(humanizeKey(row.prerequisites_retrieved), row.prerequisites_retrieved === "yes" ? "green" : row.prerequisites_retrieved === "partial" ? "amber" : "red")}</td>
    <td><div class="outcome-cell"><strong>${escapeHTML(outcomeText)}</strong><p>${escapeHTML(row.final_outcome.assistant_message)}</p></div></td>
    <td class="numeric-cell">${row.turn_count}</td>
    <td class="numeric-cell">${row.tool_count}</td>
    <td class="mechanism-cell"><div>${categories}</div><p>${escapeHTML(row.observed_failure_mechanism)}</p></td>
    <td><button type="button" class="button compact" data-workbench-failure="${escapeHTML(row.task_id)}">Evidence</button></td>
  </tr>`;
}

const successRankMetrics = {
  risk_score: { label: "Review priority", value: (row) => row.risk_score, rank: "risk_score" },
  tool_count: { label: "Tool count", value: (row) => row.tool_count, rank: "tool_count" },
  turn_count: { label: "Turn count", value: (row) => row.turn_count, rank: "turn_count" },
  duration: { label: "Duration", value: (row) => row.duration || 0, rank: "duration" },
  cost: { label: "Cost", value: (row) => row.total_cost || 0, rank: "cost" },
  repeated_tool_names: { label: "Repeated tool names", value: (row) => row.repeats.name_repeat_count, rank: "repeated_tool_names" },
  repeated_arguments: { label: "Repeated arguments", value: (row) => row.repeats.argument_repeat_count, rank: "repeated_arguments" },
  transfers: { label: "Transfers / escalations", value: (row) => row.transfer_count, rank: "transfers" },
};

function successWorkbenchHTML(data) {
  const query = state.query.trim().toLowerCase();
  const metric = successRankMetrics[state.workbenchRank] || successRankMetrics.risk_score;
  const rows = data.successes
    .filter((row) => {
      const reviewMatch = state.workbenchReview === "all" || row.classification === state.workbenchReview;
      const text = `${row.task_id} ${row.purpose} ${row.review_label} ${row.tool_names.join(" ")} ${row.redundant_avoidable_or_risky.join(" ")}`.toLowerCase();
      return reviewMatch && text.includes(query);
    })
    .sort((left, right) => metric.value(right) - metric.value(left) || Number(left.task_id) - Number(right.task_id));
  const counts = data.summary.success_classifications || {};
  return `
    <div class="workbench-intro">
      <div><span class="eyebrow">Successful paths</span><h2>${rows.length} of ${data.successes.length} successful runs</h2><p>${escapeHTML(data.methodology.success_note)}</p></div>
      <div class="review-summary">${["clean", "inefficient", "brittle", "inefficient + brittle"].map((key) => `<div><strong>${counts[key] || 0}</strong><span>${escapeHTML(key)}</span></div>`).join("")}</div>
    </div>
    <div class="workbench-filters">
      <label><span>Review class</span><select class="select-field" id="workbench-review"><option value="all">All successful runs</option>${["clean", "inefficient", "brittle", "inefficient + brittle"].map((value) => `<option value="${value}" ${state.workbenchReview === value ? "selected" : ""}>${escapeHTML(value)} (${counts[value] || 0})</option>`).join("")}</select></label>
      <label><span>Rank by</span><select class="select-field" id="workbench-rank">${Object.entries(successRankMetrics).map(([key, item]) => `<option value="${key}" ${state.workbenchRank === key ? "selected" : ""}>${escapeHTML(item.label)} · highest first</option>`).join("")}</select></label>
      <span class="filter-count">${rows.length} rows</span>
    </div>
    <div class="workbench-table-scroll" role="region" aria-label="Successful-run efficiency table" tabindex="0">
      <table class="workbench-table success-table">
        <thead><tr><th>Rank</th><th>Task</th><th>Review</th><th>What was the task?</th><th>Path taken</th><th>Necessary steps</th><th>Redundant, avoidable, or risky</th><th>Cost / latency impact</th><th>Tools</th><th>Turns</th><th>Duration</th><th>Cost</th><th>Repeated names</th><th>Repeated args</th><th>Transfers</th><th>Inspect</th></tr></thead>
        <tbody>${rows.map((row) => successRowHTML(row, metric)).join("")}</tbody>
      </table>
    </div>`;
}

function reviewTone(classification) {
  if (classification === "clean") return "green";
  if (classification === "inefficient") return "amber";
  return "red";
}

function compactList(items) {
  return items?.length ? `<ul class="compact-list">${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : `<span class="muted-copy">None recorded</span>`;
}

function successRowHTML(row, metric) {
  const repeatedNames = row.repeats.names.map((item) => `${item.name} ×${item.count}`).join(", ") || "0";
  return `<tr>
    <td><strong class="rank-number">#${row.ranks[metric.rank]}</strong><span class="rank-label">${escapeHTML(metric.label)}</span></td>
    <td><strong class="table-task">${escapeHTML(row.task_id)}</strong></td>
    <td>${badge(row.review_label, reviewTone(row.classification))}</td>
    <td><div class="purpose-cell"><span>${badge(row.scenario_type, "violet")}</span><p>${escapeHTML(row.what_was_the_task)}</p></div></td>
    <td>${toolPathHTML(row.tool_sequence)}</td>
    <td>${compactList(row.necessary_steps)}</td>
    <td>${compactList(row.redundant_avoidable_or_risky)}</td>
    <td><p class="impact-cell">${escapeHTML(row.material_cost_latency_impact)}</p></td>
    <td class="numeric-cell">${row.tool_count}</td><td class="numeric-cell">${row.turn_count}</td><td>${escapeHTML(formatDuration(row.duration))}</td><td>${escapeHTML(formatCost(row.total_cost))}</td>
    <td><span title="${escapeHTML(repeatedNames)}">${row.repeats.name_repeat_count}</span></td><td class="numeric-cell">${row.repeats.argument_repeat_count}</td><td class="numeric-cell">${row.transfer_count}</td>
    <td><button type="button" class="button compact" data-workbench-success="${escapeHTML(row.task_id)}">Review</button></td>
  </tr>`;
}

function evidenceLinks(row) {
  return `<div class="drawer-actions">
    <button type="button" class="button primary" data-open-workbench-run="${escapeHTML(row.run_key)}" data-target-tab="conversation">Conversation</button>
    <button type="button" class="button" data-open-workbench-run="${escapeHTML(row.run_key)}" data-target-tab="trajectory">Tool trajectory</button>
    <button type="button" class="button" data-open-workbench-run="${escapeHTML(row.run_key)}" data-target-tab="rewards">Rewards</button>
    <button type="button" class="button" data-open-workbench-run="${escapeHTML(row.run_key)}" data-target-tab="scenario">Task snapshot</button>
  </div>`;
}

function failureDrawerHTML(row) {
  return `
    <div class="drawer-section"><div class="chip-row">${badge(`Task ${row.task_id}`, "blue")}${badge(row.scenario_type, "violet")}${row.categories.map((code, index) => badge(`${code} · ${row.category_labels[index]}`, "red")).join("")}</div><h3>Observed failure mechanism</h3><p class="drawer-lead">${escapeHTML(row.observed_failure_mechanism)}</p><p class="method-note">This describes the stored behavior. It is not a causal claim.</p></div>
    <div class="drawer-section"><h3>Evidence</h3>${compactList(row.evidence)}</div>
    <div class="drawer-section"><h3>Reward gates</h3><div class="drawer-metrics"><div><span>DB</span>${scoreGateHTML(row.db_reward)}</div><div><span>COMMUNICATE</span>${scoreGateHTML(row.communicate_reward)}</div><div><span>Turns</span><strong>${row.turn_count}</strong></div><div><span>Tools</span><strong>${row.tool_count}</strong></div></div></div>
    <div class="drawer-section"><h3>Actual tool path</h3>${toolPathHTML(row.tool_sequence, 100)}${row.write_calls.length ? `<h4>Write arguments</h4>${row.write_calls.map((call) => `<strong>${escapeHTML(call.name)}</strong><pre>${escapeHTML(formatJSON(call.arguments))}</pre>`).join("")}` : `<p class="muted-copy">No write tool was called.</p>`}</div>
    <div class="drawer-section"><h3>Confirmation and prerequisites</h3><p><strong>Explicit confirmation:</strong> ${escapeHTML(row.confirmation.label)}${row.confirmation.evidence ? ` — “${escapeHTML(row.confirmation.evidence)}”` : ""}</p><p><strong>Prerequisite facts retrieved first:</strong> ${escapeHTML(humanizeKey(row.prerequisites_retrieved))}</p></div>
    <div class="drawer-section"><h3>Final agent message</h3><blockquote>${escapeHTML(row.final_outcome.assistant_message)}</blockquote></div>
    ${evidenceLinks(row)}`;
}

function successDrawerHTML(row) {
  return `
    <div class="drawer-section"><div class="chip-row">${badge(`Task ${row.task_id}`, "blue")}${badge(row.review_label, reviewTone(row.classification))}</div><h3>${escapeHTML(row.purpose)}</h3><p class="method-note">Official benchmark reward: ${scoreText(row.reward)}. The review label is a separate trajectory judgment.</p></div>
    <div class="drawer-section"><h3>What path did the agent take?</h3>${toolPathHTML(row.tool_sequence, 100)}</div>
    <div class="drawer-section"><h3>Which steps were actually necessary?</h3>${compactList(row.necessary_steps)}<p class="method-note">${escapeHTML(row.necessary_steps_basis)}</p></div>
    <div class="drawer-section"><h3>What looks redundant, avoidable, or risky?</h3>${compactList(row.redundant_avoidable_or_risky)}</div>
    <div class="drawer-section"><h3>Did extra work materially increase cost or latency?</h3><p class="drawer-lead">${escapeHTML(row.material_cost_latency_impact)}</p><div class="drawer-metrics"><div><span>Tools</span><strong>${row.tool_count}</strong></div><div><span>Turns</span><strong>${row.turn_count}</strong></div><div><span>Duration</span><strong>${escapeHTML(formatDuration(row.duration))}</strong></div><div><span>Total cost</span><strong>${escapeHTML(formatCost(row.total_cost))}</strong></div></div></div>
    <div class="drawer-section"><h3>Repeat and escalation evidence</h3><p><strong>Repeated tool-name excess:</strong> ${row.repeats.name_repeat_count}</p><p><strong>Exact repeated arguments:</strong> ${row.repeats.argument_repeat_count}</p><p><strong>Transfers:</strong> ${row.transfer_count}</p>${row.repeats.arguments.length ? row.repeats.arguments.map((item) => `<details><summary>${escapeHTML(item.name)} ×${item.count}</summary><pre>${escapeHTML(formatJSON(item.arguments))}</pre></details>`).join("") : ""}</div>
    ${evidenceLinks(row)}`;
}

function renderRoute() {
  if (!state.bootstrap) return;
  setRouteUI();
  switch (state.route) {
    case "tasks":
      renderTasks();
      break;
    case "runs":
      renderRuns();
      break;
    case "workbench":
      renderWorkbench();
      break;
    case "policy":
      renderPolicy();
      break;
    case "database":
      renderDatabase();
      break;
    case "tools":
      renderTools();
      break;
    default:
      renderOverview();
  }
}

function openDrawer(eyebrow, title, body) {
  drawerReturnFocus = document.activeElement;
  document.querySelector("#drawer-eyebrow").textContent = eyebrow;
  document.querySelector("#drawer-title").textContent = title;
  document.querySelector("#drawer-content").innerHTML = body;
  document.querySelector("#drawer").classList.add("is-open");
  document.querySelector("#drawer").setAttribute("aria-hidden", "false");
  document.querySelector("#drawer-backdrop").classList.add("is-open");
  document.querySelector(".workspace").inert = true;
  document.querySelector("#sidebar").inert = true;
  document.querySelector("#drawer-close").focus();
}

function closeDrawer() {
  document.querySelector("#drawer").classList.remove("is-open");
  document.querySelector("#drawer").setAttribute("aria-hidden", "true");
  document.querySelector("#drawer-backdrop").classList.remove("is-open");
  document.querySelector(".workspace").inert = false;
  document.querySelector("#sidebar").inert = false;
  drawerReturnFocus?.focus?.();
  drawerReturnFocus = null;
}

function closeSidebar() {
  document.querySelector("#sidebar").classList.remove("is-open");
  document.querySelector("#sidebar-scrim").classList.remove("is-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
}

async function pollVersion() {
  if (!state.autoRefresh || document.hidden) return;
  try {
    const { version } = await fetchJSON("/api/version");
    if (state.version && version !== state.version) {
      await loadBootstrap({ silent: true });
      state.policy = null;
      state.workbench = null;
      renderRoute();
      showToast("New or updated Tau2 artifacts loaded");
    }
  } catch {
    // The next poll will retry; checkpoint replacement can briefly race a read.
  }
}

document.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-nav]");
  if (nav) {
    navigate(nav.dataset.nav);
    return;
  }

  const workbenchView = event.target.closest("[data-workbench-view]");
  if (workbenchView) {
    state.workbenchView = workbenchView.dataset.workbenchView;
    renderWorkbench();
    return;
  }

  const workbenchCategory = event.target.closest("[data-workbench-category]");
  if (workbenchCategory) {
    state.workbenchCategory = state.workbenchCategory === workbenchCategory.dataset.workbenchCategory ? "all" : workbenchCategory.dataset.workbenchCategory;
    renderWorkbench();
    return;
  }

  const failedReview = event.target.closest("[data-workbench-failure]");
  if (failedReview && state.workbench) {
    const row = state.workbench.failures.find((item) => item.task_id === failedReview.dataset.workbenchFailure);
    if (row) openDrawer("Failed-task evidence", `Task ${row.task_id}`, failureDrawerHTML(row));
    return;
  }

  const successReview = event.target.closest("[data-workbench-success]");
  if (successReview && state.workbench) {
    const row = state.workbench.successes.find((item) => item.task_id === successReview.dataset.workbenchSuccess);
    if (row) openDrawer("Successful-run review", `Task ${row.task_id}`, successDrawerHTML(row));
    return;
  }

  const workbenchRun = event.target.closest("[data-open-workbench-run]");
  if (workbenchRun) {
    state.runKey = workbenchRun.dataset.openWorkbenchRun;
    state.runTab = workbenchRun.dataset.targetTab || "conversation";
    closeDrawer();
    navigate("runs", state.runKey);
    return;
  }

  const task = event.target.closest("[data-task-id]");
  if (task) {
    state.taskId = task.dataset.taskId;
    history.replaceState(null, "", `#/tasks/${encodeURIComponent(state.taskId)}`);
    document.querySelectorAll("[data-task-id]").forEach((item) => item.classList.toggle("is-active", item.dataset.taskId === state.taskId));
    document.querySelector("#task-detail").innerHTML = `<section class="loading-state"><div class="loading-orbit"><span></span></div><p>Loading task ${escapeHTML(state.taskId)}…</p></section>`;
    loadTaskDetail(state.taskId);
    return;
  }

  const split = event.target.closest("[data-task-split]");
  if (split) {
    state.taskSplit = split.dataset.taskSplit;
    renderTasks();
    return;
  }

  const run = event.target.closest("[data-run-key]");
  if (run) {
    state.runKey = run.dataset.runKey;
    state.runTab = "conversation";
    if (state.route !== "runs") {
      navigate("runs", state.runKey);
    } else {
      history.replaceState(null, "", `#/runs/${encodeURIComponent(state.runKey)}`);
      document.querySelectorAll("[data-run-key]").forEach((item) => item.classList.toggle("is-active", item.dataset.runKey === state.runKey));
      document.querySelector("#run-detail").innerHTML = `<section class="loading-state"><div class="loading-orbit"><span></span></div><p>Loading trajectory…</p></section>`;
      loadRunDetail(state.runKey);
    }
    return;
  }

  const tab = event.target.closest("[data-run-tab]");
  if (tab) {
    state.runTab = tab.dataset.runTab;
    renderRunDetail();
    return;
  }

  const resultMode = event.target.closest("[data-result-mode]");
  if (resultMode) {
    const viewer = resultMode.closest("[data-tool-result]");
    const mode = resultMode.dataset.resultMode;
    resultModes.set(viewer.dataset.resultKey, mode);
    viewer.querySelectorAll("[data-result-mode]").forEach((button) => {
      const active = button.dataset.resultMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    viewer.querySelectorAll("[data-result-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.resultPanel !== mode;
    });
    return;
  }

  const policyAnchor = event.target.closest("[data-policy-anchor]");
  if (policyAnchor) {
    document.getElementById(policyAnchor.dataset.policyAnchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const collection = event.target.closest("[data-db-collection]");
  if (collection) {
    state.dbCollection = collection.dataset.dbCollection;
    state.dbOffset = 0;
    state.query = "";
    globalSearch.value = "";
    if (state.route !== "database") navigate("database");
    else renderDatabase();
    return;
  }

  const page = event.target.closest("[data-db-page]");
  if (page && !page.disabled) {
    state.dbOffset = Math.max(0, state.dbOffset + (page.dataset.dbPage === "next" ? state.dbLimit : -state.dbLimit));
    loadDatabase();
    return;
  }

  const record = event.target.closest("[data-db-record]");
  if (record && state.dbData) {
    const item = state.dbData.items.find((entry) => entry.id === record.dataset.dbRecord);
    if (item) openDrawer(state.dbCollection.slice(0, -1) || "Record", item.id, `<pre>${escapeHTML(formatJSON(item.value))}</pre>`);
    return;
  }

  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "retry") {
    renderRoute();
  } else if (action?.dataset.action === "load-raw" && state.runKey) {
    action.disabled = true;
    action.textContent = "Loading raw payload…";
    await loadRunDetail(state.runKey, true);
    state.runTab = "raw";
    renderRunDetail();
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "workbench-batch") {
    state.evaluationKey = event.target.value;
    state.workbench = null;
    history.replaceState(null, "", `#/workbench/${encodeURIComponent(state.evaluationKey)}`);
    renderWorkbench();
  } else if (event.target.id === "workbench-category") {
    state.workbenchCategory = event.target.value;
    renderWorkbench();
  } else if (event.target.id === "workbench-scenario") {
    state.workbenchScenario = event.target.value;
    renderWorkbench();
  } else if (event.target.id === "workbench-review") {
    state.workbenchReview = event.target.value;
    renderWorkbench();
  } else if (event.target.id === "workbench-rank") {
    state.workbenchRank = event.target.value;
    renderWorkbench();
  } else if (event.target.id === "run-task-filter") {
    state.runTask = event.target.value;
    renderRuns();
  } else if (event.target.id === "run-status-filter") {
    state.runStatus = event.target.value;
    renderRuns();
  } else if (event.target.id === "run-model-filter") {
    state.runModel = event.target.value;
    renderRuns();
  }
});

globalSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = globalSearch.value;
    if (state.route === "database") {
      state.dbOffset = 0;
      loadDatabase();
    } else if (state.route === "policy") {
      loadPolicy();
    } else {
      renderRoute();
    }
  }, 180);
});

document.querySelector("#refresh-button").addEventListener("click", async () => {
  const button = document.querySelector("#refresh-button");
  button.textContent = "…";
  try {
    await loadBootstrap({ silent: true });
    state.policy = null;
    state.workbench = null;
    renderRoute();
    showToast("Tau2 artifacts refreshed");
  } finally {
    button.textContent = "↻";
  }
});

const themeToggle = document.querySelector("#theme-toggle");

function applyTheme(theme, persist = false) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  const dark = resolved === "dark";
  themeToggle.querySelector(".theme-icon").textContent = dark ? "☀" : "☾";
  themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  themeToggle.setAttribute("title", dark ? "Switch to light mode" : "Switch to dark mode");
  themeToggle.setAttribute("aria-pressed", String(dark));
  if (persist) {
    try {
      localStorage.setItem("tau2-inspector-theme", resolved);
    } catch {
      // Theme still applies when storage is unavailable.
    }
  }
}

applyTheme(document.documentElement.dataset.theme);
themeToggle.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
});

window.addEventListener("storage", (event) => {
  if (event.key !== "tau2-inspector-theme") return;
  const saved = event.newValue === "dark" || event.newValue === "light" ? event.newValue : null;
  const preferred = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(saved || preferred);
});

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
  try {
    if (localStorage.getItem("tau2-inspector-theme")) return;
  } catch {
    // Fall through to the system preference.
  }
  applyTheme(event.matches ? "dark" : "light");
});

document.querySelector("#live-toggle").addEventListener("click", (event) => {
  state.autoRefresh = !state.autoRefresh;
  event.currentTarget.classList.toggle("is-on", state.autoRefresh);
  event.currentTarget.setAttribute("aria-pressed", String(state.autoRefresh));
  showToast(state.autoRefresh ? "Live sync enabled" : "Live sync paused");
});

document.querySelector("#mobile-menu").addEventListener("click", () => {
  document.querySelector("#sidebar").classList.add("is-open");
  document.querySelector("#sidebar-scrim").classList.add("is-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "true");
});
document.querySelector("#sidebar-scrim").addEventListener("click", closeSidebar);
document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
document.querySelector("#drawer-backdrop").addEventListener("click", closeDrawer);

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    globalSearch.focus();
  }
  if (event.key === "Escape") {
    closeDrawer();
    closeSidebar();
  }
  if (event.key === "Tab" && document.querySelector("#drawer").classList.contains("is-open")) {
    const focusable = [...document.querySelectorAll("#drawer button:not([disabled]), #drawer a[href], #drawer summary, #drawer [tabindex]:not([tabindex='-1'])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

window.addEventListener("hashchange", () => {
  parseRoute();
  state.query = "";
  globalSearch.value = "";
  renderRoute();
});

parseRoute();
setRouteUI();
loadBootstrap().catch(() => {});
setInterval(pollVersion, 2000);
