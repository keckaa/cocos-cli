/**
 * 同一时刻只跑一轮编译。进行中再来的请求合并成当前这一轮之后的唯一一轮，
 * 不丢弃调用，也不让两轮链接重叠。
 */
export class BuildLane {
    private active: Promise<void> | null = null;
    private followUp: Promise<void> | null = null;

    run(task: (allowEmpty: boolean) => Promise<void>): Promise<void> {
        if (this.active) {
            return this.scheduleFollowUp(task);
        }
        return this.start(task, true);
    }

    private start(task: (allowEmpty: boolean) => Promise<void>, allowEmpty: boolean): Promise<void> {
        let resolveRun!: () => void;
        let rejectRun!: (reason?: unknown) => void;
        const run = new Promise<void>((resolve, reject) => {
            resolveRun = resolve;
            rejectRun = reject;
        });
        this.active = run;
        // 先登记结束清理，再启动任务。任务同步重入时，后续轮次要等这一轮真正结束后再开始。
        void run.finally(() => {
            if (this.active === run) {
                this.active = null;
            }
        }).catch(() => {
            // 失败仍由 run 交给调用方。这里只避免 finally 派生的拒绝没有人接收。
        });
        try {
            task(allowEmpty).then(resolveRun, rejectRun);
        } catch (error) {
            rejectRun(error);
        }
        return run;
    }

    private scheduleFollowUp(task: (allowEmpty: boolean) => Promise<void>): Promise<void> {
        if (!this.followUp) {
            const previous = this.active!;
            this.followUp = previous.then(
                () => this.afterPrevious(task),
                () => this.afterPrevious(task),
            );
        }
        return this.followUp;
    }

    private afterPrevious(task: (allowEmpty: boolean) => Promise<void>): Promise<void> {
        this.followUp = null;
        if (this.active) {
            return this.scheduleFollowUp(task);
        }
        return this.start(task, false);
    }
}
