
// AIRWATCH v3.0 - EMQX LIVE MQTT
// Keeps your original dashboard interface and styling.

// EMQX Cloud connection details
const MQTT_HOST = "rdde1c1a.ala.asia-southeast1.emqxsl.com";
const MQTT_PORT = 8084;
const MQTT_USERNAME = "airwatch_web";
const MQTT_PASSWORD = "Priya@2006";
const MQTT_TOPIC = "airwatch/#";

let mqttClient = null;

const FEEDS = [
  { key: "mq135", label: "MQ-135", unit: "raw ADC", type: "gas" },
  { key: "mq2", label: "MQ-2", unit: "raw ADC", type: "gas" },
  { key: "temperature", label: "Temperature", unit: "°C", type: "environment" },
  { key: "humidity", label: "Humidity", unit: "% RH", type: "environment" },
  { key: "pressure", label: "Pressure", unit: "hPa", type: "environment" }
];

const THRESHOLDS = {
  mq135: { warning: 2000, critical: 2800 },
  mq2: { warning: 2000, critical: 2800 }
};

const state = {
  latest: {},
  history: {},
  feedStatus: {},
  events: [],
  lastPoll: null,
  apiOk: false,
  loading: false
};

const $ = id => document.getElementById(id);

const fmt = (value, digits = 1) =>
  Number.isFinite(Number(value))
    ? Number(value).toFixed(digits)
    : "—";

const timeText = value => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
};

const dateTimeText = value => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");

  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => el.classList.remove("show"),
    2800
  );
}

function addEvent(type, title, detail) {
  const key = `${type}|${title}|${detail}`;

  if (
    state.events.some(
      e => e.key === key && Date.now() - e.time < 60000
    )
  ) return;

  state.events.unshift({
    key,
    type,
    title,
    detail,
    time: Date.now()
  });

  state.events = state.events.slice(0, 80);
  renderEvents();
}

function setConnection(ok, text) {
  ["sideDot", "topDot"].forEach(id => {
    const el = $(id);
    el.className = "pulse-dot" + (ok ? " good" : " bad");
  });

  $("sideConnection").textContent = text;
  $("topConnection").textContent = text;
}

function showPage(page) {
  document.querySelectorAll(".page").forEach(p =>
    p.classList.toggle(
      "active",
      p.id === `page-${page}`
    )
  );

  document.querySelectorAll(".nav-link[data-page]").forEach(b =>
    b.classList.toggle("active", b.dataset.page === page)
  );

  const titles = {
    overview: "Overview",
    analytics: "Analytics",
    alerts: "Alerts & events",
    device: "Device health",
    reports: "Reports",
    guide: "Sensor guide"
  };

  $("pageTitle").textContent = titles[page] || "Overview";
  $("sidebar").classList.remove("open");

  if (page === "analytics") loadAnalytics();
  if (page === "device") renderDiagnostics();
  if (page === "reports") updateReportStats();
}

document.querySelectorAll(".nav-link[data-page]").forEach(b =>
  b.addEventListener("click", () => showPage(b.dataset.page))
);

document.querySelectorAll("[data-goto]").forEach(b =>
  b.addEventListener("click", () => showPage(b.dataset.goto))
);

$("menuToggle").addEventListener("click", () =>
  $("sidebar").classList.toggle("open")
);

$("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("light");

  localStorage.setItem(
    "airwatch-theme",
    document.body.classList.contains("light")
      ? "light"
      : "dark"
  );
});

if (localStorage.getItem("airwatch-theme") === "light") {
  document.body.classList.add("light");
}

$("dateLabel").textContent = new Date().toLocaleDateString(
  [],
  {
    weekday: "long",
    month: "long",
    day: "numeric"
  }
);

// ---------- MQTT CONNECTION STATUS ----------

