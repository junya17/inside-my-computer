import psutil
import time
from fastapi import FastAPI
from fastapi.responses import FileResponse

# Webアプリケーションを作成する
app = FastAPI()

# 前回のスワップ統計を保存
previous_swap = psutil.swap_memory()

# 前回の測定時刻
previous_swap_time = time.monotonic()


# ブラウザのトップページを返す
@app.get("/")
def home():
    return FileResponse("index.html")


# CPU・メモリ情報をJSON形式で返すAPI
@app.get("/api/system")
def get_system_info():

    # 論理CPUごとの使用率をリストで取得
    core_usage = psutil.cpu_percent(interval=None, percpu=True)

    # 前回の呼び出しからのCPU使用率を取得
    # 初回の値は参考値として扱う
    cpu = psutil.cpu_percent(interval=None)

    # メモリ情報をOSから取得
    memory = psutil.virtual_memory()

    # Pythonの辞書を返すとFastAPIがJSONに変換す

    # macOSのスワップメモリ情報を取得
    swap = psutil.swap_memory()

    # 前回の測定値を更新するため、グローバル変数を使用
    global previous_swap, previous_swap_time

    # 現在のスワップ統計と時刻
    current_swap = psutil.swap_memory()
    current_time = time.monotonic()

    # 前回からの経過秒数
    elapsed = max(current_time - previous_swap_time, 0.001)

    # 累積カウンターの差分から転送速度を計算
    swap_in_speed = max(0, current_swap.sin - previous_swap.sin) / elapsed / (1024**2)
    swap_out_speed = (
        max(0, current_swap.sout - previous_swap.sout) / elapsed / (1024**2)
    )

    # 次回の計算のために今回の値を保存
    previous_swap = current_swap
    previous_swap_time = current_time

    return {
        "cpu": cpu,
        "memory": memory.percent,
        "cores": core_usage,
        # 物理メモリの総容量
        "memory_total": round(memory.total / (1024**3), 2),
        # psutilが報告する使用中メモリ
        "memory_used": round(memory.used / (1024**3), 2),
        # 新しく追加：利用可能なメモリ
        "memory_available": round(memory.available / (1024**3), 2),
        # 新しく追加：利用可能量を引いた容量
        "memory_unavailable": round((memory.total - memory.available) / (1024**3), 2),
        # スワップ領域の総容量（GiB）
        "swap_total": round(swap.total / (1024**3), 2),
        # 現在使用中のスワップ容量（GiB）
        "swap_used": round(swap.used / (1024**3), 2),
        # スワップ使用率（%）
        "swap_percent": swap.percent,
        # 1秒あたりのスワップ読み込み速度
        "swap_in_speed": round(swap_in_speed, 2),
        # 1秒あたりのスワップ書き込み速度
        "swap_out_speed": round(swap_out_speed, 2),
    }


# プロセスごとのCPU使用率を記録するための辞書
# キーはPID（プロセスID）
previous_cpu_times = {}


@app.get("/api/processes")
def get_processes():

    global previous_cpu_times

    processes = []
    current_cpu_times = {}

    # 前回の測定時刻からの経過時間を計算
    import time

    now = time.monotonic()

    # OSから実行中のプロセスを取得
    for proc in psutil.process_iter(["pid", "name", "memory_percent", "create_time"]):
        try:
            info = proc.info

            # プロセスのCPU時間を取得
            cpu_times = proc.cpu_times()
            cpu_total = cpu_times.user + cpu_times.system

            # PIDと作成時刻の組み合わせで識別
            key = (info["pid"], info["create_time"])

            # 前回のCPU時間と比較する
            previous = previous_cpu_times.get(key)

            cpu_percent = 0.0

            if previous is not None:
                old_cpu, old_time = previous
                elapsed = now - old_time

                if elapsed > 0:
                    cpu_percent = max(0.0, (cpu_total - old_cpu) / elapsed * 100)

            # 次回の測定に使用する
            current_cpu_times[key] = (cpu_total, now)

            processes.append(
                {
                    "pid": info["pid"],
                    "name": info["name"] or "Unknown",
                    "cpu": round(cpu_percent, 1),
                    "memory": round(info["memory_percent"] or 0, 1),
                }
            )

        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            # 終了したプロセスや権限のないプロセスは無視
            continue

    # 古い測定値を新しいものに置き換える
    previous_cpu_times = current_cpu_times

    # CPU使用率が高い順に並べ替え
    processes.sort(key=lambda p: p["cpu"], reverse=True)

    # 上位10件を返す
    return processes[:10]
