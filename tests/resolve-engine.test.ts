import { createRequire } from 'module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REQUIRED_ENGINE_VERSION } from '../src/engine-root';

const nodeRequire = createRequire(__filename);
const { resolveAndWrite, ResolveEngineError, REQUIRED_ENGINE_VERSION: scriptVersion } = nodeRequire('../workflow/resolve-engine.js');

function writeEngine(root: string, version: string) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cocos-creator', version }));
}

function writeJson(file: string, value: unknown) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
}

function readConfig(workspace: string) {
    return JSON.parse(readFileSync(join(workspace, 'config.local.json'), 'utf-8'));
}

describe('resolveAndWrite', () => {
    let home: string;
    let workspace: string;
    let engine: string;

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'resolve-engine-home-'));
        workspace = mkdtempSync(join(tmpdir(), 'resolve-engine-workspace-'));
        engine = join(home, 'engine');
        writeEngine(engine, '3.8.8');
    });

    afterEach(() => {
        rmSync(home, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    });

    test('版本常量与 engine-root 一致', () => {
        expect(scriptVersion).toBe(REQUIRED_ENGINE_VERSION);
    });

    test('自定义 JavaScript 引擎写入 engine，并保留 project', () => {
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '388': { javascript: { builtin: false, custom: engine } } },
        });
        writeFileSync(join(workspace, 'config.local.json'), JSON.stringify({ project: 'keep-me', engine: 'old' }));

        const written = resolveAndWrite(home, workspace);

        expect(written).toBe(engine.replace(/\\/g, '/'));
        expect(readConfig(workspace)).toEqual({ project: 'keep-me', engine: written });
    });

    test('没有配置文件时只写入 engine', () => {
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '388': { javascript: { builtin: false, custom: engine } } },
        });

        resolveAndWrite(home, workspace);

        expect(readConfig(workspace)).toEqual({ engine: engine.replace(/\\/g, '/') });
    });

    test('内置引擎使用 Creator 3.8.8 安装目录', () => {
        const install = join(home, 'Creator', '3.8.8');
        const builtin = join(install, 'resources', 'resources', '3d', 'engine');
        writeEngine(builtin, '3.8.8');
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '388': { javascript: { builtin: true } } },
        });
        writeJson(join(home, '.Cocos', 'profiles', 'editor.json'), {
            editor: { Creator3D: [{ version: '3.8.8', unzipDist: install }] },
        });

        const written = resolveAndWrite(home, workspace);

        expect(written).toBe(builtin.replace(/\\/g, '/'));
    });

    test('版本不是 3.8.8 时不改已有配置', () => {
        writeEngine(engine, '4.0.0');
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '388': { javascript: { builtin: false, custom: engine } } },
        });
        const original = JSON.stringify({ project: 'keep-me', engine: 'old' });
        writeFileSync(join(workspace, 'config.local.json'), original);

        expect(() => resolveAndWrite(home, workspace)).toThrow(ResolveEngineError);
        expect(readFileSync(join(workspace, 'config.local.json'), 'utf-8')).toBe(original);
    });

    test('custom 为空时不写配置', () => {
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '388': { javascript: { builtin: false, custom: '' } } },
        });

        expect(() => resolveAndWrite(home, workspace)).toThrow(/custom 为空/);
        expect(() => readConfig(workspace)).toThrow();
    });

    test('多份 3.8.8 安装时退出并列出路径', () => {
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '388': { javascript: { builtin: true } } },
        });
        writeJson(join(home, '.Cocos', 'profiles', 'editor.json'), {
            editor: {
                Creator3D: [
                    { version: '3.8.8', unzipDist: 'D:/editors/a' },
                    { version: '3.8.8', unzipDist: 'D:/editors/b' },
                    { version: '2.4.15', unzipDist: 'D:/editors/old' },
                ],
            },
        });

        expect(() => resolveAndWrite(home, workspace)).toThrow(/D:\/editors\/a[\s\S]*D:\/editors\/b/);
        expect(() => readConfig(workspace)).toThrow();
    });

    test('没有 3.8.8 安装目录时不写配置', () => {
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '388': { javascript: { builtin: true } } },
        });
        writeJson(join(home, '.Cocos', 'profiles', 'editor.json'), {
            editor: { Creator3D: [{ version: '3.8.7', unzipDist: 'D:/editors/old' }] },
        });
        writeFileSync(join(workspace, 'config.local.json'), '{"project":"keep-me"}');

        expect(() => resolveAndWrite(home, workspace)).toThrow(/没有 version 为 3\.8\.8/);
        expect(readConfig(workspace)).toEqual({ project: 'keep-me' });
    });

    test('没有 388 的 javascript 设置时退出', () => {
        writeJson(join(home, '.CocosCreator', 'profiles', 'v2', 'packages', 'engine.json'), {
            engine: { '380': { native: { builtin: true } } },
        });

        expect(() => resolveAndWrite(home, workspace)).toThrow(/engine\.388\.javascript/);
    });
});
