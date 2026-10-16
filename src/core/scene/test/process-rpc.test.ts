import { fork } from 'child_process';
import { ProcessRPC } from '../process-rpc';
import * as path from 'path';

interface INodeService {
    createNode(name: string): Promise<string>;
    longTask(): Promise<void>;
    hang(): Promise<void>;
}

interface ISceneService {
    loadScene(id: string): Promise<boolean>;
    addReferenceImage(path: string): Promise<{ path: string; dataUrl: string }>;
}

interface IReferenceImageFiles {
    readDataUrl(path: string): Promise<string>;
}

// 测试用子进程文件路径
const workerPath = path.resolve(__dirname, './process-rpc/rpc-worker.js');

describe('ProcessRPC 双向调用测试', () => {
    let child: ReturnType<typeof fork>;
    let rpc: ProcessRPC<{ node: INodeService; scene: ISceneService; referenceImageFiles: IReferenceImageFiles }>;

    beforeAll(() => {
        child = fork(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        child.stdout?.on('data', (chunk) => {
            console.log(chunk.toString());
        });

        child.stderr?.on('data', (chunk) => {
            console.log(chunk.toString());
        });
        rpc = new ProcessRPC<{ node: INodeService; scene: ISceneService; referenceImageFiles: IReferenceImageFiles }>();
        rpc.attach(child);
    });

    afterAll(() => {
        child.kill();
    });

    test('主进程调用子进程方法', async () => {
        const result = await rpc.request('node', 'createNode', ['Player']);
        expect(result).toBe('Node:Player');
    });

    test('子进程调用主进程方法', async () => {
        // 主进程注册模块供子进程调用
        rpc.register({
            scene: {
                loadScene: async (id: string) => {
                    return id === 'Level01';
                },
            }
        });

        const result = await rpc.request('scene', 'loadScene', ['Level01']);
        expect(result).toBe(true);
    });

    test('Node → Scene → Node nested reference-image RPC completes', async () => {
        rpc.register({
            referenceImageFiles: {
                async readDataUrl(filePath: string) {
                    return `data:image/png;base64,${Buffer.from(filePath).toString('base64')}`;
                },
            },
        });

        await expect(rpc.request('scene', 'addReferenceImage', ['C:\\reference.png'], { timeout: 1000 }))
            .resolves.toEqual({
                path: 'C:\\reference.png',
                dataUrl: `data:image/png;base64,${Buffer.from('C:\\reference.png').toString('base64')}`,
            });
    });

    test('超时处理', async () => {
        await expect(
            rpc.request('node', 'longTask', [], { timeout: 100 })
        ).rejects.toThrow(/RPC request timeout/);
    });
});

describe('ProcessRPC 进程退出', () => {
    test('子进程退出后，未设置超时的请求会失败一次', async () => {
        const child = fork(workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        const exiting = new ProcessRPC<{ node: INodeService }>();
        exiting.attach(child);
        let rejections = 0;
        const pending = exiting.request('node', 'hang', []).then(
            () => {
                throw new Error('请求不应成功');
            },
            (err: Error) => {
                rejections += 1;
                return err;
            },
        );
        child.kill();
        const err = await pending;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('场景进程已退出');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toBe(1);
    });

    test('退出和超时不会把同一次请求失败两次', async () => {
        const listeners: Record<string, Array<(...args: any[]) => void>> = {};
        const fake = {
            connected: true,
            on(event: string, cb: (...args: any[]) => void) {
                (listeners[event] ??= []).push(cb);
            },
            off(event: string, cb: (...args: any[]) => void) {
                listeners[event] = (listeners[event] || []).filter((fn) => fn !== cb);
            },
            send() { },
        };
        const exiting = new ProcessRPC<{ node: INodeService }>();
        exiting.attach(fake as any);
        const onMessage = listeners.message[0];
        let rejections = 0;
        const pending = exiting.request('node', 'longTask', [], { timeout: 30 }).then(
            () => {
                throw new Error('请求不应成功');
            },
            (err: Error) => {
                rejections += 1;
                return err;
            },
        );
        listeners.exit.forEach((cb) => cb());
        const err = await pending;
        expect(err.message).toContain('场景进程已退出');
        onMessage({ id: 1, type: 'response', result: 'late' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(rejections).toBe(1);
    });
});
