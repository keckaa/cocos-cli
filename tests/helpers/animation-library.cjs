const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true });

const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-animation-library-'));

async function run(scenario) {
    const engineRoot = require(path.join(root, 'src/engine-root')).resolveEngineRoot(root);
    const devCli = path.join(engineRoot, 'bin/.cache/dev-cli');
    await require('cc/preload').default({
        engineRoot,
        engineDev: fs.existsSync(devCli) ? devCli : path.join(engineRoot, 'bin/.cache/dev'),
        writablePath: scratch,
        requiredModules: ['cc', 'cc/editor/populate-internal-constants', 'cc/editor/serialization',
            'cc/editor/new-gen-anim', 'cc/editor/embedded-player', 'cc/editor/exotic-animation'],
    });
    const cc = global.cc = require('cc');
    global.EditorExtends = require(path.join(root, 'src/core/engine/editor-extends/utils/serialize'));
    const { CCON, encodeCCONBinary, decodeCCONBinary } = require('cc/editor/serialization');
    const { serializeForLibrary } = require(path.join(root, 'src/core/assets/asset-handler/assets/utils/serialize-library'));
    const { getDependUUIDList } = require(path.join(root, 'src/core/assets/asset-handler/utils'));
    assert.equal(cc.VERSION, '3.8.8');
    assert.equal(cc.deserialize._macros, undefined);

    if (scenario === 'roundtrip') {
        const clip = new cc.AnimationClip();
        clip.name = 'library-fixture';
        clip.duration = 1;
        clip.events = [{ frame: 0.5, func: 'onHit', params: ['hit'] }];
        const track = new cc.animation.RealTrack();
        track.path.toProperty('angle');
        track.channel.curve.assignSorted([[0, { value: 0 }], [1, { value: 90 }]]);
        clip.addTrack(track);
        let current = clip;
        for (let i = 0; i < 3; i++) {
            const result = serializeForLibrary(current);
            assert.equal(result.extension, '.bin');
            const ccon = decodeCCONBinary(result.data);
            assert.equal(ccon.document[0].__type__, 'cc.AnimationClip');
            current = cc.deserialize(ccon);
            assert(current instanceof cc.AnimationClip);
            assert.equal(current.name, 'library-fixture');
            assert.equal(current.duration, 1);
            assert.deepEqual(current.events, [{ frame: 0.5, func: 'onHit', params: ['hit'] }]);
            assert.equal(current.tracksCount, 1);
            assert.equal([...current.tracks][0].channel.curve.evaluate(0.5), 45);
        }
        assert.equal(serializeForLibrary({ value: 7 }).extension, '.json');
        const fallback = JSON.parse(EditorExtends.serializeCompiled({ value: 7 }, {}));
        assert.equal(fallback.value, 7);
    } else if (scenario === 'dependencies') {
        const uuid = '04796f71-2f24-4b07-81d2-01f528b45157';
        const document = [{ __type__: 'cc.Sprite', _spriteFrame: { __uuid__: uuid, __expectedType__: 'cc.SpriteFrame' } }];
        const ccon = new CCON(document, []);
        assert.deepEqual(getDependUUIDList(JSON.stringify(document)), [uuid]);
        assert.deepEqual(getDependUUIDList(ccon), [uuid]);
        const binary = encodeCCONBinary(ccon);
        assert.deepEqual(getDependUUIDList(binary), [uuid]);
        const padded = Buffer.concat([Buffer.alloc(11), Buffer.from(binary), Buffer.alloc(7)]);
        assert.deepEqual(getDependUUIDList(padded.subarray(11, 11 + binary.length)), [uuid]);
        assert.throws(() => getDependUUIDList(new Uint8Array([1, 2, 3])));
    } else if (scenario === 'export') {
        const { assetManager } = require(path.join(root, 'src/core/assets'));
        const { ensureOutputData } = require(path.join(root, 'src/core/assets/utils'));
        for (const [files, expected] of [
            [['.bin'], { import: { type: 'buffer', path: 'fixture.bin' } }],
            [['.cconb'], { import: { type: 'buffer', path: 'fixture.cconb' } }],
            [['.json', '.bin'], { import: { type: 'json', path: 'fixture.json' }, native: { '.bin': 'fixture.bin' } }],
        ]) {
            const cache = {};
            const asset = { library: 'fixture', meta: { files }, getData: key => cache[key], setData: (key, data) => cache[key] = data };
            assert.deepEqual(ensureOutputData(asset), expected);
            delete cache.output;
            assert.deepEqual(await assetManager.generateExportData(asset), expected);
        }
    } else if (scenario === 'import') {
        const { AssetDB, Asset } = require('@cocos/asset-db');
        const handler = require(path.join(root, 'src/core/assets/asset-handler/assets/animation-clip')).default;
        const db = new AssetDB({ name: 'animation-fixture', target: path.join(scratch, 'assets'), library: path.join(scratch, 'library') });
        fs.mkdirSync(db.options.target, { recursive: true });
        fs.mkdirSync(db.options.library, { recursive: true });
        const source = path.join(db.options.target, 'fixture.anim');
        const clip = new cc.AnimationClip(); clip.duration = 1;
        const frame = new cc.SpriteFrame(); frame._uuid = '14796f71-2f24-4b07-81d2-01f528b45157';
        const objectTrack = new cc.animation.ObjectTrack();
        objectTrack.path.toComponent('cc.Sprite').toProperty('spriteFrame');
        objectTrack.channels()[0].curve.assignSorted([[0, frame]]);
        clip.addTrack(objectTrack);
        fs.writeFileSync(source, EditorExtends.serialize(clip));
        const uuid = '04796f71-2f24-4b07-81d2-01f528b45157';
        const asset = new Asset(source, { uuid, ver: '2.0.4', importer: 'animation-clip', imported: true, files: ['.json'], subMetas: {}, userData: {} }, db);
        fs.mkdirSync(path.dirname(asset.library), { recursive: true });
        fs.writeFileSync(`${asset.library}.json`, 'stale-cache');
        asset.setData('output', { import: { type: 'json', path: `${asset.library}.json` } });
        await asset.reset();
        assert.equal(await handler.importer.import(asset), true);
        assert.equal(asset.uuid, uuid);
        assert.deepEqual(asset.meta.files, ['.bin']);
        assert.deepEqual(asset.getData('depends'), [frame._uuid]);
        assert.equal(fs.existsSync(`${asset.library}.json`), false);
        const { assetManager } = require(path.join(root, 'src/core/assets'));
        const { ensureOutputData } = require(path.join(root, 'src/core/assets/utils'));
        const expectedOutput = { import: { type: 'buffer', path: `${asset.library}.bin` } };
        assert.deepEqual(await assetManager.generateExportData(asset), expectedOutput);
        assert.deepEqual(await assetManager.generateExportData(asset, {}), expectedOutput);
        assert.deepEqual(ensureOutputData(asset), expectedOutput);
        const imported = cc.deserialize(decodeCCONBinary(fs.readFileSync(`${asset.library}.bin`)));
        assert.equal(imported.duration, 1);
        await asset.reset();
        assert.equal(await handler.importer.import(asset), true);
        assert.deepEqual(asset.meta.files, ['.bin']);
        assert.equal(asset.uuid, uuid);
        assert.deepEqual(await assetManager.generateExportData(asset), expectedOutput);
    } else if (scenario === 'gltf') {
        const { AssetDB, Asset, VirtualAsset } = require('@cocos/asset-db');
        const { pathToFileURL } = require('node:url');
        const handler = require(path.join(root, 'src/core/assets/asset-handler/assets/gltf/animation')).default;
        const db = new AssetDB({ name: 'gltf-fixture', target: path.join(scratch, 'assets'), library: path.join(scratch, 'library') });
        fs.mkdirSync(db.options.target, { recursive: true });
        fs.mkdirSync(db.options.library, { recursive: true });
        const uuid = '04796f71-2f24-4b07-81d2-01f528b45157';
        const parent = new Asset(path.join(db.options.target, 'fixture.gltf'), { uuid, files: [], userData: {} }, db);
        const clip = new cc.AnimationClip(); clip.duration = 1;
        const frame = new cc.SpriteFrame(); frame._uuid = '14796f71-2f24-4b07-81d2-01f528b45157';
        cc.assetManager.assets.add(frame._uuid, frame);
        const objectTrack = new cc.animation.ObjectTrack();
        objectTrack.path.toComponent('cc.Sprite').toProperty('spriteFrame');
        objectTrack.channels()[0].curve.assignSorted([[0, frame]]);
        clip.addTrack(objectTrack);
        const track = new cc.animation.RealTrack();
        track.path.toProperty('angle');
        track.channel.curve.assignSorted([[0, { value: 0 }], [1, { value: 90 }]]);
        clip.addTrack(track);
        const original = serializeForLibrary(clip);
        assert.deepEqual(getDependUUIDList(original.data), [frame._uuid]);
        await parent.saveToLibrary('__original-animation-0.bin', original.data);
        const events = [{ frame: 0.25, func: 'onEvent', params: [1] }];
        const child = new VirtualAsset({ uuid: `${uuid}@clip`, files: ['.json'], userData: { gltfIndex: 0, events } }, 'fixture.animation', 'clip', db);
        child._parent = parent;
        fs.writeFileSync(`${child.library}.json`, 'stale-cache');
        child.setData('output', { import: { type: 'json', path: `${child.library}.json` } });
        await child.reset();
        const realLoadAny = cc.assetManager.loadAny;
        cc.assetManager.loadAny = (_request, _options, _progress, callback) => callback(null, clip);
        let imported;
        try {
            imported = await handler.importer.import(child);
        } finally {
            cc.assetManager.loadAny = realLoadAny;
        }
        assert.equal(imported, true);
        assert.deepEqual(child.meta.files, ['.bin']);
        assert.deepEqual(child.getData('depends'), [frame._uuid]);
        assert.equal(fs.existsSync(`${child.library}.json`), false);
        const { assetManager } = require(path.join(root, 'src/core/assets'));
        const { ensureOutputData } = require(path.join(root, 'src/core/assets/utils'));
        const expectedOutput = { import: { type: 'buffer', path: `${child.library}.bin` } };
        assert.deepEqual(await assetManager.generateExportData(child), expectedOutput);
        assert.deepEqual(await assetManager.generateExportData(child, {}), expectedOutput);
        assert.deepEqual(ensureOutputData(child), expectedOutput);
        const restored = cc.deserialize(decodeCCONBinary(fs.readFileSync(`${child.library}.bin`)));
        assert.equal(restored.duration, 1);
        assert.deepEqual(restored.events, events);
        assert.equal(restored.tracksCount, 2);
        assert.equal([...restored.tracks][1].channel.curve.evaluate(0.5), 45);
        // Loading by the engine's .cconb URL resolves to the stored .bin library file.
        const url = pathToFileURL(`${child.library}.bin`).href.replace(/\.bin$/, '.cconb');
        const loaded = await new Promise((resolve, reject) => {
            cc.assetManager.loadAny({ url }, { preset: 'remote' }, null, (error, data) => error ? reject(error) : resolve(data));
        });
        assert(loaded instanceof cc.AnimationClip);
        assert.deepEqual(loaded.events, events);
    } else {
        throw new Error(`Unknown scenario: ${scenario}`);
    }
    console.log(`PASS ${scenario}`);
}

run(process.argv[2]).then(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(0);
}, error => {
    console.error(error);
    fs.rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
});
