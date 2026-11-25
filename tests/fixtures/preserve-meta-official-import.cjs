/*
 * Isolated real-importer regression. Does not open Creator, MCP or a game project.
 * Prerequisites: npm run build:asset-db && npm run build:cc-module
 * Run: node tests/fixtures/preserve-meta-official-import.cjs --engine-root /path/to/engine
 */
const repoRoot = require('path').resolve(__dirname, '../..');
process.chdir(repoRoot);
require('ts-node/register/transpile-only');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const assert = require('node:assert/strict');
const sharp = require('sharp');

async function main() {
    const engineArg = process.argv.indexOf('--engine-root');
    const engineRoot = engineArg >= 0 ? path.resolve(process.argv[engineArg + 1]) : require(path.join(repoRoot, 'config.local.json')).engine;
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cocos-preserve-meta-official-')));
    const preload = require(path.join(repoRoot, 'packages/cc-module/preload')).default;
    await preload({
        engineRoot,
        engineDev: path.join(engineRoot, 'bin/.cache/dev'),
        writablePath: path.join(root, 'runtime'),
        requiredModules: ['cc', 'cc/editor/populate-internal-constants', 'cc/editor/serialization', 'cc/editor/new-gen-anim', 'cc/editor/embedded-player', 'cc/editor/reflection-probe', 'cc/editor/lod-group-utils', 'cc/editor/material', 'cc/editor/2d-misc', 'cc/editor/offline-mappings', 'cc/editor/custom-pipeline', 'cc/editor/animation-clip-migration', 'cc/editor/exotic-animation', 'cc/editor/color-utils'],
    });
    global.EditorExtends = require(path.join(repoRoot, 'src/core/engine/editor-extends'));
    await global.EditorExtends.init();
    const { AssetDB, Importer } = require('@cocos/asset-db');
    const handlers = [
        [require(path.join(repoRoot, 'src/core/assets/asset-handler/assets/image')).default, ['.png']],
        [require(path.join(repoRoot, 'src/core/assets/asset-handler/assets/texture')).default, ['-']],
        [require(path.join(repoRoot, 'src/core/assets/asset-handler/assets/sprite-frame')).default, ['-']],
        [require(path.join(repoRoot, 'src/core/assets/asset-handler/assets/spine')).default, ['.json']],
    ];
    const { importAssetPreservingMeta, importMetaIdentity, assertImportMetaIdentity } = require(path.join(repoRoot, 'src/core/assets/manager/asset-import-meta'));
    const fixture = path.join(repoRoot, 'tests/fixtures/projects/asset-operation/assets/default_btn_normal.png');
    const results = [];
    async function databaseCase(name, prepare) {
        const caseRoot = path.join(root, name), assets = path.join(caseRoot, 'assets'), library = path.join(caseRoot, 'library'), temp = path.join(caseRoot, 'temp'), source = path.join(caseRoot, 'source');
        await Promise.all([assets, library, temp, source].map((p) => fs.ensureDir(p)));
        const database = new AssetDB({ name, target: assets, library, temp, readonly: false, ignoreFiles: [], level: 0 });
        for (const [handler, extensions] of handlers) {
            const HandlerImporter = class extends Importer {
                get name() { return handler.name; }
                get version() { return handler.importer.version; }
                async validate(asset) { return handler.validate ? handler.validate(asset) : true; }
                async import(asset) { return handler.importer.import.call(handler, asset); }
            };
            database.importerManager.add(HandlerImporter, extensions);
        }
        await database.start();
        async function importPair(name) {
            const from = path.join(source, name), target = path.join(assets, name);
            const expected = importMetaIdentity(await fs.readJson(`${from}.meta`));
            return importAssetPreservingMeta(from, target, {
                assertAvailable(_target, identities) {
                    for (const identity of identities.values()) assert(!database.uuid2asset.has(identity.uuid.split('@')[0]), `UUID occupied: ${identity.uuid}`);
                },
                async importInstalled(file) {
                    await database.refresh(file);
                    const asset = database.path2asset.get(file);
                    assert(asset?.imported && !asset.invalid, asset?.importError?.message || 'Root import failed');
                    assertImportMetaIdentity(expected, asset.meta);
                    const receipt = [];
                    function collect(current) {
                        assert(current.imported && !current.invalid, current.importError?.message || `Subasset import failed: ${current.uuid}`);
                        receipt.push({ uuid: current.uuid, importer: current.meta.importer, imported: current.imported });
                        Object.values(current.subAssets).forEach(collect);
                    }
                    collect(asset);
                    assert.deepEqual(new Set(receipt.map((item) => item.uuid)), new Set([...importMetaIdentity(asset.meta).values()].map((item) => item.uuid)));
                    return { asset, receipt };
                },
            });
        }
        try { await prepare({ source, assets, importPair }); }
        finally { await database.stop(); }
    }
    try {
        for (const resized of [false, true]) await databaseCase(resized ? 'image-resized' : 'image-same', async ({ source, importPair }) => {
            const image = path.join(source, 'image.png');
            if (resized) await sharp(fixture).resize(80, 80).png().toFile(image);
            else await fs.copy(fixture, image);
            await fs.copy(`${fixture}.meta`, `${image}.meta`);
            const { asset, receipt } = await importPair('image.png');
            assert.equal(asset.subAssets.f9941.userData.rawWidth, resized ? 80 : 40);
            assert.equal(asset.subAssets.f9941.userData.rawHeight, resized ? 80 : 40);
            results.push({ test: resized ? 'image-resized-valid-nine-slice' : 'image-same-content', receipt });
        });
        await databaseCase('spine-atlas-star', async ({ source, importPair }) => {
            const atlasUuid = '725a3a80-baca-4d0e-b45c-84f2319326b2';
            const skeletonUuid = '725a3a80-baca-4d0e-b45c-84f2319326b3';
            await fs.copy(fixture, path.join(source, 'sheet.png'));
            await fs.copy(`${fixture}.meta`, path.join(source, 'sheet.png.meta'));
            await fs.outputFile(path.join(source, 'sheet.atlas'), 'sheet.png\nsize: 40,40\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\n');
            await fs.outputJson(path.join(source, 'sheet.atlas.meta'), { ver: '1.0.0', importer: '*', imported: true, uuid: atlasUuid, files: ['.atlas', '.json'], subMetas: {}, userData: {} });
            await fs.outputJson(path.join(source, 'sheet.json'), { skeleton: { spine: '3.8.75' }, bones: [{ name: 'root' }], slots: [], skins: [], animations: {} });
            await fs.outputJson(path.join(source, 'sheet.json.meta'), { ver: '1.2.7', importer: 'spine-data', imported: true, uuid: skeletonUuid, files: ['.json'], subMetas: {}, userData: { atlasUuid } });
            const image = await importPair('sheet.png');
            const atlas = await importPair('sheet.atlas');
            const skeleton = await importPair('sheet.json');
            assert.equal(atlas.asset.uuid, atlasUuid);
            assert.equal(atlas.asset.meta.importer, '*');
            assert.equal(skeleton.asset.uuid, skeletonUuid);
            assert.equal(skeleton.asset.userData.atlasUuid, atlasUuid);
            const serialized = await fs.readJson(`${skeleton.asset.library}.json`);
            const text = JSON.stringify(serialized);
            assert(text.includes('sheet.png'));
            results.push({ test: 'spine-atlas-wildcard-with-image-dependency', receipt: [...image.receipt, ...atlas.receipt, ...skeleton.receipt] });
        });
        console.log('PRESERVE_META_OFFICIAL_IMPORT', JSON.stringify(results));
    } finally { await fs.remove(root); }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
