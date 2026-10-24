import psutil
from fastapi import FastAPI
from fastapi.responses import FileResponse

# Webアプリケーションを作成する
app = FastAPI()


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

    # Pythonの辞書を返すとFastAPIがJSONに変換する
    return {
        "cpu": cpu,
        "memory": memory.percent,
        "cores": core_usage,
        "memory_total": round(memory.total / (1024**3), 2),
        "memory_used": round(memory.used / (1024**3), 2),
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
