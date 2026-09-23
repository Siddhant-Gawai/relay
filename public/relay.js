const $ = (selector) => document.querySelector(selector);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const formatTime = (value) => (value ? new Date(value).toLocaleString() : "—");
const percent = (value) => (value == null ? "—" : value.toFixed(1) + "%");
const ms = (value) => (value == null ? "—" : value + " ms");
let session,
  workspaceId,
  dashboard,
  selectedEvent,
  selectedRoute,
  page = 0,
  refreshing = false,
  search = new URLSearchParams();
let refreshPromise;
function setView(view) {
  const titles = {
    deliveries: ["Deliveries", "Requests, responses, and retries."],
    routes: ["Routes", "Destinations and delivery policies."],
    activity: ["Activity", "Changes made in this workspace."],
  };
  for (const name of Object.keys(titles))
    $("#view-" + name).hidden = name !== view;
  document.querySelectorAll("[data-view]").forEach((button) => {
    if (button.dataset.view === view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#page-title").textContent = titles[view][0];
  $("#page-description").textContent = titles[view][1];
}
document
  .querySelectorAll("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () => setView(button.dataset.view)),
  );
$("#open-dispatch").addEventListener("click", () =>
  $("#dispatch-modal").showModal(),
);
let noticeTimer;
function notice(message, error = false) {
  clearTimeout(noticeTimer);
  if (!error)
    noticeTimer = setTimeout(() => {
      $("#notice").hidden = true;
    }, 6000);
  $("#notice").hidden = false;
  $("#notice").textContent = message;
  $("#notice").classList.toggle("error", error);
}
function showLogin() {
  $("#login-panel").hidden = false;
  $("#app").hidden = true;
}
async function request(path, options = {}, retry = true) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401 && retry && !path.startsWith("/api/auth/")) {
    refreshPromise ||= fetch("/api/auth/refresh", { method: "POST" }).finally(
      () => {
        refreshPromise = null;
      },
    );
    if ((await refreshPromise).ok) return request(path, options, false);
    showLogin();
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const post = (path, body = {}, headers = {}) =>
  request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
function guarded(fn) {
  return async (event) => {
    try {
      await fn(event);
    } catch (error) {
      notice(error.message, true);
    }
  };
}
function owner() {
  return (
    session?.workspaces.find((w) => w.id === workspaceId)?.role === "owner"
  );
}
function operator() {
  return (
    session?.workspaces.find((w) => w.id === workspaceId)?.role !== "viewer"
  );
}
function matches(pattern, type) {
  return new RegExp(
    "^" +
      pattern
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  ).test(type);
}
function renderResolution() {
  if (!dashboard) return;
  const selected = $("#dispatch-destination").value;
  const routes = dashboard.endpoints.filter(
    (r) =>
      r.enabled &&
      (selected
        ? r.id === selected
        : matches(r.eventPattern, $("#dispatch-type").value)),
  );
  $("#route-match-count").textContent = routes.length + " matches";
  $("#route-resolution").innerHTML = routes.length
    ? routes
        .map(
          (r) =>
            "<article><div><b>" +
            escape(r.name) +
            "</b><small>" +
            escape(r.eventPattern) +
            "</small></div><span>" +
            r.retryPolicy.maxAttempts +
            " attempts max</span></article>",
        )
        .join("")
    : '<div class="empty-attention">No enabled route matches.<br>Add a destination to begin.</div>';
}
function updateOptions(select, routes, initial) {
  const previous = select.value;
  select.innerHTML =
    '<option value="">' +
    initial +
    "</option>" +
    routes
      .map(
        (r) =>
          '<option value="' +
          escape(r.id) +
          '">' +
          escape(r.name) +
          (r.enabled ? "" : " (paused)") +
          "</option>",
      )
      .join("");
  select.value = previous;
}
function renderDashboard(data) {
  dashboard = data;
  const { stats, endpoints } = data;
  $("#received").textContent = stats.received.toLocaleString();
  $("#success-rate").textContent = percent(stats.successRate);
  $("#failed").textContent = data.queue.dead_letter || 0;
  $("#pending-count").textContent = stats.pending + " pending";
  $("#latency-p95").textContent = ms(stats.p95);
  $("#latency-detail").textContent =
    "p50 " + ms(stats.p50) + " · p99 " + ms(stats.p99);
  $("#metrics-window").textContent =
    formatTime(data.window.from) + " – " + formatTime(data.window.to);
  $("#metrics-basis").textContent = data.window.basis;
  $("#success-series").innerHTML = stats.series
    .map(
      (b) =>
        '<div class="series-bucket" title="' +
        escape(
          formatTime(b.at) +
            ": " +
            percent(b.successRate) +
            ", " +
            b.attempts +
            " attempts",
        ) +
        '"><span>' +
        percent(b.successRate) +
        '</span><div class="bar-track"><i style="height:' +
        (b.successRate ?? 0) +
        '%"></i></div><small>' +
        escape(
          new Date(b.at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        ) +
        "</small></div>",
    )
    .join("");
  $("#failure-reasons").innerHTML = Object.entries(stats.failureReasons).length
    ? Object.entries(stats.failureReasons)
        .map(
          ([reason, count]) =>
            '<div class="reason-row"><code>' +
            escape(reason) +
            "</code><b>" +
            count +
            "</b></div>",
        )
        .join("")
    : '<p class="empty-note">No recorded failures in this window.</p>';
  $("#destination-list").innerHTML = endpoints.length
    ? endpoints
        .map(
          (r) =>
            '<article class="destination-card"><small><i class="status-dot ' +
            (r.health.state === "attention" ? "attention" : "") +
            '"></i>' +
            escape(r.health.state.replace("_", " ").toUpperCase()) +
            '</small><h3><button class="route-name" data-route="' +
            escape(r.id) +
            '">' +
            escape(r.name) +
            "</button></h3><p>" +
            escape(r.url) +
            '</p><p class="route-rule">' +
            escape(r.eventPattern) +
            " · " +
            r.retryPolicy.maxAttempts +
            " attempts · " +
            escape(r.retryPolicy.backoff) +
            '</p><p class="route-rule">' +
            r.health.deliveries +
            " deliveries in window · " +
            (r.secretProvisioned
              ? "receiver credential provisioned"
              : "credential provisioning needed") +
            "</p></article>",
        )
        .join("")
    : '<p class="empty-attention">No destinations yet. Register a receiver to start routing.</p>';
  updateOptions($("#dispatch-destination"), endpoints, "All matching routes");
  updateOptions($("#filter-destination"), endpoints, "All routes");
  renderResolution();
}
function renderEvents(result) {
  $("#stream-list").innerHTML = result.events.length
    ? result.events
        .map(
          (e) =>
            '<button class="event" data-event="' +
            escape(e.id) +
            '"><span><b class="event-type">' +
            escape(e.type) +
            '</b><small class="event-id">' +
            escape(e.correlationId) +
            '</small></span><small class="event-endpoint">' +
            escape(e.endpoint) +
            '</small><b class="status ' +
            escape(e.status) +
            '">' +
            escape(e.status.replace("_", " ")) +
            " · " +
            (e.responseCode ?? "—") +
            '</b><small class="event-time">' +
            escape(formatTime(e.createdAt)) +
            "</small></button>",
        )
        .join("")
    : '<p class="empty-attention">No matching deliveries. Try another filter or dispatch an event.</p>';
  $("#page-label").textContent =
    (result.total ? page + 1 : 0) +
    "–" +
    Math.min(page + result.events.length, result.total) +
    " of " +
    result.total;
  $("#previous-page").disabled = page === 0;
  $("#next-page").disabled = page + 50 >= result.total;
}
function attemptRows(event) {
  return event.attemptLog.length
    ? '<ol class="attempt-timeline">' +
        event.attemptLog
          .map(
            (a) =>
              "<li><div><b>Attempt " +
              a.number +
              " · " +
              escape(a.outcome) +
              "</b><span>" +
              escape(formatTime(a.at)) +
              "</span></div><p>" +
              escape(
                a.error ||
                  (a.outcome === "started"
                    ? "Reserved; completion was not recorded. It may have reached the receiver."
                    : "HTTP " + a.responseCode),
              ) +
              " · " +
              ms(a.latency) +
              " · cycle " +
              (a.cycle + 1) +
              "</p></li>",
          )
          .join("") +
        "</ol>"
    : '<p class="empty-note">Waiting for its first attempt.</p>';
}
async function selectEvent(id) {
  selectedEvent = id;
  const event = await request("/api/events/" + encodeURIComponent(id));
  if (selectedEvent !== id) return;
  document.querySelectorAll("[data-event]").forEach((row) => {
    row.classList.toggle("selected", row.dataset.event === id);
    row.setAttribute("aria-pressed", String(row.dataset.event === id));
  });
  $("#inspector").innerHTML =
    '<p class="eyebrow">Delivery details</p><h2>' +
    escape(event.type) +
    '</h2><p class="break-text">' +
    escape(event.id) +
    '</p><div class="meta-grid"><div><span>DESTINATION</span><b>' +
    escape(event.endpoint) +
    '</b></div><div><span>OUTCOME</span><b class="status ' +
    escape(event.status) +
    '">' +
    escape(event.status) +
    "</b></div><div><span>ATTEMPTS</span><b>" +
    event.attempts +
    " total · cycle " +
    (event.replayCount + 1) +
    "</b></div><div><span>NEXT RETRY</span><b>" +
    (["queued", "retrying"].includes(event.status)
      ? escape(formatTime(event.nextAttemptAt))
      : "—") +
    '</b></div></div><p class="form-hint">Correlation ID</p><button class="correlation-link" data-correlation="' +
    escape(event.correlationId) +
    '">' +
    escape(event.correlationId) +
    '</button><pre class="payload">' +
    escape(JSON.stringify(event.payload, null, 2)) +
    "</pre>" +
    attemptRows(event) +
    (event.status === "dead_letter" && operator()
      ? '<button class="replay" data-replay="' +
        escape(event.id) +
        '">Replay delivery</button>'
      : "");
}
async function selectRoute(id) {
  selectedRoute = id;
  const data = await request("/api/endpoints/" + encodeURIComponent(id));
  const r = data.route;
  if (selectedRoute !== id) return;
  const disabled = owner() ? "" : " disabled";
  $("#route-detail").innerHTML =
    '<p class="eyebrow">Route / ' +
    escape(data.endpoints[0]?.health.state || "no data") +
    "</p><h2>" +
    escape(r.name) +
    '</h2><p class="break-text">' +
    escape(r.id) +
    '</p><div class="route-summary"><span><b>' +
    percent(data.stats.successRate) +
    "</b>terminal success</span><span><b>" +
    ms(data.stats.p95) +
    "</b>p95 latency</span><span><b>" +
    (data.queue.dead_letter || 0) +
    '</b>unresolved</span></div><p class="form-hint">Health: last 24 hours. Unresolved queue: all time.</p><form id="route-form"><fieldset' +
    disabled +
    '><legend>Route configuration</legend><div class="field-pair"><label>Name<input name="name" value="' +
    escape(r.name) +
    '" maxlength="80" required></label><label>State<select name="enabled"><option value="true"' +
    (r.enabled ? " selected" : "") +
    '>Enabled</option><option value="false"' +
    (!r.enabled ? " selected" : "") +
    '>Paused</option></select></label></div><label>URL<input type="url" name="url" value="' +
    escape(r.url) +
    '" required></label><label>Event rule<input name="eventPattern" value="' +
    escape(r.eventPattern) +
    '" required></label><div class="field-pair"><label>Maximum attempts<input type="number" name="maxAttempts" min="1" max="10" value="' +
    r.retryPolicy.maxAttempts +
    '" required></label><label>Backoff<select name="backoff"><option value="exponential"' +
    (r.retryPolicy.backoff === "exponential" ? " selected" : "") +
    '>Exponential</option><option value="fixed"' +
    (r.retryPolicy.backoff === "fixed" ? " selected" : "") +
    '>Fixed</option></select></label><label>Base delay · ms<input type="number" name="baseDelayMs" min="100" max="3600000" value="' +
    r.retryPolicy.baseDelayMs +
    '" required></label><label>Timeout · ms<input type="number" name="timeoutMs" min="100" max="30000" value="' +
    r.retryPolicy.timeoutMs +
    '" required></label></div><p class="form-hint">Policy edits apply to new events and replays. Pause also holds queued retries; in-flight requests may finish.</p><button class="submit">Save changes</button></fieldset></form><section class="verification-guide"><h3>Signature verification</h3><p>Credential version ' +
    r.secretVersion +
    " · " +
    (r.secretProvisioned ? "provisioned" : "not yet provisioned") +
    '. Credentials stay outside this interface.</p><p>Provision or rotate into a private file with the CLI. Supply owner authentication through environment variables; see README.</p><code class="break-text">node scripts/provision-secret.js ' +
    escape(r.id) +
    ' &lt;private-output-file&gt;</code><ol><li>Read the raw request bytes before parsing JSON.</li><li>Compute HMAC-SHA256 over relay-timestamp + "." + raw body.</li><li>Compare the v1 signature using a constant-time comparison.</li><li>Reject stale timestamps and deduplicate relay-event-id.</li></ol><p>Rotation is immediate. Coordinate receiver configuration before resuming a paused route.</p></section><h3>Recent deliveries</h3><div class="route-recent">' +
    (data.events.length
      ? data.events
          .slice(0, 10)
          .map(
            (e) =>
              '<button class="route-event" data-route-event="' +
              escape(e.id) +
              '"><b>' +
              escape(e.type) +
              "</b><span>" +
              escape(e.status) +
              " · " +
              e.attempts +
              " attempts</span></button>" +
              attemptRows(e),
          )
          .join("")
      : "<p>No deliveries recorded yet.</p>") +
    "</div>";
  if (!$("#route-modal").open) $("#route-modal").showModal();
}
function windowQuery() {
  const params = new URLSearchParams();
  for (const key of ["from", "to"])
    if (search.has(key)) params.set(key, search.get(key));
  return params.toString();
}
async function refresh() {
  if (!session || refreshing || $("#app").hidden) return;
  refreshing = true;
  const captured = workspaceId;
  try {
    const params = new URLSearchParams(search);
    params.set("offset", page);
    const [data, events, audit, health] = await Promise.all([
      request("/api/dashboard?" + windowQuery()),
      request("/api/events?" + params),
      request("/api/audit"),
      request("/api/health"),
    ]);
    if (captured !== workspaceId) return;
    renderDashboard(data);
    renderEvents(events);
    $("#worker-state").textContent = !health.worker.running
      ? "Worker offline"
      : health.worker.lastErrorAt &&
          health.worker.lastErrorAt === health.worker.lastPollAt
        ? "Worker error"
        : "Worker online";
    $("#audit-list").innerHTML = audit.entries.length
      ? audit.entries
          .map(
            (a) =>
              '<article class="audit-row"><time>' +
              escape(formatTime(a.at)) +
              "</time><b>" +
              escape(a.action) +
              "</b><span>" +
              escape(a.actorId === session.user.id ? "You" : a.actorId) +
              "</span><code>" +
              escape(a.targetId) +
              "</code></article>",
          )
          .join("")
      : '<p class="empty-note">Workspace actions will appear here.</p>';
    if (selectedEvent) await selectEvent(selectedEvent);
  } finally {
    refreshing = false;
  }
}
async function boot(preferred) {
  session = await request("/api/session");
  workspaceId = preferred || workspaceId || session.defaultWorkspace;
  if (!session.workspaces.some((w) => w.id === workspaceId))
    workspaceId = session.defaultWorkspace;
  $("#workspace-select").innerHTML = session.workspaces
    .map(
      (w) =>
        '<option value="' +
        escape(w.id) +
        '">' +
        escape(w.name) +
        " · " +
        escape(w.role) +
        "</option>",
    )
    .join("");
  $("#workspace-select").value = workspaceId;
  $("#mode-label").textContent =
    session.mode === "local" ? "Development" : "Workspace";
  $("#logout").hidden = session.mode === "local";
  $("#login-panel").hidden = true;
  $("#app").hidden = false;
  $("#open-endpoint").hidden = !owner();
  $("#dispatch-submit").disabled = !operator();
  $("#member-form").hidden = !owner();
  $("#user-id").textContent = session.user.id;
  await refresh();
}
$("#dispatch-key").value = crypto.randomUUID();
$("#new-key").addEventListener("click", () => {
  $("#dispatch-key").value = crypto.randomUUID();
});
$("#dispatch-type").addEventListener("input", renderResolution);
$("#dispatch-destination").addEventListener("change", renderResolution);
$("#dispatch-form").addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    const button = $("#dispatch-submit");
    button.disabled = true;
    try {
      const endpointId = $("#dispatch-destination").value;
      const body = {
        type: $("#dispatch-type").value,
        payload: JSON.parse($("#dispatch-payload").value),
        ...(endpointId ? { endpointId } : {}),
        ...($("#dispatch-correlation").value
          ? { correlationId: $("#dispatch-correlation").value }
          : {}),
      };
      const result = await post(
        endpointId ? "/api/events" : "/api/ingest",
        body,
        { "idempotency-key": $("#dispatch-key").value },
      );
      $("#dispatch-result").textContent =
        (result.duplicate ? "Original event found. " : "Event committed. ") +
        result.routed +
        " deliveries · correlation " +
        result.correlationId;
      $("#dispatch-modal").close();
      setView("deliveries");
      await refresh();
      if (result.deliveries[0]) await selectEvent(result.deliveries[0].id);
      notice(
        result.duplicate
          ? "Duplicate prevented. Showing the original deliveries."
          : "Accepted into the durable queue.",
      );
    } finally {
      button.disabled = !operator();
    }
  }),
);
$("#open-endpoint").addEventListener("click", () =>
  $("#endpoint-modal").showModal(),
);
$("#endpoint-form").addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    const result = await post(
      "/api/endpoints",
      Object.fromEntries(new FormData(event.target)),
    );
    $("#endpoint-modal").close();
    event.target.reset();
    await refresh();
    await selectRoute(result.endpoint.id);
    notice(
      "Route created. Configure its receiver credential before sending real events.",
    );
  }),
);
$("#route-detail").addEventListener(
  "submit",
  guarded(async (event) => {
    if (event.target.id !== "route-form") return;
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.target));
    await request("/api/endpoints/" + encodeURIComponent(selectedRoute), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        url: input.url,
        eventPattern: input.eventPattern,
        enabled: input.enabled === "true",
        retryPolicy: {
          maxAttempts: +input.maxAttempts,
          backoff: input.backoff,
          baseDelayMs: +input.baseDelayMs,
          timeoutMs: +input.timeoutMs,
        },
      }),
    });
    await selectRoute(selectedRoute);
    await refresh();
    notice("Route configuration saved.");
  }),
);
document.addEventListener(
  "click",
  guarded(async (event) => {
    const close = event.target.closest("[data-close]");
    if (close) close.closest("dialog").close();
    const delivery = event.target.closest("[data-event], [data-route-event]");
    if (delivery) {
      if (delivery.dataset.routeEvent) {
        $("#route-modal").close();
        setView("deliveries");
      }
      await selectEvent(delivery.dataset.event || delivery.dataset.routeEvent);
      $("#inspector").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    const route = event.target.closest("[data-route]");
    if (route) await selectRoute(route.dataset.route);
    const replay = event.target.closest("[data-replay]");
    if (replay) {
      replay.disabled = true;
      try {
        await post(
          "/api/events/" +
            encodeURIComponent(replay.dataset.replay) +
            "/replay",
        );
        await refresh();
        notice("Replay queued. Earlier attempts are retained.");
      } finally {
        replay.disabled = false;
      }
    }
    const correlation = event.target.closest("[data-correlation]");
    if (correlation) {
      setView("deliveries");
      $("#search-form").elements.correlationId.value =
        correlation.dataset.correlation;
      $("#search-form").requestSubmit();
    }
  }),
);
$("#search-form").addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    search = new URLSearchParams();
    for (const [key, value] of new FormData(event.target))
      if (value)
        search.set(
          key,
          ["from", "to"].includes(key) ? new Date(value).toISOString() : value,
        );
    page = 0;
    await refresh();
  }),
);
$("#search-form").addEventListener(
  "reset",
  guarded(async () => {
    search = new URLSearchParams();
    page = 0;
    await refresh();
  }),
);
$("#previous-page").addEventListener(
  "click",
  guarded(async () => {
    page = Math.max(0, page - 50);
    await refresh();
  }),
);
$("#next-page").addEventListener(
  "click",
  guarded(async () => {
    page += 50;
    await refresh();
  }),
);
$("#refresh").addEventListener("click", guarded(refresh));
$("#workspace-select").addEventListener(
  "change",
  guarded(async () => {
    workspaceId = $("#workspace-select").value;
    selectedEvent = null;
    selectedRoute = null;
    page = 0;
    search = new URLSearchParams();
    $("#search-form").reset();
    $("#inspector").innerHTML =
      '<p class="eyebrow">Delivery details</p><h2>No delivery selected</h2>';
    await boot(workspaceId);
  }),
);
$("#login-form").addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    await post("/api/auth/login", {
      email: $("#login-email").value,
      password: $("#login-password").value,
    });
    $("#login-password").value = "";
    await boot();
    notice("Signed in.");
  }),
);
$("#logout").addEventListener(
  "click",
  guarded(async () => {
    await post("/api/auth/logout");
    session = null;
    workspaceId = null;
    showLogin();
  }),
);
$("#workspace-open").addEventListener(
  "click",
  guarded(async () => {
    if (!session) return;
    $("#member-list").innerHTML = owner()
      ? (await request("/api/members"))
          .map(
            (m) =>
              '<p class="break-text">' +
              escape(m.userId) +
              " · " +
              escape(m.role) +
              "</p>",
          )
          .join("")
      : "";
    $("#workspace-modal").showModal();
  }),
);
$("#workspace-form").addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    const workspace = await post(
      "/api/workspaces",
      Object.fromEntries(new FormData(event.target)),
    );
    $("#workspace-modal").close();
    selectedEvent = null;
    page = 0;
    search = new URLSearchParams();
    await boot(workspace.id);
    notice("Workspace created.");
  }),
);
$("#member-form").addEventListener(
  "submit",
  guarded(async (event) => {
    event.preventDefault();
    await post("/api/members", Object.fromEntries(new FormData(event.target)));
    notice("Membership saved.");
  }),
);
boot().catch((error) => {
  showLogin();
  if (!error.message.includes("Sign in")) notice(error.message, true);
});
setInterval(() => {
  if (!document.hidden && session)
    refresh().catch((error) => notice(error.message, true));
}, 8000);
