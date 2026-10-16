import { BuildLane } from './build-lane';

describe('BuildLane', () => {
    test('进行中的变更等当前轮结束后再链接一次，且不重叠', async () => {
        const lane = new BuildLane();
        const queue = ['a'];
        const seen: { allowEmpty: boolean; batch: string[] }[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let started = 0;
        const task = async (allowEmpty: boolean) => {
            const batch = queue.splice(0, queue.length);
            seen.push({ allowEmpty, batch });
            started += 1;
            if (started === 1) {
                await firstGate;
            }
        };

        const first = lane.run(task);
        queue.push('b');
        const second = lane.run(task);
        queue.push('c');
        const third = lane.run(task);

        expect(second).toBe(third);
        expect(seen).toEqual([{ allowEmpty: true, batch: ['a'] }]);

        releaseFirst();
        await first;
        await second;

        expect(seen).toEqual([
            { allowEmpty: true, batch: ['a'] },
            { allowEmpty: false, batch: ['b', 'c'] },
        ]);
    });

    test('当前轮失败后仍然执行后续轮次，且调用方能看到失败', async () => {
        const lane = new BuildLane();
        const first = lane.run(async () => {
            throw new Error('boom');
        });
        let followUps = 0;
        const second = lane.run(async () => {
            followUps += 1;
        });

        await expect(first).rejects.toThrow('boom');
        await second;
        expect(followUps).toBe(1);
    });

    test('空闲时连续两次编译都会执行', async () => {
        const lane = new BuildLane();
        const seen: boolean[] = [];
        await lane.run(async (allowEmpty) => {
            seen.push(allowEmpty);
        });
        await lane.run(async (allowEmpty) => {
            seen.push(allowEmpty);
        });
        expect(seen).toEqual([true, true]);
    });
});
