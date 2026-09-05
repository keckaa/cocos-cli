const mockRpcRequest = jest.fn();
const mockQueryRegisteredService = jest.fn();

jest.mock('cc', () => ({
    __esModule: true,
    default: { director: { getScene: jest.fn(() => null) } },
    director: { getScene: jest.fn(() => null) },
}));

jest.mock('../scene-process/rpc', () => ({
    Rpc: { getInstance: () => ({ request: mockRpcRequest }) },
}));

jest.mock('../scene-process/service/core', () => ({
    BaseService: class {
        protected isOpen = false;
        protected emit() { }
        protected emitInternal() { }
        protected broadcast() { }
    },
    register: () => (target: unknown) => target,
    Service: {
        Undo: {
            clearHistory: jest.fn(),
            markSaved: jest.fn(),
        },
    },
    queryRegisteredService: (...args: unknown[]) => mockQueryRegisteredService(...args),
}));

jest.mock('../scene-process/service/editors', () => ({
    SceneEditor: class SceneEditor {},
    PrefabEditor: class PrefabEditor {},
}));

import { globalEventEmitter } from '../scene-process/service/core/global-events';

const { EditorService } = require('../scene-process/service/editor');
const { SceneEditor } = require('../scene-process/service/editors');

function mockAssetInfo(uuid: string, url: string) {
    return { uuid, url, type: 'scene', file: `/tmp/${uuid}.scene` };
}

