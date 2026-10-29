import os
import time
import json
import subprocess
from pathlib import Path
import psutil
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import FileResponse


# ========================================
# 1. 基本設定
# ========================================

app = FastAPI(title="Inside My Computer")

# app.py が存在するディレクトリ
BASE_DIR = Path(__file__).resolve().parent
# macOSのスレッド情報を取得するC言語の実行ファイル
LIBPROC_HELPER = BASE_DIR / "native" / "libproc_threads_json"

# 単位変換
MIB = 1024**2
GIB = 1024**3

# 前回の測定結果を保存
previous_disk = None
previous_disk_time = None

previous_network = None
previous_network_time = None

previous_swap = None
previous_swap_time = None

# プロセスのCPU時間を保存
# キー: (PID, 作成時刻)
# 値: (CPU累積時間, 測定時刻)
previous_cpu_times = {}


# ========================================
# 2. 共通関数
# ========================================


def bytes_to_mib(value):
    """バイトをMiBに変換する"""
    return round(value / MIB, 2)


def bytes_to_gib(value):
    """バイトをGiBに変換する"""
    return round(value / GIB, 2)


def calculate_speed(current, previous, elapsed):
    """
    累積カウンターの差分からMiB/秒を計算する。

    current : 今回の累積バイト数
    previous: 前回の累積バイト数
    elapsed : 経過秒数
    """
    if elapsed <= 0:
        return 0.0

    difference = max(0, current - previous)
    return round(difference / elapsed / MIB, 2)


# ========================================
# 3. Disk I/O
# ========================================


def get_disk_speed():
    global previous_disk, previous_disk_time

    current = psutil.disk_io_counters()
    now = time.monotonic()

    # ディスク情報が取得できない場合
    if current is None:
        return {
            "read_speed": 0.0,
            "write_speed": 0.0,
        }

    # 初回は比較対象がないため0を返す
    if previous_disk is None:
        previous_disk = current
        previous_disk_time = now

        return {
            "read_speed": 0.0,
            "write_speed": 0.0,
        }

    elapsed = now - previous_disk_time

    # 累積バイト数の差分から速度を計算
    read_speed = calculate_speed(
        current.read_bytes,
        previous_disk.read_bytes,
        elapsed,
    )

    write_speed = calculate_speed(
        current.write_bytes,
        previous_disk.write_bytes,
        elapsed,
    )

    # 次回のために測定値を更新
    previous_disk = current
    previous_disk_time = now

    return {
        "read_speed": read_speed,
        "write_speed": write_speed,
    }


# ========================================
# 4. Network I/O
# ========================================


def get_network_speed():
    global previous_network, previous_network_time

    current = psutil.net_io_counters()
    now = time.monotonic()

    # ネットワーク情報が取得できない場合
    if current is None:
        return {
            "download": 0.0,
            "upload": 0.0,
        }

    if previous_network is None:
        previous_network = current
        previous_network_time = now

        return {
            "download": 0.0,
            "upload": 0.0,
        }

    elapsed = now - previous_network_time

    download = calculate_speed(
        current.bytes_recv,
        previous_network.bytes_recv,
        elapsed,
    )

    upload = calculate_speed(
        current.bytes_sent,
        previous_network.bytes_sent,
        elapsed,
    )

    previous_network = current
    previous_network_time = now

    return {
        "download": download,
        "upload": upload,
    }


# ========================================
# 5. Swap I/O
# ========================================


def get_swap_info():
    global previous_swap, previous_swap_time

    current = psutil.swap_memory()
    now = time.monotonic()

    swap_in_speed = 0.0
    swap_out_speed = 0.0

    if previous_swap is not None:
        elapsed = now - previous_swap_time

        swap_in_speed = calculate_speed(
            current.sin,
            previous_swap.sin,
            elapsed,
        )

        swap_out_speed = calculate_speed(
            current.sout,
            previous_swap.sout,
            elapsed,
        )

    # 今回の測定値を保存
    previous_swap = current
    previous_swap_time = now

    return {
        "swap_total": bytes_to_gib(current.total),
        "swap_used": bytes_to_gib(current.used),
        "swap_percent": current.percent,
        "swap_in_speed": swap_in_speed,
        "swap_out_speed": swap_out_speed,
    }


# ========================================
# 6. macOS Memory Pressure
# ========================================


def get_memory_pressure():
    """macOSのメモリプレッシャーを取得する"""

    try:
        result = subprocess.run(
            [
                "sysctl",
                "-n",
                "kern.memorystatus_vm_pressure_level",
            ],
            capture_output=True,
            text=True,
            timeout=2,
            check=True,
        )

        level = int(result.stdout.strip())

        states = {
            1: "NORMAL",
            2: "WARN",
            4: "CRITICAL",
        }

        return states.get(level, "UNKNOWN")

    except (OSError, ValueError, subprocess.SubprocessError):
        return "UNKNOWN"


# ========================================
# 7. HTML・CSS・JavaScript
# ========================================


@app.get("/")
def home():
    """トップページを返す"""
    return FileResponse(BASE_DIR / "index.html")


