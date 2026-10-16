import { pathToFileURL } from 'url';
import {
    applyScriptDelete,
    applyScriptUpsert,
    moduleHrefFromFile,
    relocateScriptModule,
    ScriptModuleRegistry,
} from './prerequisite-registry';

function registry(): ScriptModuleRegistry {
    return {
        urls: new Set<string>(),
        uuidToUrl: new Map<string, string>(),
    };
}

const uuid = 'b546e4fa-0b67-4c4f-b644-badcb4a0d355';
const oldPath = 'E:/develop/creator/m2/client/assets/script/game/view/ceshi/Ceshi2PopupViewItem.ts';
const newPath = 'E:/develop/creator/m2/client/assets/script/game/view/ceshi2/Ceshi2PopupViewItem.ts';

describe('prerequisite registry', () => {
    test('同一 uuid 从旧路径改到新路径后，入口里只剩新路径', () => {
        const reg = registry();
        const oldHref = moduleHrefFromFile(oldPath);
        const newHref = moduleHrefFromFile(newPath);
        reg.urls.add(oldHref);
        reg.uuidToUrl.set(uuid, oldHref);

        const edit = relocateScriptModule(reg, uuid, oldPath, newPath);

        expect(edit.removed).toEqual([oldHref]);
        expect(edit.added).toBe(newHref);
        expect(Array.from(reg.urls)).toEqual([newHref]);
        expect(reg.uuidToUrl.get(uuid)).toBe(newHref);
    });

    test('change 带 oldFilePath 时摘掉旧路径，只保留新路径', () => {
        const reg = registry();
        const oldHref = moduleHrefFromFile(oldPath);
        const newHref = pathToFileURL(newPath).href;
        reg.urls.add(oldHref);
        reg.uuidToUrl.set(uuid, oldHref);

        applyScriptUpsert(reg, uuid, newHref, true, oldPath, false);

        expect(Array.from(reg.urls)).toEqual([newHref]);
        expect(reg.uuidToUrl.get(uuid)).toBe(newHref);
    });

    test('delete 只摘事件路径；uuid 已指向新路径时保留新路径', () => {
        const reg = registry();
        const oldHref = moduleHrefFromFile(oldPath);
        const newHref = moduleHrefFromFile(newPath);
        reg.urls.add(oldHref);
        reg.urls.add(newHref);
        reg.uuidToUrl.set(uuid, newHref);

        const edit = applyScriptDelete(reg, uuid, oldHref);

        expect(edit.removed).toEqual([oldHref]);
        expect(reg.urls.has(oldHref)).toBe(false);
        expect(reg.urls.has(newHref)).toBe(true);
        expect(reg.uuidToUrl.get(uuid)).toBe(newHref);
    });

    test('没有移动记录的缺失脚本，delete 会摘掉它自己的入口', () => {
        const reg = registry();
        const oldHref = moduleHrefFromFile(oldPath);
        reg.urls.add(oldHref);
        reg.uuidToUrl.set(uuid, oldHref);

        applyScriptDelete(reg, uuid, oldHref);

        expect(reg.urls.size).toBe(0);
        expect(reg.uuidToUrl.has(uuid)).toBe(false);
    });

    test('uuid 映射的旧地址不在入口集合里时，relocate 仍会摘掉它', () => {
        const reg = registry();
        const oldHref = moduleHrefFromFile(oldPath);
        const mappedHref = moduleHrefFromFile(oldPath.replace(/ceshi\//, 'ceshi/legacy/'));
        const newHref = moduleHrefFromFile(newPath);
        reg.uuidToUrl.set(uuid, mappedHref);
        reg.urls.add(oldHref);

        const edit = relocateScriptModule(reg, uuid, oldPath, newPath);

        expect(edit.removed).toEqual([oldHref, mappedHref]);
        expect(Array.from(reg.urls)).toEqual([newHref]);
        expect(reg.uuidToUrl.get(uuid)).toBe(newHref);
    });

    test('未跟踪的文件不会被 relocate 写进入口', () => {
        const reg = registry();
        const edit = relocateScriptModule(reg, uuid, oldPath, newPath);
        expect(edit.added).toBeNull();
        expect(reg.urls.size).toBe(0);
        expect(reg.uuidToUrl.size).toBe(0);
    });
});
