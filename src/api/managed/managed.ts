import { createHash } from 'crypto';
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { assetManager } from '../../core/assets';
import type { IAssetInfo } from '../../core/assets/@types/public';
import { description, param, result, title, tool } from '../decorator/decorator';
import { HTTP_STATUS, HttpStatusCode } from '../base/schema-base';
import {
    SchemaImportReceipt,
    SchemaManagedCreate,
    SchemaManagedDelete,
    SchemaManagedImport,
    SchemaManagedMove,
    SchemaManagedPath,
    SchemaManagedQuery,
    SchemaManagedReplace,
    SchemaManagedSessionProbe,
    SchemaManagedSessionProbeRequest,
    type ImportReceipt,
    type ManagedExpectedAsset,
    type ManagedRequest,
    type ManagedSessionProbeRequest,
} from './schema';
import {
    assertManagedRequest,
    getManagedSessionProbe,
    ManagedSessionError,
    type ManagedSessionProbe,
} from '../../mcp/managed-session';

type ManagedResult<T> = {
    code: HttpStatusCode;
    data?: T;
    reason?: string;
};

function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function digest(value: unknown): string {
    return createHash('sha256').update(stableJson(value)).digest('hex');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function statusForError(error: unknown): HttpStatusCode {
    if (error instanceof ManagedSessionError) {
        return error.statusCode;
    }
    const message = errorMessage(error);
    if (/not found|not exist|cannot find|can not find|ENOENT/i.test(message)) {
        return HTTP_STATUS.NOT_FOUND;
    }
    if (/already exists|overwrite|rename|conflict|mismatch|does not match|invalid|must include|unsupported|depend/i.test(message)) {
        if (/depend/i.test(message) && !/invalid/i.test(message)) return HTTP_STATUS.CONFLICT;
        return HTTP_STATUS.BAD_REQUEST;
    }
    return HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

function normalizeAssetInfo(info: IAssetInfo | null | undefined): any {
    if (!info) {
        return null;
    }
    const result: any = {
        name: info.name,
        source: info.source,
        loadUrl: info.loadUrl,
        url: info.url,
        file: info.file,
        uuid: info.uuid,
        importer: info.importer,
        imported: info.imported,
        invalid: info.invalid,
        type: info.type,
        isDirectory: info.isDirectory,
        library: info.library,
        depends: info.depends ?? [],
        redirect: info.redirect,
    };
    if (info.subAssets) {
        result.subAssets = Object.fromEntries(Object.entries(info.subAssets).map(([key, value]) => [key, normalizeAssetInfo(value)]));
    }
    return result;
}

function assetPathMatches(info: any, expectedPath: string): boolean {
    const candidates = [info?.file, info?.source, info?.url].filter((item): item is string => typeof item === 'string');
    if (candidates.includes(expectedPath)) {
        return true;
    }
    if (expectedPath.startsWith('db://')) {
        return false;
    }
    try {
        return candidates.some((candidate) => {
            try {
                return realpathSync(resolve(candidate)) === realpathSync(resolve(expectedPath));
            } catch {
                return resolve(candidate) === resolve(expectedPath);
            }
        });
    } catch {
        return false;
    }
}

function assertExpected(info: any, expected?: ManagedExpectedAsset): void {
    if (!expected) {
        return;
    }
    if (expected.uuid && info?.uuid !== expected.uuid) {
        throw new ManagedSessionError(`Managed asset UUID mismatch: expected ${expected.uuid}, got ${info?.uuid || '(missing)'}`, 409);
    }
    if (expected.type && String(info?.type) !== expected.type) {
        throw new ManagedSessionError(`Managed asset type mismatch: expected ${expected.type}, got ${String(info?.type)}`, 409);
    }
    if (expected.path && !assetPathMatches(info, expected.path)) {
        throw new ManagedSessionError(`Managed asset path mismatch: expected ${expected.path}, got ${info?.file || info?.url || '(missing)'}`, 409);
    }
}

function assertNoImplicitRename(options?: { overwrite?: boolean; rename?: boolean }): void {
    if (options?.overwrite || options?.rename) {
        throw new ManagedSessionError('Managed asset operations must use overwrite:false and rename:false; use replace for an explicit replacement.', 400);
    }
}

export class ManagedAssetsApi {
    @tool('managed-session-probe')
    @title('Probe Managed Cocos CLI Session')
    @description('Return the verified managed MCP session identity, project identity, Creator engine digest and versioned capabilities. Optional expectations reject stale or wrong service sessions.')
    @result(SchemaManagedSessionProbe)
    async sessionProbe(@param(SchemaManagedSessionProbeRequest) request?: ManagedSessionProbeRequest): Promise<ManagedResult<ManagedSessionProbe>> {
        try {
            const probe = getManagedSessionProbe();
            this.assertProbeExpectations(probe, request);
            return { code: HTTP_STATUS.OK, data: probe };
        } catch (error) {
            return { code: statusForError(error), reason: errorMessage(error) };
        }
    }

    private assertProbeExpectations(probe: ManagedSessionProbe, request?: ManagedSessionProbeRequest): void {
        if (!request) {
            return;
        }
        if (request.expectedProjectRealpath && realpathSync(resolve(request.expectedProjectRealpath)) !== probe.projectPath) {
            throw new ManagedSessionError(`Managed project realpath does not match: ${request.expectedProjectRealpath}`, 409);
        }
        if (request.expectedProjectIdentity && request.expectedProjectIdentity !== probe.projectIdentity) {
            throw new ManagedSessionError('Managed project identity does not match', 409);
        }
        if (request.expectedPort !== undefined && request.expectedPort !== probe.port) {
            throw new ManagedSessionError(`Managed port does not match: expected ${request.expectedPort}, got ${probe.port}`, 409);
        }
        if (request.expectedServiceCommit && request.expectedServiceCommit !== probe.serviceCommit) {
            throw new ManagedSessionError('Managed service commit does not match', 409);
        }
        if (request.expectedSchemaDigest && request.expectedSchemaDigest !== probe.schemaDigest) {
            throw new ManagedSessionError('Managed capability schema digest does not match', 409);
        }
    }

    @tool('managed-assets-query')
    @title('Query Managed Asset')
    @description('Query one asset through the versioned managed capability and return a stable ImportReceipt.')
    @result(SchemaImportReceipt)
    async query(@param(SchemaManagedQuery) request: any): Promise<ManagedResult<ImportReceipt>> {
        return this.run('query', request, async () => {
            const info = assetManager.queryAssetInfo(request.path);
            if (!info) {
                throw new Error(`Asset not found: ${request.path}`);
            }
            const normalized = normalizeAssetInfo(info);
            assertExpected(normalized, request.expected);
            this.assertImported(normalized);
            return { asset: normalized, assets: [normalized] };
        });
    }

    @tool('managed-assets-import')
    @title('Import Managed Asset')
    @description('Import an external asset with deterministic no-overwrite and no-rename semantics, returning an ImportReceipt.')
    @result(SchemaImportReceipt)
    async import(@param(SchemaManagedImport) request: any): Promise<ManagedResult<ImportReceipt>> {
        return this.run('import', request, async () => {
            assertNoImplicitRename(request.options);
            const infos = await assetManager.importAsset(request.source, request.target, { overwrite: false, rename: false });
            const assets = infos.map(normalizeAssetInfo);
            const asset = assets[0] ?? null;
            assertExpected(asset, request.options?.expected);
            this.assertImported(asset);
            return { asset, assets };
        }, request.source, request.target);
    }

    @tool('managed-assets-create')
    @title('Create Managed Asset')
    @description('Create an asset with deterministic no-overwrite and no-rename semantics, returning an ImportReceipt.')
    @result(SchemaImportReceipt)
    async create(@param(SchemaManagedCreate) request: any): Promise<ManagedResult<ImportReceipt>> {
        return this.run('create', request, async () => {
            const info = await assetManager.createAsset({
                target: request.target,
                content: request.content,
                template: request.template,
                uuid: request.uuid,
                userData: request.userData,
                customOptions: request.customOptions,
                overwrite: false,
                rename: false,
            });
            const asset = normalizeAssetInfo(info);
            assertExpected(asset, request.expected);
            this.assertImported(asset);
            return { asset, assets: asset ? [asset] : [] };
        }, undefined, request.target);
    }

    @tool('managed-assets-replace')
    @title('Replace Managed Asset')
    @description('Replace an existing asset source while preserving its destination metadata and UUID, then explicitly reimport it.')
    @result(SchemaImportReceipt)
    async replace(@param(SchemaManagedReplace) request: any): Promise<ManagedResult<ImportReceipt>> {
        return this.run('replace', request, async () => {
            const before = assetManager.queryAssetInfo(request.target);
            if (!before) {
                throw new Error(`Asset not found: ${request.target}`);
            }
            const expectedUuid = before.uuid;
            const infos = await assetManager.importAsset(request.source, request.target, { overwrite: true, rename: false });
            const reimported = await assetManager.reimportAsset(request.target);
            const asset = normalizeAssetInfo(reimported || infos[0]);
            if (asset?.uuid !== expectedUuid) {
                throw new ManagedSessionError(`Managed replace changed UUID: expected ${expectedUuid}, got ${asset?.uuid || '(missing)'}`, 409);
            }
            assertExpected(asset, request.expected);
            this.assertImported(asset);
            return { asset, assets: [asset] };
        }, request.source, request.target);
    }

    @tool('managed-assets-reimport')
    @title('Reimport Managed Asset')
    @description('Reimport an existing asset and require a completed, valid AssetDB result.')
    @result(SchemaImportReceipt)
    async reimport(@param(SchemaManagedPath) request: any): Promise<ManagedResult<ImportReceipt>> {
        return this.run('reimport', request, async () => {
            const info = normalizeAssetInfo(await assetManager.reimportAsset(request.path));
            assertExpected(info, request.expected);
            this.assertImported(info);
            return { asset: info, assets: info ? [info] : [] };
        }, undefined, request.path);
    }

    @tool('managed-assets-move')
    @title('Move Managed Asset')
    @description('Move an asset without overwrite or automatic rename and return the post-move ImportReceipt.')
    @result(SchemaImportReceipt)
    async move(@param(SchemaManagedMove) request: any): Promise<ManagedResult<ImportReceipt>> {
        return this.run('move', request, async () => {
            await assetManager.moveAsset(request.source, request.target, { overwrite: false, rename: false });
            const asset = normalizeAssetInfo(assetManager.queryAssetInfo(request.target));
            if (!asset) {
                throw new Error(`Moved asset not found at ${request.target}`);
            }
            assertExpected(asset, request.expected);
            this.assertImported(asset);
            return { asset, assets: [asset] };
        }, request.source, request.target);
    }

    @tool('managed-assets-delete')
    @title('Delete Managed Asset')
    @description('Delete a main asset deterministically without deleting sub-assets independently, returning a completed receipt.')
    @result(SchemaImportReceipt)
    async delete(@param(SchemaManagedDelete) request: any): Promise<ManagedResult<ImportReceipt>> {
        return this.run('delete', request, async () => {
            const before = normalizeAssetInfo(assetManager.queryAssetInfo(request.path));
            if (!before) {
                throw new Error(`Asset not found: ${request.path}`);
            }
            assertExpected(before, request.expected);
            await assetManager.removeAsset(request.path, { useTrash: false });
            return { asset: before, assets: [before] };
        }, undefined, request.path);
    }

    private assertImported(asset: any): void {
        if (!asset) {
            throw new Error('Managed asset operation returned no asset information');
        }
        if (asset.imported !== true || asset.invalid === true) {
            throw new Error(`Managed asset import is incomplete or invalid: ${asset.file || asset.url || asset.uuid}`);
        }
        this.assertDependencies(asset);
    }

    private assertDependencies(asset: any): void {
        const depends = Array.isArray(asset?.depends) ? asset.depends : [];
        const missing = depends.filter((dependency: unknown) => {
            if (typeof dependency !== 'string' || !dependency) return true;
            try {
                return !assetManager.queryAssetInfo(dependency);
            } catch {
                return true;
            }
        });
        if (missing.length > 0) {
            throw new ManagedSessionError(`Managed asset has missing dependencies: ${missing.join(', ')}`, 409);
        }
    }

    private async run(
        operation: ImportReceipt['operation'],
        request: ManagedRequest & Record<string, unknown>,
        action: () => Promise<{ asset: any; assets: any[] }>,
        source?: string,
        target?: string,
    ): Promise<ManagedResult<ImportReceipt>> {
        let probe: ManagedSessionProbe;
        try {
            probe = assertManagedRequest(request);
        } catch (error) {
            return { code: statusForError(error), reason: errorMessage(error) };
        }

        const requestDigest = digest(request);
        try {
            const result = await action();
            return {
                code: HTTP_STATUS.OK,
                data: this.receipt(probe, requestDigest, operation, 'completed', result.asset, result.assets, source, target),
            };
        } catch (error) {
            const reason = errorMessage(error);
            const receipt = this.receipt(probe, requestDigest, operation, 'failed', null, [], source, target, [reason]);
            return { code: statusForError(error), data: receipt, reason };
        }
    }

    private receipt(
        probe: ManagedSessionProbe,
        requestDigest: string,
        operation: ImportReceipt['operation'],
        status: ImportReceipt['status'],
        asset: any,
        assets: any[],
        source?: string,
        target?: string,
        diagnostics: string[] = [],
    ): ImportReceipt {
        const base: any = {
            receiptVersion: 1,
            requestDigest,
            sessionNonce: probe.sessionNonce,
            projectIdentity: probe.projectIdentity,
            projectRealpath: probe.projectPath,
            operation,
            source,
            target,
            status,
            asset,
            assets,
            diagnostics,
            completedAt: new Date().toISOString(),
        };
        return {
            ...base,
            responseDigest: digest(base),
        };
    }
}
