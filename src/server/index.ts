import { serverService, type ServerStartOptions } from './server';
import { IMiddlewareContribution } from './interfaces';

/**
 * 启动服务器
 */
export async function startServer(port?: number, host?: string, options: ServerStartOptions = {}): Promise<void> {
    try {
        serverService.init();
        await serverService.start(port, host, options);
    } catch (error) {
        console.error(error);
        if (options.strictPort) {
            throw error;
        }
    }
}

/**
 * 停止服务器
 */
export async function stopServer(): Promise<void> {
    try {
        await serverService.stop();
        const { clearManagedSession } = await import('../mcp/managed-session');
        clearManagedSession();
    } catch (error) {
        console.error(error);
    }
}

/**
 * 获取当前服务器的地址
 */
export function getServerUrl(): string {
    return serverService.url;
}

export function register(name: string, module: IMiddlewareContribution) {
    serverService.register(name, module);
}