function updateConnectionStatus() {
  const connected = !!(mqttClient && mqttClient.connected);

  const good = FEEDS.filter(
    feed => state.feedStatus[feed.key] === "online"
  ).length;

  const all = good === FEEDS.length;

  setConnection(
    connected,
    connected
      ? (all ? "Live · all sensors online" : "Connected · waiting for data")
      : "Connecting to EMQX…"
  );

  $("heroStatus").textContent = connected
    ? (all ? "All sensor feeds live" : `${good} of ${FEEDS.length} feeds received`)
    : "Connecting to EMQX Cloud";

  $("heroTime").textContent = state.lastPoll
    ? `Last update ${timeText(state.lastPoll)}`
    : "Waiting for first message";

  $("sideUpdated").textContent = state.lastPoll
    ? `Last update ${timeText(state.lastPoll)}`
    : "Waiting for data";

  $("statusCloud").textContent = connected
    ? "Connected"
    : "Disconnected";

  $("statusSensors").textContent = `${good} / ${FEEDS.length} feeds`;
  $("statusPoll").textContent = timeText(state.lastPoll);
  $("statusAccount").textContent = "EMQX Cloud";

  $("healthApi").textContent = connected
    ? "Connected"
    : "Disconnected";

  $("healthApiDetail").textContent = connected
    ? "Receiving live MQTT messages"
    : "Check broker, WebSocket port, username and password";

  $("healthAccount").textContent = "EMQX Cloud";
  $("healthPoll").textContent = timeText(state.lastPoll);
  $("healthFeeds").textContent = `${good} / ${FEEDS.length}`;

  $("healthFeedsDetail").textContent = all
    ? "All five topics received"
    : "Waiting for sensor topics";

  $("offlineCount").textContent = FEEDS.length - good;

  $("reportFeeds").textContent = `${good} / ${FEEDS.length}`;

  $("alertNavCount").textContent = state.events.filter(
    e => e.type === "critical" || e.type === "warning"
  ).length;

  renderSensorCards();
  renderDiagnostics();
  updateReportStats();
  drawOverviewChart();
}

// ---------- RECEIVE MQTT MESSAGES ----------

function handleMqttMessage(topic, payload) {
  const key = topic.split("/").pop();

  if (!FEEDS.some(feed => feed.key === key)) return;

  const value = Number(payload.toString());

  if (!Number.isFinite(value)) return;

  const sample = {
    value,
    created_at: new Date().toISOString()
  };

  state.latest[key] = sample;
  state.feedStatus[key] = "online";

  state.history[key] = state.history[key] || [];
  state.history[key].push(sample);

  if (state.history[key].length > 1000) {
    state.history[key].shift();
  }

  state.lastPoll = new Date();
  state.apiOk = true;

  updateConnectionStatus();
  updateAlertsFromReadings();

  if ($("page-analytics").classList.contains("active")) {
    loadAnalytics();
  }
}

// ---------- CONNECT TO EMQX ----------

function connectEMQX() {
  if (typeof mqtt === "undefined") {
    setConnection(false, "MQTT library not loaded");
    $("heroStatus").textContent = "Could not load MQTT library";

    toast("MQTT library failed to load. Check internet/CDN access.");
    return;
  }

  setConnection(false, "Connecting to EMQX…");
  $("heroStatus").textContent = "Connecting to EMQX Cloud";

  mqttClient = mqtt.connect(
    `wss://${MQTT_HOST}:${MQTT_PORT}/mqtt`,
    {
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,

      clientId:
        "airwatch_web_" +
        Math.random().toString(16).slice(2, 10),

      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 3000,
      keepalive: 30
    }
  );

  mqttClient.on("connect", () => {
    mqttClient.subscribe(
      MQTT_TOPIC,
      { qos: 0 },
      error => {
        if (error) {
          setConnection(false, "Subscription failed");

          toast(
            "MQTT subscription failed. Check airwatch/# Subscribe permission."
          );
        } else {
          addEvent(
            "info",
            "EMQX connected",
            "Live MQTT subscription active on airwatch/#."
          );

          updateConnectionStatus();
        }
      }
    );
  });

  mqttClient.on("message", (topic, payload) => {
    handleMqttMessage(topic, payload);
  });

  mqttClient.on("reconnect", () => {
    setConnection(false, "Reconnecting to EMQX…");
  });

  mqttClient.on("offline", () => {
    setConnection(false, "EMQX offline");
  });

  mqttClient.on("error", error => {
    console.error("EMQX MQTT error:", error);
    setConnection(false, "MQTT connection error");
  });
}

// ---------- REFRESH ----------

function pollAll() {
  updateConnectionStatus();

  if (mqttClient && !mqttClient.connected) {
    mqttClient.end(true);
    connectEMQX();
  }
}

// ---------- SENSOR CARDS ----------

function renderSensorCards() {
  FEEDS.forEach(feed => {
    const row = state.latest[feed.key];

    const status =
      state.feedStatus[feed.key] === "online" && row
        ? "ONLINE"
        : "NO DATA";

    $(`state-${feed.key}`).textContent = status;

    $(`state-${feed.key}`).classList.toggle(
      "online",
      status === "ONLINE"
    );

    $(`value-${feed.key}`).textContent = row
      ? fmt(row.value, feed.type === "gas" ? 0 : 1)
      : "—";

    $(`time-${feed.key}`).textContent = row
      ? timeText(row.created_at)
      : "No reading yet";

    const v = row
      ? Math.max(
          0,
          Math.min(
            100,
            row.value /
              (
                feed.type === "gas"
                  ? 4095
                  : feed.key === "temperature"
                    ? 60
                    : feed.key === "humidity"
                      ? 100
                      : 1100
              ) *
              100
          )
        )
      : 0;

    $(`bar-${feed.key}`).style.width = `${v}%`;
  });
}

