import { copy, ensureDir, existsSync, mkdtemp, outputFile, outputJson, readFile, readJson, readdir, remove } from 'fs-extra';
import { AssetDB, Importer, Asset, queryAsset } from '@cocos/asset-db';
import { link, realpath, symlink, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { assetImportPreserveMetaCapability, assertImportMetaIdentity, importAssetPreservingMeta, importMetaIdentity } from '../manager/asset-import-meta';
import { getFileSystemProvider, resetFileSystemProvider, setFileSystemProvider } from '../manager/filesystem';
import assetDBManager from '../manager/asset-db';
import { assetOperation } from '../manager/operation';
import { SchemaAssetImportOptions } from '../../../api/assets/schema';

const IMAGE_META = join(__dirname, '../../../../tests/fixtures/projects/asset-operation/assets/default_btn_normal.png.meta');

describe('preserve-meta external asset import', () => {
    let root: string;
    let source: string;
    let target: string;
    let assertAvailable: jest.Mock;
    let importInstalled: jest.Mock;
    const host = () => ({ assertAvailable, importInstalled });

    beforeEach(async () => {
        resetFileSystemProvider();
        root = await realpath(await mkdtemp(join(tmpdir(), 'cocos-preserve-meta-')));
        source = join(root, 'external', 'image.png');
        target = join(root, 'assets', 'image.png');
        await ensureDir(join(root, 'assets'));
        await outputFile(source, 'image bytes');
        await copy(IMAGE_META, `${source}.meta`);
        assertAvailable = jest.fn();
        importInstalled = jest.fn(async () => 'imported');
    });
    afterEach(async () => { resetFileSystemProvider(); await remove(root); });

    it('preserves all image identities and settings before official importer observation', async () => {
        const original = await readJson(`${source}.meta`);
        importInstalled.mockImplementationOnce(async () => {
            expect(await readJson(`${target}.meta`)).toEqual(original);
            expect(await readFile(target, 'utf8')).toBe('image bytes');
            return 'imported';
        });
        await expect(importAssetPreservingMeta(source, target, host())).resolves.toBe('imported');
        expect(await readJson(`${source}.meta`)).toEqual(original);
        expect([...importMetaIdentity(original).keys()]).toEqual(['', '6c48a', 'f9941']);
        expect(await readdir(join(root, 'assets'))).toEqual(['image.png', 'image.png.meta']);
    });

    it('imports a legal long basename without appending it to staging names', async () => {
        const name = `${'a'.repeat(216)}.png`;
        target = join(root, 'assets', name);

        await expect(importAssetPreservingMeta(source, target, host())).resolves.toBe('imported');
        expect(await readdir(join(root, 'assets'))).toEqual([name, `${name}.meta`]);
    });

    it('detects a staged source whose bytes changed without changing its size', async () => {
        const native = getFileSystemProvider();
        setFileSystemProvider({
            installNoReplace: native.installNoReplace,
            copy: async (from, to, options) => {
                await native.copy!(from, to, options);
                if (from === source) await outputFile(to, 'other bytes');
            },
        });

        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('file changed during import');
        expect(importInstalled).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'assets'))).toEqual([]);
    });

    it('accepts wildcard importers used by new Spine atlas resources', async () => {
        const meta = { ver: '1.0.0', importer: '*', imported: true, uuid: 'ecbe5724-4eea-4d0f-8fef-8c955132b154', files: ['.atlas', '.json'], subMetas: {}, userData: {} };
        await outputFile(source.replace('.png', '.atlas'), 'atlas');
        const atlasSource = source.replace('.png', '.atlas');
        const atlasTarget = target.replace('.png', '.atlas');
        await outputJson(`${atlasSource}.meta`, meta);
        await expect(importAssetPreservingMeta(atlasSource, atlasTarget, host())).resolves.toBe('imported');
        const importedIdentity = importMetaIdentity(await readJson(`${atlasTarget}.meta`));
        expect(importedIdentity.get('')?.uuid).toBe(meta.uuid);
        expect(() => assertImportMetaIdentity(importMetaIdentity(meta), { ...meta, importer: 'spine-atlas-fixture' })).not.toThrow();
    });

    it('returns the inherited image, texture, and SpriteFrame identities through asset import and real AssetDB refresh', async () => {
        const outerRoot = join(root, 'outer-assets');
        const assetRoot = join(outerRoot, 'actual-assets');
        const library = join(root, 'actual-library');
        const temp = join(root, 'actual-temp');
        const sourceRoot = join(root, 'actual-source');
        await Promise.all([assetRoot, library, temp, sourceRoot].map((dir) => ensureDir(dir)));
        const imageSource = join(sourceRoot, 'image.png');
        const imageTarget = join(assetRoot, 'image.png');
        await copy(join(__dirname, '../../../../tests/fixtures/projects/asset-operation/assets/default_btn_normal.png'), imageSource);
        await copy(IMAGE_META, `${imageSource}.meta`);
        const original = await readJson(`${imageSource}.meta`);
        class ImageImporter extends Importer {
            get name() { return 'image'; }
            get version() { return original.ver; }
            async import(asset: Asset) {
                await asset.copyToLibrary('.png', asset.source);
                await asset.createSubAsset('texture', 'texture', { id: '6c48a' });
                await asset.createSubAsset('spriteFrame', 'sprite-frame', { id: 'f9941' });
                return true;
            }
        }
        class TextureImporter extends Importer {
            get name() { return 'texture'; }
            get version() { return '1.0.22'; }
            async import(asset: Asset) { await asset.saveToLibrary('.json', '{}'); return true; }
        }
        class SpriteFrameImporter extends Importer {
            get name() { return 'sprite-frame'; }
            get version() { return '1.0.12'; }
            async import(asset: Asset) { await asset.saveToLibrary('.json', '{}'); return true; }
        }
        const database = new AssetDB({ name: 'fixture', target: assetRoot, library, temp, level: 0, readonly: false, ignoreFiles: [] });
        const outer = new AssetDB({ ...database.options, name: 'outer', target: outerRoot, readonly: true });
        database.importerManager.add(ImageImporter, ['.png']);
        database.importerManager.add(TextureImporter, ['-']);
        database.importerManager.add(SpriteFrameImporter, ['-']);
        await database.start();
        assetDBManager.assetDBMap.outer = outer;
        assetDBManager.assetDBInfo.outer = { ...outer.options, state: 'startup', visible: true, preImportExtList: [] };
        assetDBManager.assetDBMap.fixture = database;
        assetDBManager.assetDBInfo.fixture = { ...database.options, state: 'startup', visible: true, preImportExtList: [] };
        try {
            const [receipt] = await assetOperation.importAsset(imageSource, 'db://fixture/image.png', { preserveMeta: true });
            expect(receipt).toMatchObject({
                uuid: original.uuid,
                file: imageTarget,
                imported: true,
                invalid: false,
                subAssets: {
                    '6c48a': { uuid: original.subMetas['6c48a'].uuid, imported: true },
                    f9941: { uuid: original.subMetas.f9941.uuid, imported: true },
                },
            });
            const asset = database.path2asset.get(imageTarget)!;
            expect(asset.uuid).toBe(original.uuid);
            expect(asset.subAssets['6c48a'].uuid).toBe(original.subMetas['6c48a'].uuid);
            expect(asset.subAssets['f9941'].uuid).toBe(original.subMetas['f9941'].uuid);
            expect(database.uuid2asset.has(original.uuid)).toBe(true);
            expect(queryAsset(original.subMetas['6c48a'].uuid)?.uuid).toBe(original.subMetas['6c48a'].uuid);
            expect(queryAsset(original.subMetas['f9941'].uuid)?.uuid).toBe(original.subMetas['f9941'].uuid);
        } finally {
            delete assetDBManager.assetDBMap.outer;
            delete assetDBManager.assetDBInfo.outer;
            delete assetDBManager.assetDBMap.fixture;
            delete assetDBManager.assetDBInfo.fixture;
            await database.stop();
        }
    });

    it('preserves wildcard atlas UUID through the actual AssetDB importer', async () => {
        const assetRoot = join(root, 'actual-atlas-assets');
        const library = join(root, 'actual-atlas-library');
        const temp = join(root, 'actual-atlas-temp');
        const sourceRoot = join(root, 'atlas-source');
        await Promise.all([assetRoot, library, temp, sourceRoot].map((dir) => ensureDir(dir)));
        const atlasSource = join(sourceRoot, 'sheet.atlas');
        const atlasTarget = join(assetRoot, 'sheet.atlas');
        await outputFile(atlasSource, 'atlas data');
        await outputJson(`${atlasSource}.meta`, { ver: '1.0.0', importer: '*', imported: true, uuid: '725a3a80-baca-4d0e-b45c-84f2319326b2', files: ['.atlas', '.json'], subMetas: {}, userData: {} });
        class AtlasImporter extends Importer {
            get name() { return 'spine-atlas-fixture'; }
            get version() { return '1.0.0'; }
            async import(asset: Asset) { await asset.copyToLibrary('.atlas', asset.source); return true; }
        }
        const database = new AssetDB({ name: 'atlas-fixture', target: assetRoot, library, temp, level: 0, readonly: false, ignoreFiles: [] });
        database.importerManager.add(AtlasImporter, ['.atlas']);
        await database.start();
        try {
            const live = await importAssetPreservingMeta(atlasSource, atlasTarget, {
                assertAvailable: (_target, identities) => {
                    if (database.uuid2asset.has(identities.get('')!.uuid)) throw new Error('occupied');
                },
                importInstalled: async (targetPath) => {
                    await database.metaManager.get(`${targetPath}.meta`);
                    await database.refresh(targetPath);
                    const asset = database.path2asset.get(targetPath)!;
                    expect(asset.meta.importer).toBe('spine-atlas-fixture');
                    return asset.uuid;
                },
            });
            expect(live).toBe('725a3a80-baca-4d0e-b45c-84f2319326b2');
            expect(database.path2asset.get(atlasTarget)?.uuid).toBe(live);
        } finally { await database.stop(); }
    });

    it('supports nested compound asset identities', async () => {
        const compound = await readJson(IMAGE_META);
        const texture = compound.subMetas['6c48a'];
        texture.subMetas = { face: { id: 'face', uuid: `${texture.uuid}@face`, importer: 'texture' } };
        await outputJson(`${source}.meta`, compound);
        await importAssetPreservingMeta(source, target, host());
        expect(importMetaIdentity(await readJson(`${target}.meta`))).toEqual(importMetaIdentity(compound));
        expect([...importMetaIdentity(compound).keys()].some((role) => role.split('/').length > 1)).toBe(true);
    });

    it('accepts preserveMeta at the MCP asset-import option boundary', () => {
        expect(SchemaAssetImportOptions.parse({ preserveMeta: true })).toEqual({ preserveMeta: true });
        expect(SchemaAssetImportOptions.parse({ preserveMeta: false, overwrite: false, rename: false })).toEqual({ preserveMeta: false, overwrite: false, rename: false });
    });

    it('advertises the capability only when the provider opts into atomic no-replace publication', async () => {
        expect(assetImportPreserveMetaCapability()).toEqual({ schemaVersion: 1 });
        setFileSystemProvider({ copy });
        expect(assetImportPreserveMetaCapability()).toBeUndefined();
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('installNoReplace support');
        expect(await readdir(join(root, 'assets'))).toEqual([]);
    });

    it.each(['main file', 'sidecar'])('rejects an existing target %s before writing', async (kind) => {
        await outputFile(kind === 'main file' ? target : `${target}.meta`, 'existing');
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('must both be absent');
        expect(importInstalled).not.toHaveBeenCalled();
    });

    it('rejects missing, malformed, and symlink sidecars before writing', async () => {
        await remove(`${source}.meta`);
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow();
        await outputFile(`${source}.meta`, '{');
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow();
        await remove(`${source}.meta`);
        await symlink(IMAGE_META, `${source}.meta`);
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('ordinary file');
        expect(await readdir(join(root, 'assets'))).toEqual([]);
    });

    it('rejects registry or UUID conflicts before staging', async () => {
        assertAvailable.mockImplementation(() => { throw new Error('occupied UUID'); });
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('occupied UUID');
        expect(await readdir(join(root, 'assets'))).toEqual([]);
    });

    it('rejects a concurrent preserve import using the same root or child UUID', async () => {
        let finish!: () => void;
        let entered!: () => void;
        const begun = new Promise<void>((resolve) => { entered = resolve; });
        const wait = new Promise<void>((resolve) => { finish = resolve; });
        importInstalled.mockImplementationOnce(async () => { entered(); await wait; return 'done'; });
        const first = importAssetPreservingMeta(source, target, host());
        await Promise.race([begun, first]);
        await expect(importAssetPreservingMeta(source, join(root, 'assets', 'other.png'), host())).rejects.toThrow('reserved by another import');
        finish();
        await first;
    });

    it('keeps the sidecar when a competing main file becomes visible during publication', async () => {
        const native = getFileSystemProvider();
        setFileSystemProvider({ installNoReplace: async (from, to) => {
            if (to === target) await outputFile(to, 'competitor');
            await native.installNoReplace!(from, to);
        } });
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow();
        expect(await readFile(target, 'utf8')).toBe('competitor');
        expect(existsSync(`${target}.meta`)).toBe(true);
        expect(importInstalled).not.toHaveBeenCalled();
        expect(await readdir(join(root, 'assets'))).toEqual(['image.png', 'image.png.meta']);
    });

    it('cleans an owned sidecar when main publication fails before any main file exists', async () => {
        const native = getFileSystemProvider();
        setFileSystemProvider({ installNoReplace: async (from, to) => {
            if (to === target) throw new Error('no space before main publication');
            await native.installNoReplace!(from, to);
        } });
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('no space before main publication');
        expect(existsSync(target)).toBe(false);
        expect(existsSync(`${target}.meta`)).toBe(false);
        expect(await readdir(join(root, 'assets'))).toEqual([]);
    });

    it('retains a competing replacement instead of deleting it during early cleanup', async () => {
        const native = getFileSystemProvider();
        setFileSystemProvider({ installNoReplace: async (from, to) => {
            if (to === target) {
                await unlink(`${target}.meta`);
                await outputFile(`${target}.meta`, 'competitor sidecar');
                throw new Error('disk full');
            }
            await native.installNoReplace!(from, to);
        } });
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('Safe cleanup was incomplete');
        expect(await readFile(`${target}.meta`, 'utf8')).toBe('competitor sidecar');
    });

    it('retains a main file when a provider reports failure after publication', async () => {
        const native = getFileSystemProvider();
        setFileSystemProvider({ installNoReplace: async (from, to) => {
            await native.installNoReplace!(from, to);
            if (to === target) throw new Error('provider failed after install');
        } });
        await expect(importAssetPreservingMeta(source, target, host())).rejects.toThrow('failed after the target became visible: provider failed after install');
        expect(existsSync(target)).toBe(true);
        expect(existsSync(`${target}.meta`)).toBe(true);
        expect(importInstalled).not.toHaveBeenCalled();
    });

    it('retains published files and original cause on importer failure', async () => {
        const error = new Error('importer failed');
        importInstalled.mockRejectedValueOnce(error);
        const failure = await importAssetPreservingMeta(source, target, host()).catch((value) => value);
        expect((failure as Error).message).toContain('failed after the target became visible');
        expect((failure as Error).message).toContain(error.message);
        expect((failure as Error).message).toContain('recalibrate AssetDB');
        expect((failure as Error & { cause?: unknown }).cause).toBe(error);
        expect(existsSync(target)).toBe(true);
        expect(existsSync(`${target}.meta`)).toBe(true);
        expect(await readdir(join(root, 'assets'))).toEqual(['image.png', 'image.png.meta']);
    });

    it('rejects identity reassignment but permits importer removal of obsolete roles', async () => {
        const expected = await readJson(`${source}.meta`);
        const identities = importMetaIdentity(expected);
        expect(() => assertImportMetaIdentity(identities, { ...expected, uuid: '10000000-0000-4000-8000-000000000001', subMetas: {} })).toThrow('root identity');
        const changed = JSON.parse(JSON.stringify(expected));
        changed.subMetas['6c48a'].importer = 'renamed-importer';
        changed.subMetas['6c48a'].uuid = `${changed.uuid}@6c48a`;
        expect(() => assertImportMetaIdentity(identities, changed)).toThrow('importer changed');
        changed.subMetas['6c48a'].importer = 'texture';
        expect(() => assertImportMetaIdentity(identities, changed)).not.toThrow();
        changed.subMetas['6c48a'].uuid = `${changed.uuid}@changed`;
        expect(() => assertImportMetaIdentity(identities, changed)).toThrow('inconsistent subasset');
        changed.subMetas['6c48a'].uuid = `${changed.uuid}@6c48a`;
        delete changed.subMetas['f9941'];
        expect(() => assertImportMetaIdentity(identities, changed)).not.toThrow();
        changed.subMetas['6c48a'].uuid = `${changed.uuid}@different`;
        expect(() => assertImportMetaIdentity(identities, changed)).toThrow('inconsistent subasset');
    });

    it('cleans the private meta witness when importer rewrites shared metadata', async () => {
        importInstalled.mockImplementationOnce(async () => {
            const meta = await readJson(`${target}.meta`);
            meta.ver = 'next';
            await outputJson(`${target}.meta`, meta);
            return 'done';
        });
        await expect(importAssetPreservingMeta(source, target, host())).resolves.toBe('done');
        expect(await readdir(join(root, 'assets'))).toEqual(['image.png', 'image.png.meta']);
    });

    it('reports cleanup failure without hiding an importer error', async () => {
        const error = new Error('original importer cause');
        setFileSystemProvider({ installNoReplace: link, delete: async () => { throw new Error('cleanup denied'); } });
        importInstalled.mockRejectedValueOnce(error);
        const failure = await importAssetPreservingMeta(source, target, host()).catch((value) => value);
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError & { cause?: Error }).cause?.cause).toBe(error);
        expect((failure as AggregateError).errors.some((entry: Error) => entry.message === 'cleanup denied')).toBe(true);
        expect(existsSync(target)).toBe(true);
    });
});
