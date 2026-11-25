const mockImportAsset = jest.fn();
jest.mock('../src/core/assets', () => ({ assetManager: { importAsset: (...args: unknown[]) => mockImportAsset(...args) }, assetDBManager: {} }));
jest.mock('../src/core/assets/animation-mask', () => ({}));
jest.mock('../src/api/decorator/decorator.js', () => jest.requireActual('../src/api/decorator/decorator'), { virtual: true });

import { AssetsApi } from '../src/api/assets/assets';
import { SchemaAssetImportOptions } from '../src/api/assets/schema';
import { importAssetPreservingMeta } from '../src/core/assets/manager/asset-import-meta';
import { copy, ensureDir, mkdtemp, outputFile, readJson, remove } from 'fs-extra';
import { realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('MCP preserve-meta import contract', () => {
    it('passes preserveMeta only on the import endpoint and exposes the importer cause in serialized reason', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cocos-meta-api-')));
        const source = join(root, 'external.png'), target = join(root, 'assets', 'image.png');
        await ensureDir(join(root, 'assets'));
        await outputFile(source, 'image bytes');
        await copy(join(__dirname, 'fixtures/projects/asset-operation/assets/default_btn_normal.png.meta'), `${source}.meta`);
        const uuid = (await readJson(`${source}.meta`)).uuid;
        const error = await importAssetPreservingMeta(source, target, { assertAvailable() {}, async importInstalled() { throw new Error(`Importer rejected ${uuid}`); } }).catch((value) => value);
        mockImportAsset.mockRejectedValueOnce(error);
        const log = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const options = SchemaAssetImportOptions.parse({ preserveMeta: true });
            const result = await new AssetsApi().importAsset(source, target, options);
            expect(mockImportAsset).toHaveBeenCalledWith(source, target, { preserveMeta: true });
            expect(result.code).toBe(500);
            expect(result.reason).toContain(`Importer rejected ${uuid}`);
            expect(JSON.parse(JSON.stringify(result)).reason).toContain('Files were retained');
        } finally { log.mockRestore(); await remove(root); }
    });
});
