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
let selectedProcessCreateTime = null;

// ========================================
// Thread Inspectorの状態管理
// ========================================

// 前回測定したスレッドごとのCPU時間
// キー: TID
// 値: User + System CPU Time（秒）
const previousThreadCpuTimes = new Map();

// 前回の測定時刻（ミリ秒）
let previousThreadSampleTime = null;

// API通信の重複を防止する
let threadUpdating = false;

// プロセス切り替え時に古い通信結果を無効化する
let threadSelectionVersion = 0;

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

// ========================================
// Process Inspector 表示補助
// ========================================

// プロセスの詳細表示を初期化する
function clearInspector() {
  setText("inspector-rss", "-- MiB");
  setText("inspector-vms", "-- GiB");
  setText("inspector-threads", "--");
  setText("inspector-status", "--");
  setText("inspector-user-time", "-- s");
  setText("inspector-system-time", "-- s");
}

// ========================================
// Thread Inspectorの初期化
// ========================================

function clearThreadInspector() {
  // 前回のCPU時間を削除
  previousThreadCpuTimes.clear();

  // 前回の測定時刻を削除
  previousThreadSampleTime = null;

  // 通信中の古い結果を無効化
  threadSelectionVersion++;

  // 表の行を削除
  element("thread-list")?.replaceChildren();

  // 表示を初期化
  setText(
    "thread-inspector-status",
    "Select a process to inspect its threads.",
  );
}