// ---------- ALERTS ----------

function updateAlertsFromReadings() {
  ["mq135", "mq2"].forEach(key => {
    const row = state.latest[key];
    if (!row) return;

    const t = THRESHOLDS[key];

    if (row.value >= t.critical) {
      addEvent(
        "critical",
        `${key.toUpperCase()} critical threshold`,
        `Raw ADC reading ${Math.round(row.value)} reached the example critical threshold ${t.critical}.`
      );
    } else if (row.value >= t.warning) {
      addEvent(
        "warning",
        `${key.toUpperCase()} warning threshold`,
        `Raw ADC reading ${Math.round(row.value)} reached the example warning threshold ${t.warning}.`
      );
    }
  });

  const warnings = state.events.filter(
    e => e.type === "warning"
  ).length;

  const critical = state.events.filter(
    e => e.type === "critical"
  ).length;

  $("warningCount").textContent = warnings;
  $("criticalCount").textContent = critical;
  $("alertNavCount").textContent = warnings + critical;
}

function renderEvents() {
  const host = $("eventList");

  if (!state.events.length) {
    host.innerHTML =
      '<div class="empty-state">No events recorded yet. Events will appear as readings arrive.</div>';
    return;
  }

  host.innerHTML = state.events.map(e =>
    `<div class="event-item">
      <span class="event-indicator ${e.type}"></span>
      <div class="event-copy">
        <strong>${escapeHtml(e.title)}</strong>
        <p>${escapeHtml(e.detail)}</p>
      </div>
      <span class="event-time">${timeText(e.time)}</span>
    </div>`
  ).join("");
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c])
  );
}

// ---------- DEVICE DIAGNOSTICS ----------

function renderDiagnostics() {
  const host = $("diagnosticList");

  host.innerHTML = FEEDS.map(feed => {
    const online =
      state.feedStatus[feed.key] === "online" &&
      state.latest[feed.key];

    const row = state.latest[feed.key];

    return `<div class="diagnostic-row">
      <strong>${feed.label}</strong>
      <span>${row
        ? `${fmt(row.value, feed.type === "gas" ? 0 : 1)} ${feed.unit}`
        : "No sample"}</span>
      <span class="diag-status ${online ? "good" : "bad"}">
        ${online
          ? `ONLINE · ${timeText(row.created_at)}`
          : "NO DATA / CHECK FEED"}
      </span>
    </div>`;
  }).join("");
}

// ---------- CHARTS ----------

