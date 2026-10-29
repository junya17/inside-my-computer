
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>
#include <limits.h>
#include <string.h>
#include <libproc.h>
#include <sys/proc_info.h>

int main(int argc, char *argv[]) {

    // PIDを受け取る
    if (argc != 2) {
        fprintf(stderr, "Usage: %s <PID>\n", argv[0]);
        return 1;
    }

    char *end = NULL;
    errno = 0;
    long value = strtol(argv[1], &end, 10);

    // 不正なPIDを拒否
    if (errno != 0 || end == argv[1] ||
        *end != '\0' || value <= 0 ||
        value > INT_MAX) {
        fprintf(stderr, "Invalid PID\n");
        return 1;
    }

    pid_t pid = (pid_t)value;

    // 最大4096スレッド分のバッファ
    const size_t max_threads = 4096;
    size_t capacity = max_threads * sizeof(uint64_t);

    uint64_t *thread_ids = malloc(capacity);

    if (thread_ids == NULL) {
        perror("malloc");
        return 1;
    }

    // libprocからスレッドID一覧を取得
    int bytes = proc_pidinfo(
        pid,
        PROC_PIDLISTTHREADS,
        0,
        thread_ids,
        (int)capacity
    );

    if (bytes <= 0) {
        perror("PROC_PIDLISTTHREADS");
        free(thread_ids);
        return 1;
    }

    // 取得したIDの数を計算
    int count = bytes / sizeof(uint64_t);

    // JSONの開始
    printf("{\n");
    printf("  \"pid\": %d,\n", pid);
    printf("  \"thread_count\": %d,\n", count);
    printf("  \"threads\": [\n");

    for (int i = 0; i < count; i++) {

        struct proc_threadinfo info;
        memset(&info, 0, sizeof(info));

        int result = proc_pidinfo(
            pid,
            PROC_PIDTHREADINFO,
            thread_ids[i],
            &info,
            sizeof(info)
        );

        // 詳細を取得できないスレッドは除外
        if (result != sizeof(info)) {
            continue;
        }

        double user_time =
            info.pth_user_time / 1000000000.0;

        double system_time =
            info.pth_system_time / 1000000000.0;

        // 配列要素の区切りを管理
        static int printed = 0;

        if (printed > 0) {
            printf(",\n");
        }

        printf("    {\n");
        printf("      \"id\": %llu,\n",
               (unsigned long long)thread_ids[i]);
        printf("      \"user_time\": %.9f,\n", user_time);
        printf("      \"system_time\": %.9f,\n", system_time);
        printf("      \"run_state\": %d\n",
               info.pth_run_state);
        printf("    }");

        printed++;
    }

    printf("\n  ]\n");
    printf("}\n");

    // 確保したメモリを解放
    free(thread_ids);

    return 0;
}