// MiBをGiBに変換する
function mibToGib(mib) {
  return (mib / 1024).toFixed(2);
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

function selectProcess(process) {
  // PIDだけでなく作成時刻も比較する
  const changed =
    selectedProcessPid !== process.pid ||
    selectedProcessCreateTime !== process.create_time;

  // 別のプロセスを選んだ場合は履歴を初期化
  if (changed) {
    processMemoryHistory.length = 0;

    // 前のプロセスの詳細情報を削除
    clearInspector();

    // 前のプロセスのスレッド履歴も削除
    clearThreadInspector();
  }

  // 選択中のプロセス情報を保存
  selectedProcessPid = process.pid;
  selectedProcessCreateTime = process.create_time;
  selectedProcessName = process.name;

  // 表示を更新
  setText("selected-process-name", process.name);
  setText("selected-process-pid", `PID: ${process.pid}`);

  // グラフのラベルを更新
  setText("process-memory-label", `${process.name} - RSS Memory`);

  drawProcessMemoryChart();
}

function renderProcesses(processes) {
  const tbody = element("process-list");
  if (!tbody) return;

  // 既存の行を削除する
  tbody.replaceChildren();

  // プロセスごとに表の行を作成
  processes.forEach((proc) => {
    const row = document.createElement("tr");
    row.dataset.pid = String(proc.pid);

    // 行をクリックしたら監視対象にする
    row.addEventListener("click", () => selectProcess(proc));

    // PIDと作成時刻が一致したら選択状態にする
    row.classList.toggle(
      "selected",
      proc.pid === selectedProcessPid &&
        proc.create_time === selectedProcessCreateTime,
    );

    // 表示するプロセス情報
    const values = [
      proc.name,
      proc.pid,
      `${proc.cpu.toFixed(1)}%`,
      `${proc.memory.toFixed(1)}%`,
      proc.rss_mib == null ? "N/A" : proc.rss_mib.toFixed(1),
    ];

    // 各項目をセルに追加
    values.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = String(value);
      row.appendChild(cell);
    });

    // 完成した行をテーブルに追加
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
  setInterval(updateSelectedProcess, 2000);
  // Thread Inspectorを2秒ごとに更新
  setInterval(updateThreads, 2000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
} else {
  initialize();
}

// ========================================
// 選択したプロセスを継続監視
// ========================================

let processDetailUpdating = false;

async function updateSelectedProcess() {
  // プロセスが選択されていなければ何もしない
  if (selectedProcessPid === null) return;

  // 通信が重複しないようにする
  if (processDetailUpdating) return;

  processDetailUpdating = true;

  // 通信開始時の監視対象を記憶する
  const pid = selectedProcessPid;
  const createTime = selectedProcessCreateTime;

  try {
    // Process Inspector APIから詳細情報を取得
    const response = await fetch(`/api/processes/${pid}/inspect`);

    // プロセス終了やアクセス拒否を検出
    // プロセスが終了していた場合
    if (response.status === 404) {
      // 通信中に別のプロセスが選択されていないか確認
      if (
        selectedProcessPid === pid &&
        selectedProcessCreateTime === createTime
      ) {
        setText("process-memory-label", "監視対象のプロセスが終了しました");

        // ★ ここに追加
        clearInspector();
        clearThreadInspector();
        setText("selected-process-name", "No process selected");
        setText("selected-process-pid", "Process ended");

        selectedProcessPid = null;
        selectedProcessCreateTime = null;
        selectedProcessName = null;
      }

      return;
    }

    // その他のHTTPエラー
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    // JSONをJavaScriptのオブジェクトへ変換
    const process = await response.json();

    // 通信中に別のプロセスが選択されていたら無視する
    if (
      selectedProcessPid !== pid ||
      selectedProcessCreateTime !== createTime
    ) {
      return;
    }

    // ========================================
    // デバッグ：プロセス作成時刻を比較
    // ========================================

    console.log("Process identity check", {
      pid: pid,
      selectedCreateTime: createTime,
      inspectorCreateTime: process.create_time,
      difference: process.create_time - createTime,
    });

    // PIDが再利用されていないか確認
    if (process.create_time !== createTime) {
      setText("process-memory-label", "監視対象のプロセスが終了しました");

      // ★ ここに追加
      clearInspector();
      clearThreadInspector();
      setText("selected-process-name", "No process selected");
      setText("selected-process-pid", "Process ended");

      selectedProcessPid = null;
      selectedProcessCreateTime = null;
      selectedProcessName = null;

      return;
    }

    // ========================================
    // Process Inspector 詳細表示
    // ========================================

    // 物理RAM上に存在するメモリ量
    setText("inspector-rss", `${process.rss_mib.toFixed(2)} MiB`);

    // 仮想メモリをMiBからGiBに変換
    setText("inspector-vms", `${mibToGib(process.vms_mib)} GiB`);

    // スレッド数
    setText("inspector-threads", String(process.threads));

    // プロセスの状態
    setText("inspector-status", process.status);

    // ユーザーモードの累積CPU時間
    setText("inspector-user-time", `${process.cpu_times.user.toFixed(3)} s`);

    // カーネルモードの累積CPU時間
    setText(
      "inspector-system-time",
      `${process.cpu_times.system.toFixed(3)} s`,
    );

    // 新しいRSS値を履歴に追加
    appendHistory(processMemoryHistory, process.rss_mib);

    // グラフを再描画
    drawProcessMemoryChart();
  } catch (error) {
    // 監視対象が変わっていない場合だけエラーを表示
    if (
      selectedProcessPid === pid &&
      selectedProcessCreateTime === createTime
    ) {
      // 取得失敗時は古い数値を表示しない
      clearInspector();
      setText(
        "process-memory-label",
        `プロセス情報を取得できません: ${error.message}`,
      );
    }
  } finally {
    // 次の通信を許可する
    processDetailUpdating = false;
  }
}

// ========================================
// Thread Inspector
// ========================================

async function updateThreads() {
  // プロセスが選択されていなければ終了
  if (selectedProcessPid === null) return;

  // API通信の重複を防止
  if (threadUpdating) return;

  threadUpdating = true;

  // 通信開始時の監視対象を保存
  const pid = selectedProcessPid;
  const createTime = selectedProcessCreateTime;
  const version = threadSelectionVersion;

  try {
    // 指定したプロセスのスレッド一覧を取得
    const response = await fetch(`/api/processes/${pid}/threads`);

    // HTTPエラーを確認
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // 通信中に別のプロセスが選択された場合は破棄
    if (
      selectedProcessPid !== pid ||
      selectedProcessCreateTime !== createTime ||
      threadSelectionVersion !== version
    ) {
      return;
    }

    // PIDの再利用を検出
    if (data.create_time !== createTime) {
      clearThreadInspector();
      setText("thread-inspector-status", "Process identity changed.");
      return;
    }

    // 今回の測定時刻を取得
    // performance.now()は経過時間の測定に適した時計
    const now = performance.now();

    // 前回からの経過時間（秒）
    const elapsed =
      previousThreadSampleTime === null
        ? null
        : (now - previousThreadSampleTime) / 1000;

    // 新しい測定値を保存するMap
    const currentTimes = new Map();

    // スレッド一覧の表示領域
    const tbody = element("thread-list");
    if (!tbody) return;

    // 古い表を削除
    tbody.replaceChildren();

    for (const thread of data.threads) {
      // 各スレッドの累積CPU時間
      const totalCpuTime = thread.user_time + thread.system_time;

      // 今回の値を記録
      currentTimes.set(thread.tid, totalCpuTime);

      // 前回のCPU時間
      const previous = previousThreadCpuTimes.get(thread.tid);

      // 初回はCPU使用率を計算できない
      let cpuPercent = null;

      if (previous !== undefined && elapsed !== null && elapsed > 0) {
        // CPU時間の増加量
        const delta = totalCpuTime - previous;

        // CPU使用率を計算
        // 100% = 論理CPU 1個分の処理能力
        if (delta >= 0) {
          cpuPercent = (delta / elapsed) * 100;
        }
      }

      // HTMLの行を作成
      const row = document.createElement("tr");

      const values = [
        String(thread.tid),
        `${thread.user_time.toFixed(3)} s`,
        `${thread.system_time.toFixed(3)} s`,
        cpuPercent === null ? "--" : `${cpuPercent.toFixed(1)}%`,
      ];

      // 各値をセルに追加
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });

      // CPU使用率のバーを追加
      const cpuCell = row.lastElementChild;

      if (cpuCell && cpuPercent !== null) {
        const bar = document.createElement("div");
        bar.className = "thread-cpu-bar";

        const fill = document.createElement("div");
        fill.className = "thread-cpu-fill";

        // 表示上の幅だけ100%を上限にする
        fill.style.width = `${Math.min(100, Math.max(0, cpuPercent))}%`;

        bar.appendChild(fill);
        cpuCell.appendChild(bar);
      }

      tbody.appendChild(row);
    }

    // 今回の値を次回測定用に保存
    previousThreadCpuTimes.clear();

    for (const [tid, cpuTime] of currentTimes) {
      previousThreadCpuTimes.set(tid, cpuTime);
    }

    previousThreadSampleTime = now;

    setText(
      "thread-inspector-status",
      `${data.name} · PID ${pid} · ${data.thread_count} threads`,
    );
  } catch (error) {
    // 選択対象が変わっていない場合だけエラー表示
    if (
      selectedProcessPid === pid &&
      selectedProcessCreateTime === createTime &&
      threadSelectionVersion === version
    ) {
      // 通信失敗後は差分計算をやり直す
      previousThreadCpuTimes.clear();
      previousThreadSampleTime = null;

      setText(
        "thread-inspector-status",
        `Thread data unavailable: ${error.message}`,
      );
    }
  } finally {
    threadUpdating = false;
  }
}