@app.get("/style.css")
def get_css():
    """CSSファイルを返す"""
    return FileResponse(
        BASE_DIR / "style.css",
        media_type="text/css",
    )


@app.get("/script.js")
def get_javascript():
    """JavaScriptファイルを返す"""
    return FileResponse(
        BASE_DIR / "script.js",
        media_type="text/javascript",
    )


# ========================================
# 8. システム情報API
# ========================================


@app.get("/api/system")
def get_system_info():
    """CPU・RAM・Swap・Disk・Networkの情報を返す"""

    # CPU使用率
    cpu = psutil.cpu_percent(interval=None)
    cores = psutil.cpu_percent(interval=None, percpu=True)

    # 物理メモリ
    memory = psutil.virtual_memory()

    # 各種I/O情報
    swap = get_swap_info()
    disk = get_disk_speed()
    network = get_network_speed()

    return {
        # CPU
        "cpu": cpu,
        "cores": cores,
        # RAM
        "memory": memory.percent,
        "memory_total": bytes_to_gib(memory.total),
        "memory_used": bytes_to_gib(memory.used),
        "memory_available": bytes_to_gib(memory.available),
        "memory_unavailable": bytes_to_gib(memory.total - memory.available),
        # Swap
        **swap,
        # Memory Pressure
        "memory_pressure": get_memory_pressure(),
        # Disk I/O
        "disk_read_speed": disk["read_speed"],
        "disk_write_speed": disk["write_speed"],
        # Network I/O
        "network_download_speed": network["download"],
        "network_upload_speed": network["upload"],
    }


# ========================================
# 9. プロセス情報API
# ========================================


@app.get("/api/processes")
def get_processes(
    sort: str = Query(
        default="cpu",
        pattern="^(cpu|rss)$",
    ),
):
    """
    プロセスごとのCPU・メモリ使用量を取得する。

    sort=cpu : CPU使用率順
    sort=rss : RSS使用量順
    """

    global previous_cpu_times

    processes = []
    current_cpu_times = {}

    now = time.monotonic()

    # OSから実行中のプロセスを列挙
    for proc in psutil.process_iter(
        [
            "pid",
            "name",
            "memory_percent",
            "memory_info",
            "create_time",
        ]
    ):
        try:
            info = proc.info

            # ----------------------------------------
            # CPU使用率の計算
            # ----------------------------------------

            cpu_times = proc.cpu_times()
            cpu_total = cpu_times.user + cpu_times.system

            # PIDの再利用を考慮して作成時刻も使う
            key = (
                info["pid"],
                info["create_time"],
            )

            previous = previous_cpu_times.get(key)

            cpu_percent = 0.0

            if previous is not None:
                old_cpu, old_time = previous
                elapsed = now - old_time

                if elapsed > 0:
                    cpu_percent = max(
                        0.0,
                        (cpu_total - old_cpu) / elapsed * 100,
                    )

            # 次回のCPU計算用に保存
            current_cpu_times[key] = (
                cpu_total,
                now,
            )

            # ----------------------------------------
            # RSS（物理メモリ使用量）
            # ----------------------------------------

            memory_info = info.get("memory_info")

            rss_mib = (
                round(memory_info.rss / MIB, 1) if memory_info is not None else None
            )

            # ----------------------------------------
            # プロセス情報を追加
            # ----------------------------------------

            processes.append(
                {
                    "pid": info["pid"],
                    "name": info["name"] or "Unknown",
                    # PIDの再利用を判定するための作成時刻
                    "create_time": info["create_time"],
                    "cpu": round(cpu_percent, 1),
                    "memory": round(
                        info["memory_percent"] or 0,
                        1,
                    ),
                    "rss_mib": rss_mib,
                }
            )

        except (
            psutil.NoSuchProcess,
            psutil.AccessDenied,
            psutil.ZombieProcess,
        ):
            # 終了したプロセスや権限のないものは飛ばす
            continue

    # CPU時間の測定結果を更新
    previous_cpu_times = current_cpu_times

    # ----------------------------------------
    # 並び順を切り替える
    # ----------------------------------------

    if sort == "rss":
        # RSSが取得できないプロセスは最後にする
        processes.sort(
            key=lambda p: (
                p["rss_mib"] is not None,
                p["rss_mib"] if p["rss_mib"] is not None else 0,
            ),
            reverse=True,
        )

    else:
        processes.sort(
            key=lambda p: p["cpu"],
            reverse=True,
        )

    # 上位10プロセスを返す
    return processes[:10]


# ========================================
# 10. 個別プロセス監視API
# ========================================


@app.get("/api/processes/{pid}")
def get_process_detail(pid: int):
    """
    PIDを指定してプロセス情報を取得する。
    Top 10の順位には影響されない。
    """

    try:
        # PIDを指定してプロセスを取得
        process = psutil.Process(pid)

        # プロセスの物理メモリ使用量
        memory = process.memory_info()

        # プロセスが作られた時刻
        create_time = process.create_time()

        # ブラウザへJSON形式で返す
        return {
            "pid": pid,
            "name": process.name(),
            "create_time": create_time,
            "rss_mib": round(memory.rss / MIB, 1),
        }

    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        # プロセスが終了した場合
        raise HTTPException(
            status_code=404,
            detail="Process not found",
        )

    except psutil.AccessDenied:
        # OSがアクセスを許可しなかった場合
        raise HTTPException(
            status_code=403,
            detail="Access denied",
        )


