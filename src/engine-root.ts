import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

export const REQUIRED_ENGINE_VERSION = '3.8.8';

export class EngineRootError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EngineRootError';
    }
}

/**
 * 从 CLI 仓库根目录的 config.local.json 读取 engine。
 * 缺字段，或目标 package.json 的 version 不是 3.8.8 时抛出 EngineRootError。
 */
export function resolveEngineRoot(workspace: string): string {
    const configPath = join(workspace, 'config.local.json');
    if (!existsSync(configPath)) {
        throw new EngineRootError(`${configPath} 不存在，无法读取 engine。`);
    }

    let config: { engine?: unknown };
    try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
        throw new EngineRootError(`无法解析 ${configPath}`);
    }

    if (typeof config.engine !== 'string' || config.engine.trim() === '') {
        throw new EngineRootError('config.local.json 缺少 engine 字段。请指向 Cocos 3.8.8 引擎目录。');
    }

    const enginePath = resolve(config.engine);
    const pkgPath = join(enginePath, 'package.json');
    if (!existsSync(pkgPath)) {
        throw new EngineRootError(`引擎目录缺少 package.json: ${enginePath}`);
    }

    let version = '';
    try {
        version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    } catch {
        throw new EngineRootError(`无法解析 ${pkgPath}`);
    }

    if (version !== REQUIRED_ENGINE_VERSION) {
        throw new EngineRootError(`引擎版本是 ${version || '未知'}，需要 ${REQUIRED_ENGINE_VERSION}。路径: ${enginePath}`);
    }

    return enginePath;
}
