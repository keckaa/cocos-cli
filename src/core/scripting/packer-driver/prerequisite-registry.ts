import { pathToFileURL } from 'url';
import { resolveFileName } from '../utils/path';

export interface ScriptModuleRegistry {
    urls: Set<string>;
    uuidToUrl: Map<string, string>;
}

export function moduleHrefFromFile(filePath: string): string {
    return pathToFileURL(resolveFileName(filePath)).href;
}

function forget(reg: ScriptModuleRegistry, href: string | undefined): boolean {
    if (!href) {
        return false;
    }
    return reg.urls.delete(href);
}

export interface RegistryEdit {
    removed: string[];
    added: string | null;
}

/**
 * delete 只摘掉这次事件自己的路径。uuid 已经指向别的位置时，保留那个新路径。
 */
export function applyScriptDelete(reg: ScriptModuleRegistry, uuid: string, eventHref: string | undefined): RegistryEdit {
    const removed: string[] = [];
    const mapped = reg.uuidToUrl.get(uuid);
    if (forget(reg, eventHref)) {
        removed.push(eventHref!);
    }
    if (mapped && (!eventHref || mapped === eventHref)) {
        if (mapped !== eventHref) {
            forget(reg, mapped);
        }
        if (!removed.includes(mapped)) {
            removed.push(mapped);
        }
        reg.uuidToUrl.delete(uuid);
    }
    return { removed, added: null };
}

/**
 * change 先摘掉 uuid 上的旧入口和 oldFilePath，再登记新路径。
 * add 只登记新路径。插件脚本摘掉后不再加回。
 */
export function applyScriptUpsert(
    reg: ScriptModuleRegistry,
    uuid: string,
    newHref: string,
    isChange: boolean,
    oldFilePath: string | undefined,
    isPlugin: boolean,
): RegistryEdit {
    const removed: string[] = [];
    if (isChange) {
        const mapped = reg.uuidToUrl.get(uuid);
        if (mapped) {
            forget(reg, mapped);
            removed.push(mapped);
            reg.uuidToUrl.delete(uuid);
        }
        if (oldFilePath) {
            const oldHref = moduleHrefFromFile(oldFilePath);
            if (oldHref !== newHref && oldHref !== mapped && forget(reg, oldHref)) {
                removed.push(oldHref);
            }
        }
    }
    if (isPlugin) {
        return { removed, added: null };
    }
    reg.uuidToUrl.set(uuid, newHref);
    reg.urls.add(newHref);
    return { removed, added: newHref };
}

/**
 * 文件已经挪走、刷新事件还没到时，把已跟踪脚本的入口改到新路径。
 * 没进过注册表的（插件脚本、非脚本）不动。
 */
export function relocateScriptModule(
    reg: ScriptModuleRegistry,
    uuid: string,
    oldFilePath: string,
    newFilePath: string,
): RegistryEdit {
    const oldHref = moduleHrefFromFile(oldFilePath);
    const newHref = moduleHrefFromFile(newFilePath);
    if (!uuid || oldHref === newHref) {
        return { removed: [], added: null };
    }
    const tracked = reg.uuidToUrl.has(uuid) || reg.urls.has(oldHref);
    if (!tracked) {
        return { removed: [], added: null };
    }
    const removed: string[] = [];
    if (forget(reg, oldHref)) {
        removed.push(oldHref);
    }
    const mapped = reg.uuidToUrl.get(uuid);
    if (mapped && mapped !== newHref && mapped !== oldHref) {
        forget(reg, mapped);
        removed.push(mapped);
    }
    reg.uuidToUrl.set(uuid, newHref);
    reg.urls.add(newHref);
    return { removed, added: newHref };
}
