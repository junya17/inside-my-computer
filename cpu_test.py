
import time

# CPUに計算させる時間（秒）
DURATION = 5

# 経過時間の測定にはmonotonicを使用
start = time.monotonic()

# 計算回数を数える
count = 0
result = 0

print("CPU負荷テスト開始")

# 約5秒間、計算を繰り返す
while time.monotonic() - start < DURATION:

    # CPUで整数演算を実行
    result += count * count

    # カウンターを増やす
    count += 1

print("CPU負荷テスト終了")
print(f"計算回数: {count:,}")
print(f"計算結果: {result}")
