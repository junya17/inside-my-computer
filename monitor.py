
import psutil

# CPUとメモリの状態を繰り返し表示する
while True:

    # 1秒間のCPU使用率を取得する
    cpu = psutil.cpu_percent(interval=1)

    # メモリの使用状況を取得する
    memory = psutil.virtual_memory()

    # 取得した情報を表示する
    print(f"CPU使用率: {cpu:.1f}%")
    print(f"メモリ使用率: {memory.percent:.1f}%")

    print("----------------------")
