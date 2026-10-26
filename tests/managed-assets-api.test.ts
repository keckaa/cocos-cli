import 'reflect-metadata';

type FixtureAsset = Record<string, any>;

const fixtureAssets = new Map<string, FixtureAsset>();
const mockProbe = {
    capabilityVersion: '1.0.0',
    capabilities: ['managed-session-probe', 'managed-assets-query', 'managed-assets-create', 'managed-assets-import', 'managed-assets-replace', 'managed-assets-reimport', 'managed-assets-move', 'managed-assets-delete'],
    serviceName: 'cocos-cli',
    serviceVersion: 'test',
    serviceCommit: 'test-commit',
    creatorVersion: '3.8.8',
    enginePath: '/engine',
    engineDigest: 'a'.repeat(64),
    projectPath: '/fixture/project',
    projectIdentity: 'fixture-project',
    port: 9527,
    pid: 1,
    sessionNonce: 'fixture-session',
    schemaDigest: 'b'.repeat(64),
};

class MockManagedSessionError extends Error {
    constructor(message: string, readonly statusCode: 400 | 409 | 503 = 409) {
        super(message);
    }
}

function asset(path: string, overrides: FixtureAsset = {}): FixtureAsset {
    return {
        name: path.split('/').pop(),
        source: `/source/${path.split('/').pop()}`,
        loadUrl: `db://${path}`,
        url: `db://${path}`,
        file: path,
        uuid: `uuid-${path}`,
        importer: 'image',
        imported: true,
        invalid: false,
        type: 'cc.Texture2D',
        isDirectory: false,
        library: { json: `db://library/${path}.json` },
        depends: [],
        ...overrides,
    };
}

function seed(path: string, overrides: FixtureAsset = {}): FixtureAsset {
    const value = asset(path, overrides);
    fixtureAssets.set(path, value);
    return value;
}

jest.mock('../src/core/assets', () => ({
    assetManager: {
        queryAssetInfo: (path: string) => fixtureAssets.get(path) ?? [...fixtureAssets.values()].find((item) => item.uuid === path) ?? null,
        importAsset: async (source: string, target: string, options: { overwrite?: boolean }) => {
            if (fixtureAssets.has(target) && !options.overwrite) throw new Error(`Asset already exists: ${target}`);
            const previous = fixtureAssets.get(target);
            const value = asset(target, { ...(previous ?? {}), source, uuid: previous?.uuid ?? `uuid-${target}` });
            fixtureAssets.set(target, value);
            return [value];
        },
        createAsset: async (options: { target: string; uuid?: string }) => {
            if (fixtureAssets.has(options.target)) throw new Error(`Asset already exists: ${options.target}`);
            const value = asset(options.target, { uuid: options.uuid ?? `uuid-${options.target}` });
            fixtureAssets.set(options.target, value);
            return value;
        },
        reimportAsset: async (path: string) => fixtureAssets.get(path) ?? null,
        moveAsset: async (source: string, target: string) => {
            if (fixtureAssets.has(target)) throw new Error(`Asset already exists: ${target}`);
            const value = fixtureAssets.get(source);
            if (!value) throw new Error(`Asset not found: ${source}`);
            fixtureAssets.delete(source);
            const moved = { ...value, file: target, url: `db://${target}`, loadUrl: `db://${target}` };
            fixtureAssets.set(target, moved);
        },
        removeAsset: async (path: string) => {
            if (!fixtureAssets.delete(path)) throw new Error(`Asset not found: ${path}`);
        },
    },
}));

jest.mock('../src/mcp/managed-session', () => ({
    ManagedSessionError: MockManagedSessionError,
    getManagedSessionProbe: () => mockProbe,
    getManagedSessionReadiness: jest.fn(async () => ({
        sessionNonce: mockProbe.sessionNonce,
        projectIdentity: mockProbe.projectIdentity,
        projectRealpath: mockProbe.projectPath,
        assetDbReady: true,
        assetDbBusy: false,
        previewReady: true,
        ready: true,
        diagnostics: [],
    })),
    assertManagedRequest: jest.fn(() => mockProbe),
}));

import { ManagedAssetsApi } from '../src/api/managed/managed';
import { assertManagedRequest, getManagedSessionReadiness } from '../src/mcp/managed-session';

function request(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        sessionNonce: mockProbe.sessionNonce,
        projectIdentity: mockProbe.projectIdentity,
        projectRealpath: mockProbe.projectPath,
        ...extra,
    };
}

