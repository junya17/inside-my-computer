// FIX_SCRIPT_V1_APPLIED
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
// Process CPU Timeline：状態管理
// ========================================

// CPU履歴の最大保存数
const PROCESS_CPU_HISTORY_LIMIT = 60;

// プロセス全体のCPU使用率履歴
const processCpuHistory = [];

// 前回の累積CPU時間（秒）
let previousProcessCpuTime = null;

// 前回の測定時刻（ミリ秒）
let previousProcessCpuTimestamp = null;

// 監視対象の識別子
// PIDだけでなく作成時刻も含める
let processCpuIdentity = null;

// ========================================
// Thread Inspectorの状態管理
// ========================================

// 前回測定したスレッドごとのCPU時間
// キー: TID
// 値: User + System CPU Time（秒）
const previousThreadCpuTimes = new Map();

// ========================================
// Thread Inspector：アクセス拒否の管理
// ========================================

// スレッド詳細へのアクセスが拒否された
// プロセスの識別子を保持する
let threadAccessDeniedIdentity = null;

// 前回の測定時刻（ミリ秒）
let previousThreadSampleTime = null;

// API通信の重複を防止する
let threadUpdating = false;

// プロセス切り替え時に古い通信結果を無効化する
let threadSelectionVersion = 0;

// ========================================
// Thread CPU Timelineの状態
// ========================================

// スレッドごとのCPU使用率履歴
// Map<TID, Array<CPU使用率>>
const threadCpuHistory = new Map();

/* ========================================
   Thread State Timeline
   スレッド状態の履歴を保存
   ======================================== */

// Key: スレッドID
// Value: 状態番号の配列
const threadStateHistory = new Map();

// Thread CPU Timelineの測定時刻
// performance.now()で取得したミリ秒を保存する
const threadSampleTimes = [];

// スレッドごとの最新CPU使用率
// Map<TID, CPU使用率>
const latestThreadCpuPercents = new Map();

// スレッドごとの描画色を保持
const threadColors = new Map();

// Timelineに表示するスレッドの上限
const THREAD_DISPLAY_LIMIT = 8;

// スレッドIDに割り当てる色の順番
let nextThreadColorIndex = 0;

// 履歴全体の測定回数
let threadHistorySamples = 0;

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

  // 別プロセスの状態履歴が混ざらないようにする
  threadStateHistory.clear();

  // State Timelineも初期状態に戻す
  drawThreadStateTimeline();

  // Timelineの履歴も初期化
  threadCpuHistory.clear();
  threadColors.clear();
  // プロセス切り替え時に時刻と最新値もリセット
  threadSampleTimes.length = 0;
  latestThreadCpuPercents.clear();
  nextThreadColorIndex = 0;
  threadHistorySamples = 0;

  // Timelineの表示を初期化
  setText("thread-timeline-status", "Select a process to start monitoring.");

  // 凡例を削除
  element("thread-cpu-legend")?.replaceChildren();

  // グラフを空の状態に戻す
  drawThreadCpuTimeline();
}

