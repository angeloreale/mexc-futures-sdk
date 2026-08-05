// ── Preload bridge (available as window.botAPI) ──
const api = window.botAPI;

// ── All config field IDs in the form ──────────
var CONFIG_FIELDS = [
  "MEXC_KEY", "MEXC_SECRET_KEY", "MEXC_AUTH_TOKEN",
  "TELEGRAM_BOT_TOKEN", "ALLOWED_CHANNELS",
  "DEFAULT_LEVERAGE", "OPEN_TYPE",
  "RISK_PERCENT", "DEFAULT_TP_RATIO",
  "MAX_CONCURRENT_TRADES", "MAX_NOTIONAL_PER_TRADE",
  "DRY_RUN", "TRADING_ENABLED",
  "LOG_LEVEL", "BASE_CURRENCY",
  "ORDER_RATE_CAPACITY", "ORDER_RATE_INTERVAL_MS",
  "PNL_NOTIFICATION_CHANNEL", "POSITION_MONITOR_INTERVAL_SECONDS",
  "SUMMARY_NOTIFICATION_CHANNEL", "SUMMARY_INTERVAL_HOURS", "SUMMARY_WINDOW_HOURS",
  "SIGNAL_RESOLVER_CHANNELS", "SIGNAL_RESOLVER_INTERVAL_SECONDS",
  "LOG_RETENTION_DAYS",
];

// ── UI Elements ────────────────────────────────
var statusIndicator = document.getElementById("status-indicator");
var statusText = document.getElementById("status-text");
var modeBadge = document.getElementById("mode-badge");
var btnStart = document.getElementById("btn-start");
var btnStop = document.getElementById("btn-stop");
var btnSave = document.getElementById("btn-save");
var btnClear = document.getElementById("btn-clear-logs");
var btnOpenLogs = document.getElementById("btn-open-logs");
var btnOpenConfig = document.getElementById("btn-open-config-dir");
var saveStatus = document.getElementById("save-status");
var logOutput = document.getElementById("log-output");
var personaToggle = document.getElementById("persona-toggle");
var providerFields = document.getElementById("provider-fields");

// ── Tab Switching ──────────────────────────────
var tabs = document.querySelectorAll(".tab");
var tabContents = document.querySelectorAll(".tab-content");
tabs.forEach(function (tab) {
  tab.addEventListener("click", function () {
    tabs.forEach(function (t) { t.classList.remove("active"); });
    tab.classList.add("active");
    tabContents.forEach(function (c) { c.classList.remove("active"); });
    var target = document.getElementById("tab-" + tab.dataset.tab);
    if (target) target.classList.add("active");
  });
});

// ── Persona Toggle ──────────────────────────────
personaToggle.addEventListener("change", function () {
  var isProvider = personaToggle.checked;
  if (isProvider) {
    providerFields.classList.add("visible");
  } else {
    providerFields.classList.remove("visible");
  }
  // Update label highlights
  document.querySelectorAll(".persona-label").forEach(function (lbl) {
    var role = lbl.dataset.role;
    lbl.classList.toggle("active", (role === "provider") === isProvider);
  });
});

// ── Logging ─────────────────────────────────────
function appendLog(text) {
  var line = document.createElement("div");
  line.className = "log-line";
  line.textContent = text;
  logOutput.appendChild(line);
  logOutput.scrollTop = logOutput.scrollHeight;

  // Keep only last 2000 lines
  while (logOutput.children.length > 2000) {
    logOutput.firstChild.remove();
  }
}

// ── Status Display ──────────────────────────────
function setStatus(status) {
  var map = {
    stopped:  { text: "Stopped",  cls: "status-stopped" },
    starting: { text: "Starting…", cls: "status-starting" },
    running:  { text: "Running",  cls: "status-running" },
    stopping: { text: "Stopping…", cls: "status-stopping" },
    error:    { text: "Error",    cls: "status-error" },
    "missing-config": { text: "Config Required", cls: "status-missing-config" },
  };
  var info = map[status] || map.stopped;
  statusText.textContent = info.text;
  statusIndicator.className = info.cls;
  updateButtons(status);
}

function updateButtons(status) {
  var isStopped = status === "stopped" || status === "missing-config" || status === "error";
  btnStart.disabled = !isStopped;
  btnStop.disabled = status !== "running";
}

