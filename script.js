"use strict";

// ========================================
// Inside My Computer - フロントエンド
// 状態 → 描画 → API通信 → イベント登録の順に整理
// ========================================

const HISTORY_LIMIT = 60;
const SYSTEM_INTERVAL_MS = 1000;
const PROCESS_INTERVAL_MS = 2000;

const CORE_COLORS = [
  "#50b5ff",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#fb7185",
  "#22d3ee",
  "#f97316",
  "#c084fc",
];

// 画面の状態。関数の外で保持することで更新後も値が残る。
let processSort = "cpu";
let selectedProcessPid = null;
let selectedProcessName = null;

// 履歴は新しい測定値が末尾に入る。
const cpuHistory = [];
const memoryHistory = [];
const coreHistory = [];
const diskReadHistory = [];
const diskWriteHistory = [];
const processMemoryHistory = [];

// APIの応答が遅いとき、同じ更新処理を重複実行しない。
let systemUpdating = false;
let processesUpdating = false;

// ========================================
// 共通処理
// ========================================

// HTML要素を取得。存在しない場合はnullを返す。
const element = (id) => document.getElementById(id);

function setText(id, text) {
  const target = element(id);
  if (target) target.textContent = text;
}

function setWidth(id, percent) {
  const target = element(id);
  if (target) target.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function appendHistory(history, value) {
  history.push(value);
  if (history.length > HISTORY_LIMIT) history.shift();
}

// CSS上のサイズに合わせてCanvasの実ピクセル数を調整する。
function prepareCanvas(id) {
  const canvas = element(id);
  if (!canvas) return null;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return null;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

// 複数の履歴グラフで共通して使う描画処理。
function drawHistoryChart(
  id,
  series,
  { maxValue = null, unit = "", left = 55 } = {},
) {
  const surface = prepareCanvas(id);
  if (!surface) return;

  const { ctx, width, height } = surface;
  const top = 20;
  const right = 15;
  const bottom = 28;
  const graphWidth = Math.max(1, width - left - right);
  const graphHeight = Math.max(1, height - top - bottom);

  const values = series.flatMap(({ history }) => history);
  const scaleMax = maxValue ?? Math.max(1, ...values);

  // 横線と目盛り
  ctx.strokeStyle = "#374151";
  ctx.fillStyle = "#9da8b8";
  ctx.font = "12px Arial";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = top + (graphHeight * i) / 4;
    const value = scaleMax * (1 - i / 4);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.fillText(`${value.toFixed(maxValue === 100 ? 0 : 1)}${unit}`, 3, y + 4);
  }

  // 系列ごとの折れ線。横軸は60サンプル分を固定する。
  for (const { history, color } of series) {
    if (history.length === 0) continue;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    history.forEach((value, index) => {
      const x = left + (index / (HISTORY_LIMIT - 1)) * graphWidth;
      const y = top + graphHeight * (1 - value / scaleMax);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

// ========================================
// CPU・RAM・ディスク・プロセスの履歴グラフ
// ========================================

function drawChart() {
  drawHistoryChart(
    "history-chart",
    [
      { history: cpuHistory, color: "#50b5ff" },
      { history: memoryHistory, color: "#a78bfa" },
    ],
    { maxValue: 100, unit: "%", left: 40 },
  );
}

function drawCoreChart() {
  const coreCount = coreHistory[0]?.length ?? 0;
  const series = Array.from({ length: coreCount }, (_, index) => ({
    history: coreHistory.map((sample) => sample[index] ?? 0),
    color: CORE_COLORS[index % CORE_COLORS.length],
  }));
  drawHistoryChart("core-history-chart", series, {
    maxValue: 100,
    unit: "%",
    left: 40,
  });
}

function drawDiskChart() {
  drawHistoryChart(
    "disk-chart",
    [
      { history: diskReadHistory, color: "#50b5ff" },
      { history: diskWriteHistory, color: "#34d399" },
    ],
    { unit: "", left: 55 },
  );
}

function drawProcessMemoryChart() {
  drawHistoryChart(
    "process-memory-chart",
    [{ history: processMemoryHistory, color: "#f59e0b" }],
    { unit: "", left: 55 },
  );
}

// ========================================
// CPUコア表示
// ========================================

function updateCpuCores(cores) {
  const container = element("cpu-cores");
  if (!container) return;
  container.replaceChildren();

  cores.forEach((usage, index) => {
    const row = document.createElement("div");
    row.className = "core-row";

    const name = document.createElement("span");
    name.textContent = `Core ${index}`;

    const bar = document.createElement("div");
    bar.className = "core-bar";
    const fill = document.createElement("div");
    fill.className = "core-fill";
    fill.style.width = `${usage}%`;
    bar.appendChild(fill);

    const value = document.createElement("span");
    value.textContent = `${usage.toFixed(1)}%`;
    row.append(name, bar, value);
    container.appendChild(row);
  });
}

function updateCoreLegend(coreCount) {
  const legend = element("core-legend");
  if (!legend) return;
  legend.replaceChildren();

  for (let index = 0; index < coreCount; index++) {
    const item = document.createElement("div");
    item.className = "core-legend-item";
    const color = document.createElement("span");
    color.className = "core-legend-color";
    color.style.backgroundColor = CORE_COLORS[index % CORE_COLORS.length];
    const label = document.createElement("span");
    label.textContent = `Core ${index}`;
    item.append(color, label);
    legend.appendChild(item);
  }
}

// ========================================
// システム全体の情報を取得・更新
// ========================================

async function updateSystem() {
  if (systemUpdating) return;
  systemUpdating = true;

  try {
    const response = await fetch("/api/system");
    if (!response.ok) throw new Error(`System API: ${response.status}`);
    const data = await response.json();

    // CPUとRAM
    setText("cpu", `${data.cpu.toFixed(1)}%`);
    setText("memory", `${data.memory.toFixed(1)}%`);
    setWidth("cpu-bar", data.cpu);
    setWidth("memory-bar", data.memory);
    setText(
      "memory-detail",
      `${data.memory_unavailable} / ${data.memory_total} GiB`,
    );
    setText("memory-available", `Available: ${data.memory_available} GiB`);

    appendHistory(cpuHistory, data.cpu);
    appendHistory(memoryHistory, data.memory);
    drawChart();

    // CPUコア
    if (Array.isArray(data.cores)) {
      updateCpuCores(data.cores);
      updateCoreLegend(data.cores.length);
      appendHistory(coreHistory, [...data.cores]);
      drawCoreChart();
    }

    // Swap
    setText("swap", `${data.swap_percent.toFixed(1)}%`);
    setWidth("swap-bar", data.swap_percent);
    setText("swap-detail", `${data.swap_used} / ${data.swap_total} GiB`);
    setText("swap-in", `Swap In: ${data.swap_in_speed.toFixed(2)} MiB/s`);
    setText("swap-out", `Swap Out: ${data.swap_out_speed.toFixed(2)} MiB/s`);

    // macOSのメモリプレッシャー
    const pressure = data.memory_pressure ?? "UNKNOWN";
    const pressureColors = {
      NORMAL: "#22c55e",
      WARN: "#eab308",
      CRITICAL: "#ef4444",
      UNKNOWN: "#9da8b8",
    };
    setText("memory-pressure", pressure);
    const pressureElement = element("memory-pressure");
    if (pressureElement) {
      pressureElement.style.color =
        pressureColors[pressure] ?? pressureColors.UNKNOWN;
    }

    // Disk I/O
    setText("disk-read", `${data.disk_read_speed.toFixed(2)} MiB/s`);
    setText("disk-write", `${data.disk_write_speed.toFixed(2)} MiB/s`);
    appendHistory(diskReadHistory, data.disk_read_speed);
    appendHistory(diskWriteHistory, data.disk_write_speed);
    drawDiskChart();

    // Network I/O（現行コードは数値表示のみ）
    setText(
      "network-download",
      `${data.network_download_speed.toFixed(2)} MiB/s`,
    );
    setText("network-upload", `${data.network_upload_speed.toFixed(2)} MiB/s`);

    setText("status", "接続中・1秒ごとに更新");
  } catch (error) {
    setText("status", "接続エラー");
    console.error("システム情報の取得に失敗:", error);
  } finally {
    systemUpdating = false;
  }
}

// ========================================
// プロセスの選択・RSS履歴
// ========================================

function selectProcess(proc) {
  // PIDが変わったら以前のプロセスの履歴を消す。
  // 比較はPIDを上書きする前に行うのが重要。
  if (selectedProcessPid !== proc.pid) {
    processMemoryHistory.length = 0;
    drawProcessMemoryChart();
  }

  selectedProcessPid = proc.pid;
  selectedProcessName = proc.name;

  setText("selected-process-name", selectedProcessName);
  setText("selected-process-pid", `PID: ${selectedProcessPid}`);
  setText(
    "process-memory-label",
    `${selectedProcessName} (PID: ${selectedProcessPid})`,
  );

  // 表示中のテーブルの選択色を切り替える。
  const tbody = element("process-list");
  if (!tbody) return;
  tbody.querySelectorAll("tr").forEach((row) => {
    row.classList.toggle(
      "selected",
      Number(row.dataset.pid) === selectedProcessPid,
    );
  });
}

function recordSelectedProcess(processes) {
  if (selectedProcessPid === null) return;

  // 現行APIは上位10件のみ。見つからない間は記録を止める。
  const selected = processes.find((proc) => proc.pid === selectedProcessPid);
  if (!selected || selected.rss_mib == null) return;

  appendHistory(processMemoryHistory, selected.rss_mib);
  drawProcessMemoryChart();
}

function renderProcesses(processes) {
  const tbody = element("process-list");
  if (!tbody) return;
  tbody.replaceChildren();

  processes.forEach((proc) => {
    const row = document.createElement("tr");
    row.dataset.pid = String(proc.pid);
    row.classList.toggle("selected", proc.pid === selectedProcessPid);
    row.addEventListener("click", () => selectProcess(proc));

    const values = [
      proc.name,
      proc.pid,
      `${proc.cpu.toFixed(1)}%`,
      `${proc.memory.toFixed(1)}%`,
      proc.rss_mib == null ? "N/A" : proc.rss_mib.toFixed(1),
    ];

    // textContentならプロセス名をHTMLとして解釈しない。
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.appendChild(cell);
    });
    tbody.appendChild(row);
  });
}

async function updateProcesses() {
  if (processesUpdating) return;
  processesUpdating = true;

  try {
    const response = await fetch(`/api/processes?sort=${processSort}`);
    if (!response.ok) throw new Error(`Processes API: ${response.status}`);
    const processes = await response.json();

    recordSelectedProcess(processes);
    renderProcesses(processes);
  } catch (error) {
    console.error("プロセス取得失敗:", error);
  } finally {
    processesUpdating = false;
  }
}

// ========================================
// ボタン操作・初期化
// ========================================

function changeProcessSort(sort) {
  processSort = sort;
  element("sort-cpu")?.classList.toggle("active", sort === "cpu");
  element("sort-rss")?.classList.toggle("active", sort === "rss");
  updateProcesses();
}

function redrawAllCharts() {
  drawChart();
  drawCoreChart();
  drawDiskChart();
  drawProcessMemoryChart();
}

// script.jsを</body>直前で読み込む構成を想定。
// DOMが準備できてからイベントを登録する。
function initialize() {
  element("sort-cpu")?.addEventListener("click", () =>
    changeProcessSort("cpu"),
  );
  element("sort-rss")?.addEventListener("click", () =>
    changeProcessSort("rss"),
  );
  window.addEventListener("resize", redrawAllCharts);

  updateSystem();
  updateProcesses();
  setInterval(updateSystem, SYSTEM_INTERVAL_MS);
  setInterval(updateProcesses, PROCESS_INTERVAL_MS);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}
