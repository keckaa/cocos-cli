/**
 * 一些全局路径配置记录
 */

import { join } from 'path';
import { resolveEngineRoot } from './engine-root';

const workspace = join(__dirname, '..');

function requireEnginePath(): string {
    try {
        return resolveEngineRoot(workspace);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
    }
}

export const GlobalPaths = {
    staticDir: join(workspace, 'static'),
    workspace,
    enginePath: requireEnginePath(),
};

/**
 * CLI 的任务模式
 */
type CLITaskMode = 'hold' | 'simple';

interface IGlobalConfig {
    mode: CLITaskMode;
}

export const GlobalConfig: IGlobalConfig = {
    mode: 'hold',
};