function chart(canvasId, rows, color = "#59d9e8") {
  const canvas = $(canvasId);
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.max(1, rect.width * dpr);
  canvas.height = Math.max(1, rect.height * dpr);

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  ctx.clearRect(0, 0, w, h);

  const pad = { l: 42, r: 10, t: 12, b: 25 };

  const values = rows.map(r => r.value);
  if (!values.length) return;

  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    min -= 1;
    max += 1;
  }

  const x = i =>
    pad.l +
    (rows.length <= 1
      ? 0
      : i / (rows.length - 1)) *
      (w - pad.l - pad.r);

  const y = v =>
    pad.t +
    (max - v) /
      (max - min) *
      (h - pad.t - pad.b);

  ctx.font = "9px DM Mono, monospace";
  ctx.strokeStyle = "rgba(150,175,200,.13)";
  ctx.fillStyle = "#8297ad";
  ctx.lineWidth = 1;

  for (let i = 0; i < 4; i++) {
    const yy =
      pad.t + i * (h - pad.t - pad.b) / 3;

    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(w - pad.r, yy);
    ctx.stroke();

    const val = max - i * (max - min) / 3;
    ctx.fillText(Number(val).toFixed(1), 2, yy + 3);
  }

  const gradient = ctx.createLinearGradient(
    0,
    pad.t,
    0,
    h - pad.b
  );

  gradient.addColorStop(0, color + "44");
  gradient.addColorStop(1, color + "00");

  ctx.beginPath();

  rows.forEach((r, i) => {
    const xx = x(i);
    const yy = y(r.value);

    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });

  ctx.lineTo(x(rows.length - 1), h - pad.b);
  ctx.lineTo(x(0), h - pad.b);
  ctx.closePath();

  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();

  rows.forEach((r, i) => {
    const xx = x(i);
    const yy = y(r.value);

    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  if (rows.length < 40) {
    rows.forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(x(i), y(r.value), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  }

  const first = new Date(rows[0].created_at);
  const last = new Date(rows[rows.length - 1].created_at);

  ctx.fillStyle = "#8297ad";

  ctx.fillText(
    first.toLocaleDateString([], {
      month: "short",
      day: "numeric"
    }),
    pad.l,
    h - 6
  );

  const label = last.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  ctx.fillText(
    label,
    Math.max(
      pad.l,
      w - pad.r - ctx.measureText(label).width
    ),
    h - 6
  );
}

const COLORS = {
  mq135: "#59d9e8",
  mq2: "#b49aff",
  temperature: "#f3c46c",
  humidity: "#67e3ad",
  pressure: "#80aaff"
};

function drawOverviewChart() {
  const key = $("overviewMetric").value;

  const rows =
    state.history[key] ||
    (state.latest[key] ? [state.latest[key]] : []);

  $("overviewEmpty").style.display =
    rows.length ? "none" : "flex";

  chart(
    "overviewChart",
    rows.slice(-100),
    COLORS[key]
  );

  $("overviewRange").textContent =
    `${rows.length} samples`;
}

// ---------- ANALYTICS HISTORY ----------

async function loadHistory(key, limit) {
  return (state.history[key] || []).slice(-limit);
}

async function loadAnalytics() {
  const key = $("analyticsMetric").value;
  const limit = Number($("historyWindow").value);

  $("analyticsEmpty").style.display = "flex";
  $("analyticsEmpty").textContent = "Loading feed history…";

  const rows = await loadHistory(key, limit);

  $("analyticsEmpty").style.display =
    rows.length ? "none" : "flex";

  if (!rows.length) {
    $("analyticsEmpty").textContent =
      "No history available. Wait for the ESP32 to publish readings.";
  }

  chart("analyticsChart", rows, COLORS[key]);

  const values = rows.map(r => r.value);

  $("analyticsLatest").textContent =
    values.length ? fmt(values[values.length - 1], 2) : "—";

  $("analyticsAverage").textContent =
    values.length
      ? fmt(
          values.reduce((a, b) => a + b, 0) / values.length,
          2
        )
      : "—";

  $("analyticsMin").textContent =
    values.length ? fmt(Math.min(...values), 2) : "—";

  $("analyticsMax").textContent =
    values.length ? fmt(Math.max(...values), 2) : "—";

  $("historyCount").textContent =
    `${rows.length} points`;
}

$("analyticsMetric").addEventListener("change", loadAnalytics);
$("historyWindow").addEventListener("change", loadAnalytics);
$("loadHistory").addEventListener("click", loadAnalytics);

$("overviewMetric").addEventListener(
  "change",
  drawOverviewChart
);

$("refreshBtn").addEventListener("click", pollAll);
$("deviceRefresh").addEventListener("click", pollAll);

$("clearAlerts").addEventListener("click", () => {
  state.events = [];
  renderEvents();
  updateAlertsFromReadings();
  toast("Local event log cleared");
});

// ---------- REPORTS ----------

function updateReportStats() {
  const loaded = Object.values(state.history).reduce(
    (n, rows) => n + rows.length,
    0
  );

  $("reportSamples").textContent = loaded;
  $("reportUpdated").textContent = timeText(state.lastPoll);
}

async function prepareAllHistory() {
  toast("Using readings received during this dashboard session.");
  updateReportStats();
}

$("downloadCsv").addEventListener("click", async () => {
  await prepareAllHistory();

  const lines = [
    "feed,label,value,unit,created_at"
  ];

  FEEDS.forEach(feed => {
    const rows =
      state.history[feed.key] ||
      (state.latest[feed.key] ? [state.latest[feed.key]] : []);

    rows.forEach(row => {
      lines.push(
        [
          feed.key,
          feed.label,
          row.value,
          feed.unit,
          row.created_at
        ]
          .map(v =>
            `"${String(v).replace(/"/g, '""')}"`
          )
          .join(",")
      );
    });
  });

  if (lines.length === 1) {
    toast("No feed samples available to export.");
    return;
  }

  const blob = new Blob(
    [lines.join("\n")],
    { type: "text/csv;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download =
    `airwatch-report-${new Date().toISOString().slice(0, 10)}.csv`;

  a.click();
  URL.revokeObjectURL(url);
});

// ---------- RESPONSIVE CHARTS ----------

window.addEventListener("resize", () => {
  drawOverviewChart();

  if ($("page-analytics").classList.contains("active")) {
    const key = $("analyticsMetric").value;

    chart(
      "analyticsChart",
      state.history[key] || [],
      COLORS[key]
    );
  }
});

// ---------- START DASHBOARD ----------

renderEvents();
renderDiagnostics();

const mqttScript = document.createElement("script");

mqttScript.src =
  "https://unpkg.com/mqtt/dist/mqtt.min.js";

mqttScript.onload = () => connectEMQX();

mqttScript.onerror = () => {
  setConnection(false, "MQTT library unavailable");
  $("heroStatus").textContent =
    "Unable to load MQTT library";
};

document.head.appendChild(mqttScript);