function drawThreadStateTimeline() {
  // Canvasを取得
  const canvas = document.getElementById("thread-state-chart");
  if (!canvas) return;

  // Retinaディスプレイにも対応
  const surface = prepareCanvas("thread-state-chart");
  if (!surface) return;

  const { ctx, width, height } = surface;

  const left = 145;
  const right = 25;
  const top = 25;
  const rowHeight = 30;
  const graphWidth = width - left - right;

  if (graphWidth <= 0) return;

  // macOSのスレッド状態に対応する色
  const stateColors = {
    1: "#22c55e", // Runnable
    2: "#94a3b8", // Stopped
    3: "#f59e0b", // Waiting
    4: "#ef4444", // Uninterruptible
    5: "#64748b", // Halted
  };

  const entries = [...threadStateHistory.entries()].slice(
    0,
    THREAD_DISPLAY_LIMIT,
  );

  ctx.font = "12px sans-serif";
  ctx.fillStyle = "#aab4c4";

  if (entries.length === 0 || threadSampleTimes.length === 0) {
    ctx.fillText("Waiting for thread samples...", 20, 35);
    return;
  }

  // CPU Timelineと共通の測定時刻
  const latestTime = threadSampleTimes.at(-1);

  entries.forEach(([tid, history], rowIndex) => {
    const y = top + rowIndex * rowHeight;

    // スレッドIDを表示
    ctx.fillStyle = "#aab4c4";
    ctx.fillText(`TID ${tid}`, 8, y + 15);

    // 各サンプルの状態を描画
    history.forEach((state, sampleIndex) => {
      if (state === null || state === undefined) return;

      const sampleTime = threadSampleTimes[sampleIndex];
      if (sampleTime === undefined) return;

      // 現在のサンプル位置
      const age = latestTime - sampleTime;
      const x = left + (1 - age / 120000) * graphWidth;

      // 前回のサンプル位置
      const previousTime = threadSampleTimes[sampleIndex - 1];

      // 初回は細い矩形で描画
      let startX = x - 4;

      if (previousTime !== undefined) {
        const previousAge = latestTime - previousTime;
        startX = left + (1 - previousAge / 120000) * graphWidth;
      }

      // 表示範囲に収める
      const clippedStart = Math.max(left, startX);
      const clippedEnd = Math.min(left + graphWidth, x);

      // 今回観測した状態の色
      ctx.fillStyle = stateColors[state] ?? "#64748b";

      // 帯状に描画
      if (clippedEnd > clippedStart) {
        ctx.fillRect(clippedStart, y, clippedEnd - clippedStart, 18);
      } else if (x >= left && x <= left + graphWidth) {
        // 初回サンプル
        ctx.fillRect(x - 2, y, 4, 18);
      }
    });
  });

  // 時間軸
  ctx.fillStyle = "#aab4c4";
  ctx.textAlign = "left";
  ctx.fillText("-120s", left, height - 12);
  ctx.textAlign = "right";
  ctx.fillText("Now", width - right, height - 12);
  ctx.textAlign = "left";
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
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  // 親要素の幅を基準にする
  // Canvas自身の異常な幅を参照しない
  const parent = canvas.parentElement;

  if (!parent) return null;

  const width = Math.min(parent.clientWidth, 1000);

  // CSS上の高さ
  const height = 300;

  if (width <= 0) return null;

  // 表示サイズを明示的に固定
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  // Retinaディスプレイ対応
  const dpr = window.devicePixelRatio || 1;

  // 内部解像度を設定
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);

  // 必要な場合だけ変更
  if (canvas.width !== pixelWidth) {
    canvas.width = pixelWidth;
  }

  if (canvas.height !== pixelHeight) {
    canvas.height = pixelHeight;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // CSSピクセル単位で描画
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 前回の描画を消去
  ctx.clearRect(0, 0, width, height);

  return { ctx, width, height };
}