# ========================================
# 11. Process Inspector API
# ========================================


@app.get("/api/processes/{pid}/inspect")
def inspect_process(pid: int):
    """
    指定したPIDの詳細情報を取得する。
    Process Inspector画面で使用する。
    """

    try:
        # PIDからプロセスオブジェクトを取得
        process = psutil.Process(pid)

        # プロセスのメモリ情報
        memory = process.memory_info()

        # CPUの累積実行時間
        cpu_times = process.cpu_times()

        # プロセスの詳細情報をJSONで返す
        return {
            "pid": pid,
            # プロセス名
            "name": process.name(),
            # PID再利用を検出するための作成時刻
            "create_time": process.create_time(),
            # プロセスの状態
            "status": process.status(),
            # 物理メモリ使用量（MiB）
            "rss_mib": round(memory.rss / MIB, 2),
            # 仮想メモリサイズ（MiB）
            "vms_mib": round(memory.vms / MIB, 2),
            # OSスレッド数
            "threads": process.num_threads(),
            # 累積CPU時間（秒）
            "cpu_times": {
                "user": cpu_times.user,
                "system": cpu_times.system,
            },
        }

    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        # プロセスが存在しない場合
        raise HTTPException(
            status_code=404,
            detail="Process not found",
        )

    except psutil.AccessDenied:
        # macOSが情報取得を拒否した場合
        raise HTTPException(
            status_code=403,
            detail="Access denied",
        )


# ========================================
# 12. Thread Inspector（macOS libproc版）
# ========================================


@app.get("/api/processes/{pid}/threads")
def inspect_threads(pid: int):
    """
    C言語のlibprocヘルパーを呼び出して、
    指定プロセスのOSスレッド情報を取得する。
    """

    # PIDの簡単な入力検証
    if pid <= 0:
        raise HTTPException(
            status_code=400,
            detail="Invalid PID",
        )

    try:
        # プロセスの存在と基本情報を確認
        process = psutil.Process(pid)

        # PID再利用を検出するため、作成時刻を記録
        create_time = process.create_time()
        name = process.name()

        # C言語の実行ファイルを子プロセスとして起動
        # stdout: JSONデータ
        # stderr: エラーメッセージ
        result = subprocess.run(
            [str(LIBPROC_HELPER), str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

        # Cプログラムが失敗した場合
        if result.returncode != 0:
            raise HTTPException(
                status_code=403,
                detail={
                    "message": "libproc could not read threads",
                    "error": result.stderr.strip(),
                },
            )

        # JSON文字列をPythonの辞書に変換
        data = json.loads(result.stdout)

        # Cヘルパーが返したPIDを確認
        if data["pid"] != pid:
            raise HTTPException(
                status_code=502,
                detail="Helper returned a different PID",
            )

        # PIDが途中で再利用されていないか確認
        if process.create_time() != create_time:
            raise HTTPException(
                status_code=409,
                detail="Process identity changed",
            )

        # 既存のJavaScriptが期待する形式に変換
        thread_list = []

        for thread in data["threads"]:
            thread_list.append(
                {
                    "tid": thread["id"],
                    "user_time": thread["user_time"],
                    "system_time": thread["system_time"],
                    "run_state": thread["run_state"],
                }
            )

        return {
            "pid": pid,
            "name": name,
            "create_time": create_time,
            # 詳細取得できたスレッド数
            "thread_count": len(thread_list),
            # OSが列挙したスレッド数
            "enumerated_thread_count": data["thread_count"],
            "threads": thread_list,
        }

    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        raise HTTPException(
            status_code=404,
            detail="Process not found",
        )

    except psutil.AccessDenied:
        raise HTTPException(
            status_code=403,
            detail="Access denied",
        )

    except subprocess.TimeoutExpired:
        raise HTTPException(
            status_code=504,
            detail="libproc helper timed out",
        )

    except OSError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not launch libproc helper: {exc}",
        )

    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        raise HTTPException(
            status_code=502,
            detail="Invalid JSON from libproc helper",
        )


# ========================================
# 13. サーバープロセスの情報
# ========================================


@app.get("/api/debug/server")
def debug_server():
    """
    現在APIリクエストを処理している
    PythonプロセスのPIDを取得する。
    """

    return {
        "pid": os.getpid(),
        "ppid": os.getppid(),
    }

    # ========================================


# 14. サーバー自身のスレッド情報
# ========================================


@app.get("/api/debug/threads")
def debug_threads():
    """
    FastAPIサーバー自身のOSスレッドを取得する。
    """

    # 現在のプロセス自身を取得
    process = psutil.Process(os.getpid())

    # OSスレッド一覧を取得
    threads = process.threads()

    return {
        "pid": process.pid,
        "thread_count": len(threads),
        "threads": [
            {
                "tid": thread.id,
                "user_time": thread.user_time,
                "system_time": thread.system_time,
            }
            for thread in threads
        ],
    }