describe('EditorService switch/save policy', () => {
    let editorService: any;
    let isDirty: jest.Mock;

    beforeEach(() => {
        editorService = new EditorService();
        isDirty = jest.fn(() => false);
        mockQueryRegisteredService.mockImplementation((name: string) => {
            if (name === 'Undo') {
                return { isDirty };
            }
            return null;
        });
        mockRpcRequest.mockReset();
        mockRpcRequest.mockImplementation(async (_service: string, method: string, args: string[]) => {
            if (method === 'queryAssetSourceStat') {
                return { mtimeMs: 1, size: 10 };
            }
            if (method === 'queryAssetInfo') {
                const id = args[0];
                if (id === 'old.scene' || id === 'old-uuid') {
                    return mockAssetInfo('old-uuid', 'old.scene');
                }
                if (id === 'new.scene' || id === 'new-uuid') {
                    return mockAssetInfo('new-uuid', 'new.scene');
                }
            }
            return undefined;
        });
        globalEventEmitter.removeAllListeners();
    });

    afterEach(() => {
        globalEventEmitter.removeAllListeners();
    });

    async function openThenSwitch(options: { dirty: boolean; diskNewer?: boolean }) {
        isDirty.mockReturnValue(options.dirty);
        const created: Array<{ open: jest.Mock; close: jest.Mock }> = [];
        editorService.createEditor = jest.fn(() => {
            const editor = Object.assign(Object.create(SceneEditor.prototype), {
                open: jest.fn().mockResolvedValue({}),
                close: jest.fn().mockResolvedValue(true),
            });
            created.push(editor);
            return editor;
        });

        await editorService.open({ urlOrUUID: 'old.scene' });
        if (options.diskNewer) {
            mockRpcRequest.mockImplementation(async (_service: string, method: string, args: string[]) => {
                if (method === 'queryAssetSourceStat') {
                    return args[0] === 'old-uuid'
                        ? { mtimeMs: 99, size: 10 }
                        : { mtimeMs: 1, size: 10 };
                }
                if (method === 'queryAssetInfo') {
                    const id = args[0];
                    if (id === 'old.scene' || id === 'old-uuid') {
                        return mockAssetInfo('old-uuid', 'old.scene');
                    }
                    if (id === 'new.scene' || id === 'new-uuid') {
                        return mockAssetInfo('new-uuid', 'new.scene');
                    }
                }
                return undefined;
            });
        }
        isDirty.mockReturnValue(options.dirty);
        await editorService.open({ urlOrUUID: 'new.scene' });
        return { oldEditor: created[0], newEditor: created[1] };
    }

    it('does not save a clean editor when switching to another asset', async () => {
        const { oldEditor, newEditor } = await openThenSwitch({ dirty: false });
        expect(oldEditor.close).toHaveBeenCalledWith({ save: false });
        expect(newEditor.open).toHaveBeenCalled();
        expect(editorService.currentEditorUuid).toBe('new-uuid');
    });

    it('saves a dirty editor when switching and disk is unchanged', async () => {
        const { oldEditor } = await openThenSwitch({ dirty: true });
        expect(oldEditor.close).toHaveBeenCalledWith({ save: true });
    });

    it('does not save a dirty editor over a newer disk file when switching', async () => {
        const { oldEditor, newEditor } = await openThenSwitch({ dirty: true, diskNewer: true });
        expect(oldEditor.close).toHaveBeenCalledWith({ save: false });
        expect(newEditor.open).toHaveBeenCalled();
        expect(editorService.currentEditorUuid).toBe('new-uuid');
    });

    it('skips writing on close when the editor is clean', async () => {
        const editor = Object.assign(Object.create(SceneEditor.prototype), {
            open: jest.fn().mockResolvedValue({}),
            close: jest.fn().mockResolvedValue(true),
            save: jest.fn(),
        });
        editorService.createEditor = jest.fn(() => editor);
        await editorService.open({ urlOrUUID: 'old.scene' });
        isDirty.mockReturnValue(false);
        await editorService.close({});
        expect(editor.close).toHaveBeenCalledWith({ save: false });
        expect(editor.save).not.toHaveBeenCalled();
    });

    it('closes a clean editor without saving when the source file is newer', async () => {
        const editor = Object.assign(Object.create(SceneEditor.prototype), {
            open: jest.fn().mockResolvedValue({}),
            close: jest.fn().mockResolvedValue(true),
            save: jest.fn(),
        });
        editorService.createEditor = jest.fn(() => editor);
        await editorService.open({ urlOrUUID: 'old.scene' });
        isDirty.mockReturnValue(false);
        mockRpcRequest.mockImplementation(async (_service: string, method: string, args: string[]) => {
            if (method === 'queryAssetSourceStat') {
                return { mtimeMs: 99, size: 10 };
            }
            if (method === 'queryAssetInfo') {
                return mockAssetInfo('old-uuid', 'old.scene');
            }
            return undefined;
        });

        await expect(editorService.close({})).resolves.toBe(true);
        expect(editor.close).toHaveBeenCalledWith({ save: false });
        expect(editor.save).not.toHaveBeenCalled();
        expect(editorService.currentEditorUuid).toBeNull();
    });

    it('rejects close-with-save when dirty and the source file is newer', async () => {
        const editor = Object.assign(Object.create(SceneEditor.prototype), {
            open: jest.fn().mockResolvedValue({}),
            close: jest.fn().mockResolvedValue(true),
            save: jest.fn(),
        });
        editorService.createEditor = jest.fn(() => editor);
        await editorService.open({ urlOrUUID: 'old.scene' });
        isDirty.mockReturnValue(true);
        mockRpcRequest.mockImplementation(async (_service: string, method: string, args: string[]) => {
            if (method === 'queryAssetSourceStat') {
                return { mtimeMs: 99, size: 10 };
            }
            if (method === 'queryAssetInfo') {
                return mockAssetInfo('old-uuid', 'old.scene');
            }
            return undefined;
        });

        await expect(editorService.close({})).rejects.toThrow(/被修改/);
        expect(editor.close).not.toHaveBeenCalled();
        expect(editor.save).not.toHaveBeenCalled();
        expect(editorService.currentEditorUuid).toBe('old-uuid');
    });

    it('saves when the source file is unchanged', async () => {
        const asset = mockAssetInfo('old-uuid', 'old.scene');
        const editor = Object.assign(Object.create(SceneEditor.prototype), {
            open: jest.fn().mockResolvedValue({}),
            save: jest.fn().mockResolvedValue(asset),
        });
        editorService.createEditor = jest.fn(() => editor);
        await editorService.open({ urlOrUUID: 'old.scene' });

        await expect(editorService.save({})).resolves.toEqual(asset);
        expect(editor.save).toHaveBeenCalled();
    });

    it('rejects explicit save when the source file is newer than the session', async () => {
        const editor = Object.assign(Object.create(SceneEditor.prototype), {
            open: jest.fn().mockResolvedValue({}),
            save: jest.fn(),
        });
        editorService.createEditor = jest.fn(() => editor);
        await editorService.open({ urlOrUUID: 'old.scene' });
        mockRpcRequest.mockImplementation(async (_service: string, method: string, args: string[]) => {
            if (method === 'queryAssetSourceStat') {
                return { mtimeMs: 99, size: 10 };
            }
            if (method === 'queryAssetInfo') {
                return mockAssetInfo('old-uuid', 'old.scene');
            }
            return undefined;
        });

        await expect(editorService.save({})).rejects.toThrow(/被修改/);
        expect(editor.save).not.toHaveBeenCalled();
    });
});