// 複数の履歴グラフで共通して使う描画処理。
function drawHistoryChart(
  id,
  series,
  {
    maxValue = null,
    unit = "",
    left = 55,
    timestamps = null, // 実際の測定時刻（ms）
  } = {},
) {
  const surface = prepareCanvas(id);
  if (!surface) return;

  const { ctx, width, height } = surface;
  const top = 20;
  const right = 15;
  const bottom = 28;
  const graphWidth = Math.max(1, width - left - right);
  const graphHeight = Math.max(1, height - top - bottom);

  // 欠測値（null）を除外して最大値を計算する
  const values = series
    .flatMap(({ history }) => history)
    .filter(Number.isFinite);
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

  // 描画順を制御する
  // 実線を先に描き、破線を後から描画する
  const orderedSeries = series
    .map((item, index) => ({
      ...item,
      dashed: index % 2 === 1,
    }))
    .sort((a, b) => Number(a.dashed) - Number(b.dashed));

  for (const { history, color, dashed } of orderedSeries) {
    if (history.length === 0) continue;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    // 偶数番目は実線、奇数番目は破線
    ctx.setLineDash(dashed ? [7, 5] : []);

    // 破線は少し太くして重なっても見やすくする
    ctx.lineWidth = dashed ? 2.5 : 2;

    // 前の点と線でつなげるかどうか
    let hasPreviousPoint = false;

    history.forEach((value, index) => {
      // nullや不正な値は描画しない
      if (!Number.isFinite(value)) {
        hasPreviousPoint = false;
        return;
      }

      // 通常のグラフは従来どおりサンプル番号で配置
      let x = left + (index / (HISTORY_LIMIT - 1)) * graphWidth;

      // 時刻配列が渡された場合は実時間で配置
      if (timestamps && timestamps.length > 0) {
        // 最新の測定時刻を右端にする
        const latestTime = timestamps[timestamps.length - 1];

        // 横軸は直近120秒
        const windowMs = 120_000;

        // その測定が何ミリ秒前かを求める
        const ageMs = latestTime - timestamps[index];

        // 120秒前を左端、最新を右端にする
        x = left + (1 - ageMs / windowMs) * graphWidth;

        // 表示範囲外の古い点は線をつながない
        if (x < left) {
          hasPreviousPoint = false;
          return;
        }
      }
      const y = top + graphHeight * (1 - value / scaleMax);

      // 欠測値の後は新しい線を開始
      if (!hasPreviousPoint) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      hasPreviousPoint = true;
    });

    // 次の描画に破線設定を引き継がない
    ctx.stroke();

    ctx.setLineDash([]);
  }
  // ========================================
  // 実時間を使うグラフだけ横軸の目盛りを表示
  // ========================================
  if (timestamps && timestamps.length > 0) {
    ctx.fillStyle = "#9da8b8";
    ctx.font = "11px Arial";
    ctx.textAlign = "center";

    // 120秒前から現在まで30秒刻み
    const labels = [
      { seconds: 120, text: "-120s" },
      { seconds: 90, text: "-90s" },
      { seconds: 60, text: "-60s" },
      { seconds: 30, text: "-30s" },
      { seconds: 0, text: "Now" },
    ];

    for (const label of labels) {
      // 左から右への位置を計算
      const x = left + (1 - label.seconds / 120) * graphWidth;

      ctx.fillText(label.text, x, height - 8);
    }
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
// スレッドCPU使用率の履歴を記録
// ========================================

function recordThreadCpuHistory(samples, sampleTime) {
  // samples: Map<TID, CPU使用率>
  // sampleTime: performance.now()で取得した測定時刻（ms）

  // 全スレッド共通の測定時刻を記録
  threadSampleTimes.push(sampleTime);

  // 最大60サンプルだけ保持
  if (threadSampleTimes.length > HISTORY_LIMIT) {
    threadSampleTimes.shift();
  }

  // 今回の測定番号を更新
  threadHistorySamples++;

  // 現在存在しているスレッドID
  const activeTids = new Set(samples.keys());

  // 終了したスレッドの履歴を削除
  for (const tid of threadCpuHistory.keys()) {
    if (!activeTids.has(tid)) {
      threadCpuHistory.delete(tid);
      threadColors.delete(tid);
      latestThreadCpuPercents.delete(tid);
    }
  }

  // 各スレッドのCPU使用率を記録
  for (const [tid, cpuPercent] of samples) {
    // 新しく見つかったスレッド
    if (!threadCpuHistory.has(tid)) {
      // 以前の測定時刻に対応する部分は欠測値
      const emptyHistory = Array(threadSampleTimes.length - 1).fill(null);

      threadCpuHistory.set(tid, emptyHistory);

      // スレッド固有の表示色を割り当てる
      threadColors.set(
        tid,
        CORE_COLORS[nextThreadColorIndex % CORE_COLORS.length],
      );

      nextThreadColorIndex++;
    }

    const history = threadCpuHistory.get(tid);

    // 今回のCPU使用率を保存
    history.push(cpuPercent);

    // 最大60個に制限
    if (history.length > HISTORY_LIMIT) {
      history.shift();
    }

    // 最新値を保存
    latestThreadCpuPercents.set(tid, cpuPercent);
  }
}

// ========================================
// Thread CPU Timelineの描画
// ========================================

function drawThreadCpuTimeline() {
  // CPU使用率の履歴を系列に変換
  const entries = [...threadCpuHistory.entries()]
    .sort((a, b) => {
      // 累積履歴内の最大CPU使用率が高い順
      const maxA = Math.max(0, ...a[1].filter(Number.isFinite));

      const maxB = Math.max(0, ...b[1].filter(Number.isFinite));

      return maxB - maxA;
    })
    .slice(0, THREAD_DISPLAY_LIMIT);

  // 描画に必要なデータを作成
  const series = entries.map(([tid, history]) => ({
    tid,
    history,
    color: threadColors.get(tid) ?? "#50b5ff",
  }));

  // 表示対象のスレッドから最大CPU使用率を取得
  const maximumCpu = Math.max(
    0,
    ...series.flatMap((item) => item.history.filter(Number.isFinite)),
  );

  // 通常は105%を上限にする
  // 105%を超える値が出た場合だけ縦軸を拡張する
  const scaleMax = maximumCpu <= 105 ? 105 : Math.ceil(maximumCpu / 25) * 25;

  // 実際の測定時刻を使ってグラフを描画
  drawHistoryChart("thread-cpu-chart", series, {
    maxValue: scaleMax,
    unit: "%",
    left: 55,
    timestamps: threadSampleTimes,
  });

  // 凡例を更新
  const legend = element("thread-cpu-legend");
  if (!legend) return;

  legend.replaceChildren();

  for (const [index, item] of series.entries()) {
    const container = document.createElement("div");
    container.className = "thread-legend-item";

    const color = document.createElement("span");
    color.className = "thread-legend-color";
    color.style.backgroundColor = item.color;

    const label = document.createElement("span");
    // 最新CPU使用率を取得
    const latestCpu = latestThreadCpuPercents.get(item.tid);

    // CPU使用率の文字列を作成
    const cpuText = Number.isFinite(latestCpu)
      ? `${latestCpu.toFixed(1)}%`
      : "--";

    // 線種も表示する
    const lineType = index % 2 === 1 ? "Dashed" : "Solid";

    // TID・CPU使用率・線種
    label.textContent = `TID ${item.tid} · ${cpuText} · ${lineType}`;

    container.append(color, label);
    legend.appendChild(container);
  }
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

    // プロセスCPU履歴も初期化
    resetProcessCpuHistory();

    // 新しいプロセスではThread APIを再試行する
    threadAccessDeniedIdentity = null;
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
  drawThreadCpuTimeline();
  drawProcessCpuTimeline();
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

        // 終了したプロセスの情報を初期化
        clearInspector();
        clearThreadInspector();
        resetProcessCpuHistory();
        threadAccessDeniedIdentity = null;
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

      // PID再利用時は古い履歴を破棄する
      clearInspector();
      clearThreadInspector();
      resetProcessCpuHistory();
      threadAccessDeniedIdentity = null;
      setText("selected-process-name", "No process selected");
      setText("selected-process-pid", "Process ended");

      selectedProcessPid = null;
      selectedProcessCreateTime = null;
      selectedProcessName = null;

      return;
    }

    // PIDと作成時刻の検証が済んだプロセスを記録
    recordProcessCpuSample(process);

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
    // PIDと作成時刻でプロセスを識別
    const threadIdentity = `${pid}:${createTime}`;

    // 以前403が返ったプロセスなら再取得しない
    // if (threadAccessDeniedIdentity === threadIdentity) {
    //   return;
    // }

    // 指定したプロセスのスレッド一覧を取得
    const response = await fetch(`/api/processes/${pid}/threads`);

    // 403の場合は同じプロセスへの再リクエストを停止
    if (response.status === 403) {
      // 通信中に選択対象が変わっていないか確認
      if (
        selectedProcessPid !== pid ||
        selectedProcessCreateTime !== createTime ||
        threadSelectionVersion !== version
      ) {
        return;
      }

      // アクセス拒否されたプロセスを記録
      // threadAccessDeniedIdentity = threadIdentity;

      // 古いスレッド情報を消去
      previousThreadCpuTimes.clear();
      previousThreadSampleTime = null;
      element("thread-list")?.replaceChildren();

      // 画面にアクセス制限を表示
      setText(
        "thread-inspector-status",
        "Thread details unavailable (macOS access restriction)",
      );

      setText(
        "thread-timeline-status",
        "Thread CPU Timeline unavailable: access denied",
      );

      return;
    }

    // 403以外のHTTPエラー
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
    // 今回のスレッドCPU使用率を保存するMap
    const currentCpuPercents = new Map();

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
      // CPU使用率をTimeline用に記録
      // 初回など計算できない場合はnull
      currentCpuPercents.set(thread.tid, cpuPercent);
      // HTMLの行を作成
      const row = document.createElement("tr");

      const values = [
        String(thread.tid),

        // User CPU累積時間
        `${thread.user_time.toFixed(3)} s`,

        // System CPU累積時間
        `${thread.system_time.toFixed(3)} s`,

        // スレッドのCPU使用率
        cpuPercent === null ? "--" : `${cpuPercent.toFixed(1)}%`,

        // macOSから取得したスレッド状態
        getThreadStateLabel(thread.run_state),
      ];

      // 各値をセルに追加
      values.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });

      // CPU使用率は4番目の列（インデックス3）
      const cpuCell = row.children[3];

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

    // ========================================
    // Thread CPU Timelineを更新
    // ========================================

    // 今回のCPU使用率を履歴に記録
    // CPU使用率と今回の測定時刻を一緒に記録

    // CPU使用率の履歴を保存
    recordThreadCpuHistory(currentCpuPercents, now);

    // 今回追加：スレッド状態の履歴を保存
    recordThreadStateHistory(data.threads);

    // CPU Timelineを再描画
    drawThreadCpuTimeline();

    // State Timelineを再描画
    drawThreadStateTimeline();

    /* ========================================
   スレッド状態の履歴を記録する
   ======================================== */

    function recordThreadStateHistory(threads) {
      // 今回取得できたスレッドID
      const activeIds = new Set(threads.map((thread) => thread.tid));

      // 終了したスレッドの履歴を削除
      for (const tid of threadStateHistory.keys()) {
        if (!activeIds.has(tid)) {
          threadStateHistory.delete(tid);
        }
      }

      // CPU Timelineと同じ時刻履歴の長さ
      const sampleCount = threadSampleTimes.length;

      for (const thread of threads) {
        // 新規スレッドの履歴は過去分をnullで埋める
        if (!threadStateHistory.has(thread.tid)) {
          threadStateHistory.set(thread.tid, Array(sampleCount - 1).fill(null));
        }

        const history = threadStateHistory.get(thread.tid);

        // 今回の状態を追加
        history.push(thread.run_state);

        console.log(
          "Thread State:",
          thread.tid,
          thread.run_state,
          "History:",
          history.length,
        );

        // CPU Timelineと同じ長さに保つ
        while (history.length > sampleCount) {
          history.shift();
        }
      }
    }

    // Timelineの状態表示
    setText(
      "thread-timeline-status",
      `${data.name} · PID ${pid} · Last ${Math.min(
        threadHistorySamples,
        HISTORY_LIMIT,
      )} samples`,
    );

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

