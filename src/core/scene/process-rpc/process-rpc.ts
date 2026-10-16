// process-rpc.ts
import { ChildProcess } from 'child_process';

/**
 * RPC 消息类型
 */
interface RpcRequest {
    id: number;
    type: 'request';
    module: string;
    method: string;
    args: any[];
}

interface RpcResponse {
    id: number;
    type: 'response';
    result?: any;
    error?: string;
}

interface RpcNotify {
    type: 'notify';
    module: string;
    method: string;
    args: any[];
}

type RpcMessage = RpcRequest | RpcResponse | RpcNotify;

interface PendingRpc {
    done: boolean;
    timer?: ReturnType<typeof setTimeout>;
    settle: (msg: RpcResponse) => void;
}

/**
 * request 的 options
 */
interface RequestOptions {
    timeout?: number; // 毫秒
}

/**
 * 双向 RPC 类
 * TModules 为注册模块接口集合
 *
 * 使用示例：
 *
 * interface INodeService {
 *   createNode(name: string): Promise<string>;
 *   deleteNode(id: string): Promise<void>;
 * }
 *
 * interface ISceneService {
 *   loadScene(id: string): Promise<boolean>;
 * }
 *
 * // 假设我们在主进程
 * const rpc = new ProcessRPC<{ node: INodeService; scene: ISceneService }>(childProcess);
 *
 * // 注册对象实例
 * rpc.register('scene', {
 *   async loadScene(id: string) {
 *     console.log('Scene loaded:', id);
 *     return true;
 *   }
 * });
 *
 * // 注册类实例
 * class NodeService implements INodeService {
 *   async createNode(name: string) {
 *     return `Node:${name}`;
 *   }
 *   async deleteNode(id: string) {
 *     console.log('Node deleted:', id);
 *   }
 * }
 * rpc.register('node', new NodeService());
 *
 * // 调用子进程方法
 * const nodeName = await rpc.request('node', 'createNode', ['Player']);
 *
 * // 发送单向消息
 * rpc.send('scene', 'loadScene', ['Level01']);
 */
export class ProcessRPC<TModules extends Record<string, any>> {
    private handlers: Record<string, any> = {};
    private callbacks = new Map<number, PendingRpc>();
    private msgId = 0;
    private process: NodeJS.Process | ChildProcess | undefined;
    private onMessageBind = this.onMessage.bind(this);
    private onExitBind = () => {
        this.dispose();
    };
    private serverUrl: string | undefined;
    private isWebMode = false;

    /**
     * @param proc - NodeJS.Process 或 ChildProcess 实例
     */
    attach(proc: NodeJS.Process | ChildProcess) {
        this.dispose();
        this.process = proc;
        this.isWebMode = false;
        this.listen();
        (proc as NodeJS.EventEmitter).on('exit', this.onExitBind);
    }

    /**
     * 设置 Web 传输模式（浏览器环境使用）
     * @param baseUrl - 服务器基础连接
     */
    setWebTransport(baseUrl: string) {
        this.dispose();
        this.serverUrl = baseUrl;
        this.isWebMode = true;
    }

    /**
     * 注册模块，只支持对象或者类实例
     * @param handler - 注册模块列表
     */
    register(handler: Record<string, any>) {
        this.handlers = handler;
    }

    /**
     * 重置消息注册
     */
    public dispose() {
        const pending = Array.from(this.callbacks.values());
        this.callbacks.clear();
        this.msgId = 0;
        const proc = this.process;
        this.process = undefined;
        this.serverUrl = undefined;
        this.isWebMode = false;
        for (const item of pending) {
            if (item.timer) {
                clearTimeout(item.timer);
                item.timer = undefined;
            }
            this._finish(item, { id: 0, type: 'response', error: '场景进程已退出' });
        }
        proc?.off('message', this.onMessageBind);
        (proc as NodeJS.EventEmitter | undefined)?.off('exit', this.onExitBind);
    }

    /**
     * 是否连接
     */
    public isConnect() {
        return this.process?.connected;
    }

    /**
     * 监听 incoming 消息
     */
    private listen() {
        if (!this.process) {
            throw new Error('未挂载进程');
        }
        this.process.on('message', this.onMessageBind);
    }

