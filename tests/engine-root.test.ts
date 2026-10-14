import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EngineRootError, resolveEngineRoot } from '../src/engine-root';

function writeEngine(root: string, version: string) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'cocos-creator', version }));
}

describe('resolveEngineRoot', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'engine-root-'));
    });

    afterEach(() => {
        rmSync(workspace, { recursive: true, force: true });
    });

    test('缺少 config.local.json 时抛出', () => {
        expect(() => resolveEngineRoot(workspace)).toThrow(EngineRootError);
        expect(() => resolveEngineRoot(workspace)).toThrow(/无法读取 engine/);
    });

    test('缺少 engine 字段时抛出', () => {
        writeFileSync(join(workspace, 'config.local.json'), JSON.stringify({ project: 'x' }));
        expect(() => resolveEngineRoot(workspace)).toThrow(/缺少 engine 字段/);
    });

    test('版本不是 3.8.8 时抛出', () => {
        const engine = join(workspace, 'engine');
        writeEngine(engine, '4.0.0-alpha.36');
        writeFileSync(join(workspace, 'config.local.json'), JSON.stringify({ engine }));
        expect(() => resolveEngineRoot(workspace)).toThrow(/需要 3\.8\.8/);
    });

    test('3.8.8 引擎目录可以解析', () => {
        const engine = join(workspace, 'engine');
        writeEngine(engine, '3.8.8');
        writeFileSync(join(workspace, 'config.local.json'), JSON.stringify({ engine }));
        expect(resolveEngineRoot(workspace)).toBe(engine);
    });
});
