export {};

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const mockExistsSync = jest.fn();
const mockOutputFile = jest.fn();
const mockSetDefaultUserData = jest.fn();
const mockAssetConfig = { data: { root: '' } };
const mockCopyPath = jest.fn();
const mockCreateDirectoryPath = jest.fn();
const mockWritePath = jest.fn();

jest.mock('@cocos/asset-db', () => ({
    Importer: class {},
    Asset: class {},
    setDefaultUserData: mockSetDefaultUserData,
    get: jest.fn(() => ({
        importerManager: {
            name2importer: {},
        },
    })),
}));

jest.mock('fs-extra', () => ({
    existsSync: (...args: any[]) => mockExistsSync(...args),
    outputFile: (...args: any[]) => mockOutputFile(...args),
}));

jest.mock('../manager/filesystem', () => ({
    copyPath: (...args: any[]) => mockCopyPath(...args),
    createDirectoryPath: (...args: any[]) => mockCreateDirectoryPath(...args),
    writePath: (...args: any[]) => mockWritePath(...args),
}));

jest.mock('../utils', () => ({
    url2path: jest.fn((value: string) => value),
}));

jest.mock('../asset-config', () => ({
    __esModule: true,
    default: mockAssetConfig,
}));

jest.mock('../asset-handler/config', () => ({ assetHandlerInfos: [] }));
jest.mock('../asset-handler', () => ({}));

jest.mock('../../base/i18n', () => ({
    __esModule: true,
    default: {
        t: (key: string) => key,
        transI18nName: (value: string) => value,
    },
}));

jest.mock('fast-glob', () => ({
    __esModule: true,
    default: jest.fn(async () => []),
}));

jest.mock('eol', () => ({
    __esModule: true,
    default: {
        auto: (value: string) => value,
    },
}));

describe('asset handler filesystem bridge', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        mockExistsSync.mockReturnValue(true);
    });

    it('createAsset should delegate template copy and directory creation to filesystem bridge', async () => {
        const assetHandlerManager = require('../manager/asset-handler').default as typeof import('../manager/asset-handler').default;
        const template = 'D:/project/templates/default.txt';
        const targetFile = 'D:/project/assets/new.txt';
        const targetDir = 'D:/project/assets/new-folder';

        await assetHandlerManager.createAsset({
            target: targetFile,
            template,
            overwrite: true,
        });
        await assetHandlerManager.createAsset({
            target: targetDir,
        });

        expect(mockCopyPath).toHaveBeenCalledWith(template, targetFile, { overwrite: true });
        expect(mockCreateDirectoryPath).toHaveBeenCalledWith(targetDir);
    });

    it('createAsset and saveAsset should delegate source writes to filesystem bridge', async () => {
        const assetHandlerManager = require('../manager/asset-handler').default as typeof import('../manager/asset-handler').default;
        const target = 'D:/project/assets/new.txt';
        const asset = {
            source: 'D:/project/assets/existing.txt',
            meta: {
                importer: 'text',
            },
        };

        await assetHandlerManager.createAsset({
            target,
            content: 'hello',
            handler: 'text',
            uuid: 'uuid-1',
            userData: {
                test: true,
            },
        });
        await assetHandlerManager.saveAsset(asset as any, 'world');

        expect(mockWritePath.mock.calls[0][0]).toBe(target);
        expect(mockWritePath.mock.calls[0][1]).toBe('hello');
        expect(mockWritePath.mock.calls[1][0]).toBe(`${target}.meta`);
        expect(mockWritePath.mock.calls[1][1]).toBe(JSON.stringify({
            userData: {
                test: true,
            },
            uuid: 'uuid-1',
        }, null, 4));
        expect(mockWritePath.mock.calls[2][0]).toBe(asset.source);
        expect(mockWritePath.mock.calls[2][1]).toBe('world');
        expect(mockOutputFile).not.toHaveBeenCalled();
    });

    it('loads saved defaults before activation and preserves them when saving another setting', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cocos-import-defaults-'));
        try {
            mockAssetConfig.data.root = root;
            const manager = require('../manager/asset-handler').default as typeof import('../manager/asset-handler').default;
            const file = join(root, '.creator', 'default-meta.json');
            const compressSettings = { useCompressTexture: true, presetId: 'shared' };
            const saved = { image: { flipVertical: false, compressSettings }, 'sprite-frame': { trimType: 'none' } };
            const bytes = Buffer.from(JSON.stringify(saved));
            await mkdir(join(root, '.creator'));
            await writeFile(file, bytes);
            await manager.init();
            manager.register('test', [{
                name: 'image',
                extensions: ['.png'],
                load: async () => ({
                    name: 'image', importer: { version: '1.0.0', import: async () => true },
                    userDataConfig: { default: { flipVertical: { default: true } } },
                }),
            }], true);
            await manager.activateRegisterAll();
            expect(mockSetDefaultUserData).toHaveBeenLastCalledWith('image', saved.image);
            expect(manager.importDefaults.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

            mockOutputFile.mockRejectedValueOnce(new Error('save failed'));
            await expect(manager.updateDefaultUserData('image', 'flipVertical', true)).rejects.toThrow('save failed');
            expect(mockSetDefaultUserData).toHaveBeenCalledTimes(1);
            expect(manager.importDefaults.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

            await manager.updateDefaultUserData('image', 'flipVertical', true);
            const [writtenPath, written] = mockOutputFile.mock.calls.at(-1)!;
            expect(writtenPath).toBe(file);
            expect(JSON.parse(written.toString())).toEqual({ ...saved, image: { flipVertical: true, compressSettings } });
            expect(manager.importDefaults.sha256).toBe(createHash('sha256').update(written).digest('hex'));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('createAsset should preserve binary content for the filesystem bridge', async () => {
        const assetHandlerManager = require('../manager/asset-handler').default as typeof import('../manager/asset-handler').default;
        const target = 'D:/project/assets/new.terrain';
        const content = Buffer.from([0, 1, 127, 255]);

        await assetHandlerManager.createAsset({ target, content });

        expect(mockWritePath).toHaveBeenCalledWith(target, content);
    });
});