    private async onMessage(msg: RpcMessage) {
        if (!msg || typeof msg !== 'object') return;

        // 远程请求
        if (msg.type === 'request') {
            const { id, module, method, args } = msg;
            const target = this.handlers[module];
            if (!target || typeof target[method] !== 'function') {
                this.reply({ id, type: 'response', error: `Method not found: ${module}.${method}` });
                return;
            }

            try {
                const result = await target[method](...(args || []));
                this.reply({ id, type: 'response', result });
            } catch (e: any) {
                this.reply({ id, type: 'response', error: e?.message || String(e) });
            }
        }

        // 响应
        if (msg.type === 'response') {
            const pending = this.callbacks.get(msg.id);
            if (pending) {
                this.callbacks.delete(msg.id);
                this._finish(pending, msg);
            }
        }

        // 单向消息
        if (msg.type === 'notify') {
            const { module, method, args } = msg;
            const target = this.handlers[module];
            if (target && typeof target[method] === 'function') {
                target[method](...(args || []));
            }
        }
    }

    /**
     * 回复
     * @param msg
     * @private
     */
    private reply(msg: RpcResponse) {
        if (!this.process) {
            throw new Error('未挂载进程');
        }
        this.process.send?.(msg);
    }

    /**
     * 发送请求并等待响应
     * @param module 模块名
     * @param method 方法名
     * @param rest
     */
    request<K extends keyof TModules, M extends keyof TModules[K]>(
        module: K,
        method: M,
        ...rest: Parameters<TModules[K][M]> extends []
            ? [args?: [], options?: RequestOptions]
            : [args: Parameters<TModules[K][M]>, options?: RequestOptions]
    ): Promise<Awaited<ReturnType<TModules[K][M]>>> {
        const [args, options] = rest;

        if (this.isWebMode && this.serverUrl) {
            const url = `${this.serverUrl}/rpc/${String(module)}/${String(method)}`;
            return fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(args || [])
            }).then(async (res) => {
                if (res.ok) {
                    const rpcRes = (await res.json()) as RpcResponse;
                    if (rpcRes.error) {
                        throw new Error(rpcRes.error);
                    }
                    return rpcRes.result;
                }
                throw new Error(`RPC request failed with status: ${res.status}`);
            });
        }

        return new Promise((resolve, reject) => {
            const id = ++this.msgId;

            const req: RpcRequest = {
                id,
                type: 'request',
                module: module as string,
                method: method as string,
                args: args || []
            };

            const pending: PendingRpc = {
                done: false,
                settle: (res) => {
                    if (res.error) reject(new Error(res.error));
                    else resolve(res.result);
                },
            };
            if (options?.timeout) {
                pending.timer = setTimeout(() => {
                    this.callbacks.delete(id);
                    this._finish(pending, {
                        id,
                        type: 'response',
                        error: `RPC request timeout: ${String(module)}.${String(method)}`,
                    });
                }, options.timeout);
            }
            this.callbacks.set(id, pending);

            if (!this.process) {
                this.callbacks.delete(id);
                pending.done = true;
                if (pending.timer) {
                    clearTimeout(pending.timer);
                    pending.timer = undefined;
                }
                throw new Error('RPC 尚未挂载进程且未开启 Web 模式');
            }
            this.process.send?.(req);
        });
    }

    private _finish(pending: PendingRpc, msg: RpcResponse) {
        if (pending.done) {
            return;
        }
        pending.done = true;
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }
        pending.settle(msg);
    }

    /**
     * 直接执行本地注册的模块方法（用于服务器接收到基于 HTTP 的 RPC 请求时直接处理）
     */
    async executeLocal<K extends keyof TModules, M extends keyof TModules[K]>(
        module: K,
        method: M,
        args: any[]
    ): Promise<Awaited<ReturnType<TModules[K][M]>>> {
        const target = this.handlers[module as string];
        if (!target || typeof target[method as string] !== 'function') {
            throw new Error(`Method not found: ${String(module)}.${String(method)}`);
        }
        return await target[method as string](...(args || []));
    }

    /**
     * 发送单向消息（无返回值）
     */
    notify<K extends keyof TModules, M extends keyof TModules[K]>(
        module: K,
        method: M,
        args?: Parameters<TModules[K][M]>
    ) {
        if (!this.process) {
            throw new Error('未挂载进程');
        }
        const msg: RpcNotify = {
            type: 'notify',
            module: module as string,
            method: method as string,
            args: args || []
        };
        this.process.send?.(msg);
    }
}