describe('ManagedAssetsApi fixture operations', () => {
    const api = new ManagedAssetsApi();

    beforeEach(() => {
        fixtureAssets.clear();
        jest.mocked(assertManagedRequest).mockReset().mockImplementation(() => mockProbe);
        jest.mocked(getManagedSessionReadiness).mockReset().mockResolvedValue({
            sessionNonce: mockProbe.sessionNonce,
            projectIdentity: mockProbe.projectIdentity,
            projectRealpath: mockProbe.projectPath,
            assetDbReady: true,
            assetDbBusy: false,
            previewReady: true,
            ready: true,
            diagnostics: [],
        });
    });

    it('returns an explicit 503 readiness response while AssetDB is not ready or busy', async () => {
        jest.mocked(getManagedSessionReadiness).mockResolvedValue({
            sessionNonce: mockProbe.sessionNonce,
            projectIdentity: mockProbe.projectIdentity,
            projectRealpath: mockProbe.projectPath,
            assetDbReady: false,
            assetDbBusy: false,
            previewReady: false,
            ready: false,
            diagnostics: ['AssetDB is not ready'],
        });
        const response = await api.sessionReadiness(request() as any);
        expect(response.code).toBe(503);
        expect(response.data?.ready).toBe(false);
        expect(response.reason).toMatch(/not ready/);
        const blocked = await api.query(request({ path: 'assets/blocked.png' }));
        expect(blocked.code).toBe(503);
        expect(blocked.data).toBeUndefined();
    });

    it('executes create/import/replace/reimport/move/delete/query with stable receipts', async () => {
        const created = await api.create(request({ target: 'assets/new.png', uuid: 'asset-new', content: 'x' }));
        expect(created.code).toBe(200);
        expect(created.data?.operation).toBe('create');

        const imported = await api.import(request({ source: '/source/hero.png', target: 'assets/hero.png', options: { overwrite: false, rename: false, expected: { type: 'cc.Texture2D' } } }));
        expect(imported.code).toBe(200);
        const beforeUuid = imported.data?.asset?.uuid;

        const replaced = await api.replace(request({ source: '/source/hero-v2.png', target: 'assets/hero.png', expected: { uuid: beforeUuid } }));
        expect(replaced.code).toBe(200);
        expect(replaced.data?.asset?.uuid).toBe(beforeUuid);

        const reimported = await api.reimport(request({ path: 'assets/hero.png', expected: { uuid: beforeUuid } }));
        expect(reimported.code).toBe(200);

        const moved = await api.move(request({ source: 'assets/hero.png', target: 'assets/moved.png', expected: { uuid: beforeUuid, path: 'assets/moved.png' } }));
        expect(moved.code).toBe(200);

        const queried = await api.query(request({ path: 'assets/moved.png', expected: { uuid: beforeUuid, path: 'assets/moved.png' } }));
        expect(queried.code).toBe(200);
        expect(queried.data?.asset?.uuid).toBe(beforeUuid);

        const deleted = await api.delete(request({ path: 'assets/moved.png', expected: { uuid: beforeUuid } }));
        expect(deleted.code).toBe(200);
        expect(deleted.data?.operation).toBe('delete');
    });

    it('fails closed for stale nonce/project identity and UUID/type/path drift', async () => {
        seed('assets/drift.png', { uuid: 'actual-uuid', type: 'cc.Texture2D' });
        jest.mocked(assertManagedRequest).mockImplementationOnce(() => {
            throw new MockManagedSessionError('Managed session nonce does not match', 409);
        });
        const stale = await api.query(request({ path: 'assets/drift.png' }));
        expect(stale.code).toBe(409);
        expect(stale.data).toBeUndefined();

        for (const expected of [
            { uuid: 'wrong-uuid' },
            { type: 'cc.SpriteFrame' },
            { path: 'assets/other.png' },
        ]) {
            const result = await api.query(request({ path: 'assets/drift.png', expected }));
            expect(result.code).toBe(409);
            expect(result.data?.status).toBe('failed');
            expect(result.data?.diagnostics[0]).toMatch(/mismatch/);
        }
    });

    it('rejects invalid imports and preserves depends/subAssets in receipts', async () => {
        seed('assets/invalid.png', { imported: false, invalid: true });
        const invalid = await api.query(request({ path: 'assets/invalid.png' }));
        expect(invalid.code).toBe(400);
        expect(invalid.data?.status).toBe('failed');

        seed('assets/atlas.plist', {
            type: 'cc.SpriteAtlas',
            importer: 'plist',
            depends: ['dep-uuid'],
            subAssets: {
                frame: asset('assets/atlas.plist', { uuid: 'atlas@frame', type: 'cc.SpriteFrame' }),
            },
        });
        seed('assets/font.fnt', {
            type: 'cc.BitmapFont',
            importer: 'bitmap-font',
            subAssets: {
                font: asset('assets/font.fnt', { uuid: 'font@sub', type: 'cc.BitmapFont' }),
            },
        });
        seed('assets/font.ttf', {
            type: 'cc.TTFFont',
            importer: 'ttf',
            subAssets: {
                font: asset('assets/font.ttf', { uuid: 'ttf@font', type: 'cc.TTFFont' }),
            },
        });
        seed('assets/spine.json', {
            type: 'cc.SkeletonData',
            importer: 'spine',
            depends: ['atlas-uuid'],
            subAssets: {
                skeleton: asset('assets/spine.json', { uuid: 'spine@skeleton', type: 'cc.SkeletonData' }),
            },
        });
        seed('assets/dep-uuid', { uuid: 'dep-uuid', type: 'cc.Texture2D' });
        seed('assets/atlas-uuid', { uuid: 'atlas-uuid', type: 'cc.Texture2D' });
        seed('assets/video.mp4', {
            type: 'cc.VideoClip',
            importer: 'video-clip',
            subAssets: {
                clip: asset('assets/video.mp4', { uuid: 'video@clip', type: 'cc.VideoClip' }),
            },
        });
        seed('assets/video-alpha-sbs.mp4', {
            type: 'cc.VideoClip',
            importer: 'video-clip',
            subAssets: {
                clip: asset('assets/video-alpha-sbs.mp4', { uuid: 'video-alpha@sbs', type: 'cc.VideoClip' }),
            },
        });
        for (const path of ['assets/atlas.plist', 'assets/font.fnt', 'assets/font.ttf', 'assets/spine.json', 'assets/video.mp4', 'assets/video-alpha-sbs.mp4']) {
            const compound = await api.query(request({ path }));
            expect(compound.code).toBe(200);
            expect(compound.data?.asset?.subAssets).toBeTruthy();
            expect(compound.data?.asset?.type).toMatch(/^cc\./);
        }

        seed('assets/atlas.png', {
            depends: ['dep-uuid'],
            subAssets: {
                sprite: asset('assets/atlas.png', { uuid: 'atlas@sprite', type: 'cc.SpriteFrame' }),
            },
        });
        const rich = await api.query(request({ path: 'assets/atlas.png' }));
        expect(rich.code).toBe(200);
        expect(rich.data?.asset?.depends).toEqual(['dep-uuid']);
        expect(rich.data?.asset?.subAssets).toMatchObject({ sprite: { uuid: 'atlas@sprite' } });
    });

    it('rejects implicit overwrite/rename, incomplete reimport, missing dependencies and stale identities', async () => {
        seed('assets/existing.png');
        const overwrite = await api.import(request({
            source: '/source/new.png',
            target: 'assets/existing.png',
            options: { overwrite: true, rename: false },
        }));
        expect(overwrite.code).toBe(400);
        expect(overwrite.data?.status).toBe('failed');

        const rename = await api.import(request({
            source: '/source/new.png',
            target: 'assets/new.png',
            options: { overwrite: false, rename: true },
        }));
        expect(rename.code).toBe(400);
        expect(rename.data?.status).toBe('failed');

        seed('assets/incomplete.png', { imported: false, invalid: false });
        const reimport = await api.reimport(request({ path: 'assets/incomplete.png' }));
        expect(reimport.code).toBe(400);
        expect(reimport.data?.status).toBe('failed');

        seed('assets/missing-dependency.png', { depends: ['missing-dependency'] });
        const missing = await api.query(request({ path: 'assets/missing-dependency.png' }));
        expect(missing.code).toBe(409);
        expect(missing.data?.status).toBe('failed');
        expect(missing.data?.diagnostics[0]).toMatch(/depend/i);

        seed('assets/incomplete-dependency.png', { depends: ['incomplete-dependency'] });
        seed('incomplete-dependency', { uuid: 'incomplete-dependency', imported: false, invalid: false });
        const incompleteDependency = await api.query(request({ path: 'assets/incomplete-dependency.png' }));
        expect(incompleteDependency.code).toBe(409);
        expect(incompleteDependency.data?.diagnostics[0]).toMatch(/incomplete|invalid/i);

        seed('assets/cycle-a.png', { uuid: 'cycle-a', depends: ['cycle-b'] });
        seed('assets/cycle-b.png', { uuid: 'cycle-b', depends: ['cycle-a'] });
        const cycle = await api.query(request({ path: 'assets/cycle-a.png' }));
        expect(cycle.code).toBe(409);
        expect(cycle.data?.diagnostics[0]).toMatch(/cycle/i);

        seed('assets/missing-library.png', { library: { json: '/definitely/missing/library.json' } });
        const missingLibrary = await api.query(request({ path: 'assets/missing-library.png' }));
        expect(missingLibrary.code).toBe(409);
        expect(missingLibrary.data?.diagnostics[0]).toMatch(/library/i);
    });
});