// ========================================
// macOSのスレッド状態を文字列に変換
// ========================================
function getThreadStateLabel(runState) {
  const states = {
    1: "Runnable",
    2: "Stopped",
    3: "Waiting",
    4: "Uninterruptible",
    5: "Halted",
  };

  // 未知の値にも対応する
  return states[runState] ?? `Unknown (${runState})`;
}

// ========================================
// Process CPU Timeline：初期化
// ========================================

function resetProcessCpuHistory() {
  // 保存済みのCPU履歴を削除
  processCpuHistory.length = 0;

  // 前回の測定値を破棄
  previousProcessCpuTime = null;
  previousProcessCpuTimestamp = null;
  processCpuIdentity = null;

  // 表示を初期化
  const status = document.getElementById("process-cpu-status");

  if (status) {
    status.textContent = "Select a process to start monitoring.";
  }

  // グラフを空に戻す
  drawProcessCpuTimeline();
}

// ========================================
// Process CPU Timeline：履歴の記録
// ========================================

function recordProcessCpuSample(process) {
  // PIDと作成時刻を組み合わせて識別する
  const identity = `${process.pid}:${process.create_time}`;

  // 別のプロセスなら測定状態をリセット
  if (processCpuIdentity !== identity) {
    resetProcessCpuHistory();
    processCpuIdentity = identity;
  }

  // APIから累積CPU時間を取得
  const userTime = Number(process.cpu_times?.user);
  const systemTime = Number(process.cpu_times?.system);

  // 不正な値を履歴に入れない
  if (!Number.isFinite(userTime) || !Number.isFinite(systemTime)) {
    return;
  }

  // UserとSystemのCPU時間を合計
  const totalCpuTime = userTime + systemTime;

  // 単調増加する時計で測定時刻を取得
  const now = performance.now();

  // 初回は比較対象がないため記録しない
  if (previousProcessCpuTime !== null && previousProcessCpuTimestamp !== null) {
    // CPU時間の増加量（秒）
    const deltaCpu = totalCpuTime - previousProcessCpuTime;

    // 実際の経過時間（秒）
    const elapsed = (now - previousProcessCpuTimestamp) / 1000;

    // CPU使用率を計算
    if (elapsed > 0 && deltaCpu >= 0) {
      const cpuPercent = (deltaCpu / elapsed) * 100;

      // 最新の使用率を履歴へ追加
      processCpuHistory.push(cpuPercent);

      // 最大60サンプルを維持
      if (processCpuHistory.length > PROCESS_CPU_HISTORY_LIMIT) {
        processCpuHistory.shift();
      }

      // 状態表示を更新
      const status = document.getElementById("process-cpu-status");

      if (status) {
        status.textContent =
          `${process.name} · PID ${process.pid}` +
          ` · CPU ${cpuPercent.toFixed(1)}%`;
      }
    }
  }

  // 次の測定に備えて保存
  previousProcessCpuTime = totalCpuTime;
  previousProcessCpuTimestamp = now;

  // グラフを再描画
  drawProcessCpuTimeline();
}

