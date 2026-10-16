/**
 * 从本机 Cocos Creator 设置解析 3.8.8 JavaScript 引擎，写入 config.local.json 的 engine。
 * 原生目录由 CLI 取 JavaScript 引擎下的 native，这里只读 javascript。
 * 版本常量与 src/engine-root.ts 的 REQUIRED_ENGINE_VERSION 保持一致。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REQUIRED_ENGINE_VERSION = '3.8.8';

class ResolveEngineError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResolveEngineError';
    }
}

function profileKey(version) {
    return version.replace(/\./g, '');
}

function readJson(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new ResolveEngineError(`${filePath} 不存在。`);
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        throw new ResolveEngineError(`无法解析 ${filePath}`);
    }
}

function toConfigPath(enginePath) {
    return path.resolve(enginePath).replace(/\\/g, '/');
}

function resolveBuiltinEngine(homeDir) {
    const editorJson = path.join(homeDir, '.Cocos', 'profiles', 'editor.json');
    const data = readJson(editorJson);
    const list = data && data.editor && data.editor.Creator3D;
    if (!Array.isArray(list)) {
        throw new ResolveEngineError(`${editorJson} 没有 editor.Creator3D。`);
    }

    const matches = list.filter((item) => item && item.version === REQUIRED_ENGINE_VERSION);
    if (matches.length === 0) {
        throw new ResolveEngineError(`${editorJson} 没有 version 为 ${REQUIRED_ENGINE_VERSION} 的 Creator3D。`);
    }
    if (matches.length > 1) {
        const dists = matches.map((item) => item.unzipDist || '(空)').join('\n');
        throw new ResolveEngineError(`${editorJson} 有多条 ${REQUIRED_ENGINE_VERSION} 的 Creator3D：\n${dists}`);
    }

    const unzipDist = matches[0].unzipDist;
    if (typeof unzipDist !== 'string' || unzipDist.trim() === '') {
        throw new ResolveEngineError(`${editorJson} 的 ${REQUIRED_ENGINE_VERSION} 缺少 unzipDist。`);
    }
    return path.resolve(unzipDist, 'resources', 'resources', '3d', 'engine');
}

function resolveJavascriptEngine(homeDir) {
    const engineJson = path.join(homeDir, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json');
    const data = readJson(engineJson);
    const key = profileKey(REQUIRED_ENGINE_VERSION);
    const javascript = data && data.engine && data.engine[key] && data.engine[key].javascript;
    if (!javascript || typeof javascript !== 'object') {
        throw new ResolveEngineError(`${engineJson} 没有 engine.${key}.javascript。`);
    }

    if (javascript.builtin === false) {
        const custom = javascript.custom;
        if (typeof custom !== 'string' || custom.trim() === '') {
            throw new ResolveEngineError(`${engineJson} 的 engine.${key}.javascript.custom 为空。`);
        }
        return path.resolve(custom.trim());
    }

    if (javascript.builtin === true) {
        return resolveBuiltinEngine(homeDir);
    }

    throw new ResolveEngineError(`${engineJson} 的 engine.${key}.javascript.builtin 无效。`);
}

function assertEngineVersion(enginePath) {
    const pkgPath = path.join(enginePath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        throw new ResolveEngineError(`引擎目录缺少 package.json: ${enginePath}`);
    }

    let version = '';
    try {
        version = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
    } catch {
        throw new ResolveEngineError(`无法解析 ${pkgPath}`);
    }

    if (version !== REQUIRED_ENGINE_VERSION) {
        throw new ResolveEngineError(`引擎版本是 ${version || '未知'}，需要 ${REQUIRED_ENGINE_VERSION}。路径: ${enginePath}`);
    }
    return enginePath;
}

function writeEngineConfig(workspace, enginePath) {
    const configPath = path.join(workspace, 'config.local.json');
    let config = {};
    if (fs.existsSync(configPath)) {
        const parsed = readJson(configPath);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ResolveEngineError(`${configPath} 不是对象，未修改。`);
        }
        config = parsed;
    }
    config.engine = toConfigPath(enginePath);
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`);
    return config.engine;
}

function isGitRepository(dir) {
    return fs.existsSync(path.join(dir, '.git'));
}

function pullGitRepository(enginePath) {
    console.log(`>> git pull --ff-only: ${enginePath}`);
    const result = spawnSync('git', ['-C', enginePath, 'pull', '--ff-only'], { stdio: 'inherit' });
    if (result.error) {
        throw new ResolveEngineError(`无法执行 git pull: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new ResolveEngineError(`拉取引擎失败 (exit ${result.status}): ${enginePath}`);
    }
}

function pullEngineIfRepository(enginePath, pullGit = pullGitRepository) {
    if (!isGitRepository(enginePath)) {
        console.log(`引擎不是 git 仓库，跳过拉取: ${enginePath}`);
        return;
    }
    pullGit(enginePath);
}

function resolveAndWrite(homeDir, workspace, options = {}) {
    const enginePath = assertEngineVersion(resolveJavascriptEngine(homeDir));
    const written = writeEngineConfig(workspace, enginePath);
    pullEngineIfRepository(enginePath, options.pullGit);
    return written;
}

function main() {
    try {
        const enginePath = resolveAndWrite(require('os').homedir(), path.join(__dirname, '..'));
        console.log(`已写入 config.local.json engine: ${enginePath}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    REQUIRED_ENGINE_VERSION,
    ResolveEngineError,
    resolveAndWrite,
};