// ── Config Persistence ──────────────────────────
function loadConfig() {
  api.getConfig().then(function (config) {
    CONFIG_FIELDS.forEach(function (field) {
      var el = document.getElementById(field);
      if (el && config[field] !== undefined) {
        el.value = config[field];
      }
    });
    updateModeBadge();
  }).catch(function (err) {
    console.error("Failed to load config:", err);
  });
}

function collectConfig() {
  var config = {};
  CONFIG_FIELDS.forEach(function (field) {
    var el = document.getElementById(field);
    if (el && el.value.trim()) {
      config[field] = el.value.trim();
    }
  });
  return config;
}

function updateModeBadge() {
  var dryRunEl = document.getElementById("DRY_RUN");
  var tradingEl = document.getElementById("TRADING_ENABLED");
  var dryRun = dryRunEl ? dryRunEl.value : "false";
  var trading = tradingEl ? tradingEl.value : "true";
  if (dryRun === "true") {
    modeBadge.textContent = "DRY RUN";
    modeBadge.style.background = "#d2991d33";
    modeBadge.style.color = "#d2991d";
  } else if (trading === "false") {
    modeBadge.textContent = "TRADING OFF";
    modeBadge.style.background = "#f8514933";
    modeBadge.style.color = "#f85149";
  } else {
    modeBadge.textContent = "LIVE";
    modeBadge.style.background = "#3fb95033";
    modeBadge.style.color = "#3fb950";
  }
}

// ── Event Listeners ─────────────────────────────
btnSave.addEventListener("click", function () {
  var config = collectConfig();
  if (!config.TELEGRAM_BOT_TOKEN) {
    saveStatus.textContent = "⚠️ TELEGRAM_BOT_TOKEN is required!";
    saveStatus.style.color = "var(--danger)";
    return;
  }
  if (!config.MEXC_KEY && !config.MEXC_AUTH_TOKEN) {
    saveStatus.textContent = "⚠️ MEXC_KEY or MEXC_AUTH_TOKEN is required!";
    saveStatus.style.color = "var(--danger)";
    return;
  }
  if (!config.ALLOWED_CHANNELS) {
    saveStatus.textContent = "⚠️ ALLOWED_CHANNELS is required!";
    saveStatus.style.color = "var(--danger)";
    return;
  }
  api.saveConfig(config).then(function () {
    saveStatus.textContent = "✅ Configuration saved!";
    saveStatus.style.color = "var(--success)";
    updateButtons("stopped");
    btnStart.disabled = false;
    updateModeBadge();
    setTimeout(function () { saveStatus.textContent = ""; }, 3000);
  }).catch(function (err) {
    saveStatus.textContent = "❌ Save failed: " + err.message;
    saveStatus.style.color = "var(--danger)";
  });
});

btnStart.addEventListener("click", function () {
  logOutput.innerHTML = "";
  appendLog("Starting Dupip Crypto Connector...");
  api.startBot().catch(function (err) {
    appendLog("❌ Failed to start: " + err.message);
  });
});

btnStop.addEventListener("click", function () {
  appendLog("Stopping...");
  api.stopBot().catch(function (err) {
    appendLog("❌ Failed to stop: " + err.message);
  });
});

btnClear.addEventListener("click", function () {
  logOutput.innerHTML = '<div class="log-line muted">Logs cleared.</div>';
});

btnOpenLogs.addEventListener("click", function () { api.openLogDir(); });

if (btnOpenConfig) {
  btnOpenConfig.addEventListener("click", function () { api.openConfigDir(); });
}

// Listen for config field changes to update badge
var configForm = document.getElementById("config-form");
if (configForm) {
  configForm.addEventListener("change", function (e) {
    if (e.target.id === "DRY_RUN" || e.target.id === "TRADING_ENABLED") {
      updateModeBadge();
    }
  });
}

// ── Bot Event Listener ──────────────────────────
api.onBotEvent(function (event) {
  if (event.channel === "log") {
    appendLog(event.data);
  } else if (event.channel === "status") {
    setStatus(event.data);
  }
});

// ── Init ────────────────────────────────────────
(function () {
  loadConfig();
  api.getBotStatus().then(function (status) {
    setStatus(status);
    if (status === "running") {
      appendLog("Dupip Crypto Connector is already running — output will appear below.");
    }
  }).catch(function (err) {
    console.error("Failed to get bot status:", err);
    setStatus("stopped");
  });
})();