// ========================================
// Process CPU Timeline：Canvas描画
// ========================================

function drawProcessCpuTimeline() {
  const canvas = document.getElementById("process-cpu-chart");

  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Retinaディスプレイの解像度に対応
  const ratio = window.devicePixelRatio || 1;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  if (width <= 0 || height <= 0) return;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  // CSSピクセル単位で描画できるようにする
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  // 既存の描画内容を消去
  ctx.clearRect(0, 0, width, height);

  // グラフの余白
  const left = 48;
  const right = 16;
  const top = 16;
  const bottom = 30;

  const graphWidth = width - left - right;
  const graphHeight = height - top - bottom;

  if (graphWidth <= 0 || graphHeight <= 0) return;

  // CPU使用率は100%を超える場合がある
  // 最大値に応じて縦軸を自動調整する
  const maxCpu = Math.max(100, ...processCpuHistory);

  const scaleMax = Math.ceil(maxCpu / 50) * 50;

  // 横方向の補助線と目盛り
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";

  for (let i = 0; i <= 4; i++) {
    const value = (scaleMax / 4) * i;

    const y = top + graphHeight * (1 - i / 4);

    ctx.beginPath();
    ctx.strokeStyle = "rgba(150,150,150,0.20)";
    ctx.lineWidth = 1;
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();

    ctx.fillStyle = "#888";
    ctx.fillText(`${value.toFixed(0)}%`, left - 8, y + 4);
  }

  // データがない場合はここで終了
  if (processCpuHistory.length === 0) return;

  // CPU履歴の折れ線を描画
  ctx.beginPath();
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";

  processCpuHistory.forEach((cpu, index) => {
    // 最大60サンプル分の横軸に配置
    const x = left + (index / (PROCESS_CPU_HISTORY_LIMIT - 1)) * graphWidth;

    const y = top + graphHeight * (1 - cpu / scaleMax);

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
}

// ========================================
// macOSのスレッド状態を表示用文字列に変換
// ========================================
function getThreadStateLabel(runState) {
  const states = {
    1: "Runnable",
    2: "Stopped",
    3: "Waiting",
    4: "Uninterruptible",
    5: "Halted",
  };

  // 未知の値が返された場合も表示できるようにする
  return states[runState] ?? `Unknown (${runState})`;
}
