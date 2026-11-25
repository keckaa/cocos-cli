import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { lstat, open, realpath, type FileHandle } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import type { Stats } from 'fs';
import { copyPath, deletePath, getFileSystemProvider, renamePath } from './filesystem';

type RecordValue = Record<string, any>;
export type ImportedMetaRole = { uuid: string; importer: string };
export type ImportedMetaIdentity = Map<string, ImportedMetaRole>;

const reservedUuids = new Set<string>();
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}(?:@[^/@\\\s]+)*$/i;

export function assetImportPreserveMetaCapability(): { schemaVersion: 1 } | undefined {
    return getFileSystemProvider().installNoReplace ? { schemaVersion: 1 } : undefined;
}

function reason(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function object(value: unknown, label: string): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a metadata object`);
    return value as RecordValue;
}

/** Roles follow AssetDB subasset IDs; importer changes cannot hide UUID changes. */
export function importMetaIdentity(value: unknown): ImportedMetaIdentity {
    const result: ImportedMetaIdentity = new Map();
    const uuids = new Set<string>();
    const visit = (input: unknown, path: string, parentUuid?: string, childId?: string): void => {
        const meta = object(input, `Metadata ${path || '<root>'}`);
        if (typeof meta.uuid !== 'string' || !UUID.test(meta.uuid) || (!parentUuid && meta.uuid.includes('@')))
            throw new Error(`Metadata ${path || '<root>'} has an invalid UUID`);
        if (typeof meta.importer !== 'string' || !meta.importer.trim())
            throw new Error(`Metadata ${path || '<root>'} must declare its importer`);
        if (parentUuid && meta.uuid !== `${parentUuid}@${childId}`)
            throw new Error(`Metadata ${path} has an inconsistent subasset UUID`);
        const uuid = meta.uuid.toLowerCase();
        if (uuids.has(uuid)) throw new Error(`Metadata contains duplicate UUID ${meta.uuid}`);
        uuids.add(uuid);
        result.set(path, { uuid: meta.uuid, importer: meta.importer });
        if (meta.subMetas !== undefined) for (const [id, child] of Object.entries(object(meta.subMetas, 'Metadata subMetas'))) {
            if (!id || /[/@\\]/.test(id)) throw new Error('Metadata has an invalid subasset role');
            const data = object(child, 'Subasset metadata');
            if (data.id !== undefined && data.id !== id) throw new Error(`Metadata role ${id} disagrees with subasset id`);
            visit(data, path ? `${path}/${id}` : id, meta.uuid, id);
        }
    };
    visit(value, '');
    return result;
}

export function assertImportMetaIdentity(expected: ImportedMetaIdentity, actual: unknown): ImportedMetaIdentity {
    const current = importMetaIdentity(actual);
    const root = expected.get('');
    if (!root || current.get('')?.uuid !== root.uuid) throw new Error('Preserved metadata root identity was reassigned');
    for (const [role, previous] of expected) {
        const active = current.get(role);
        if (!active) continue; // Importers may remove a role that no longer exists.
        if (active.uuid !== previous.uuid)
            throw new Error(`Preserved metadata identity was reassigned: ${role || '<root>'}`);
        // '*' asks AssetDB to select an importer for this extension. Once selected,
        // an importer change is valid only for that wildcard role.
        if (previous.importer !== '*' && active.importer !== previous.importer)
            throw new Error(`Preserved metadata importer changed for role ${role || '<root>'}`);
    }
    return current;
}

async function statOrMissing(file: string): Promise<Stats | undefined> {
    try { return await lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

function sameVersion(left: Stats, right: Stats): boolean {
    return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

// This mode already requires ordinary local files for atomic hard-link
// publication. Read the actual inode AssetDB will see; a provider-supplied
// buffer would not prove what is on disk and can exhaust memory for media.
async function inspectFile<T>(file: string, read: (handle: FileHandle) => Promise<T>): Promise<{ content: T; stat: Stats }> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Preserve-meta requires an ordinary file: ${file}`);
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameVersion(stat, opened))
            throw new Error(`Preserve-meta file changed before reading: ${file}`);
        const content = await read(handle);
        const after = await lstat(file);
        if (!after.isFile() || !sameVersion(opened, after))
            throw new Error(`Preserve-meta file changed while reading: ${file}`);
        return { content, stat: after };
    } finally {
        await handle.close();
    }
}

interface FileFingerprint { digest: string; stat: Stats; }

async function fingerprintFile(file: string): Promise<FileFingerprint> {
    const { content, stat } = await inspectFile(file, async (handle) => {
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        return hash.digest('hex');
    });
    return { digest: content, stat };
}

interface InstalledFile { target: string; witness: string; input: FileFingerprint; stat: Stats; installed: boolean; }

async function verifyFile(file: string, expected: FileFingerprint, owner?: Stats): Promise<void> {
    const current = await fingerprintFile(file);
    if (current.digest !== expected.digest || current.stat.size !== expected.stat.size || (owner && !sameFile(owner, current.stat)))
        throw new Error(`Preserve-meta file changed during import: ${file}`);
}

async function rollbackOwnedFiles(files: readonly InstalledFile[]): Promise<void> {
    const owned = files.filter((file) => file.installed);
    if (!owned.length) return;
    // This rollback runs only before the main source becomes visible; at most the
    // target sidecar is installed. Preflight all owned files before moving any.
    for (const file of owned) await verifyFile(file.target, file.input, file.stat);
    const quarantined: Array<{ file: InstalledFile; path: string }> = [];
    let restoreAttempted = false;
    const restore = async (): Promise<void> => {
        if (restoreAttempted) return;
        restoreAttempted = true;
        const failures: unknown[] = [];
        const pending = quarantined.splice(0).reverse();
        for (const item of pending) {
            try {
                await getFileSystemProvider().installNoReplace!(item.path, item.file.target);
                await deletePath(item.path, { useTrash: false });
            } catch (error) {
                // Keep a recovery record if our bytes remain quarantined. If the
                // target is already the exact owned inode, only the quarantine
                // cleanup failed; never repeat installation over it.
                if (await statOrMissing(item.path)) quarantined.push(item);
                failures.push(new Error(`Preserve-meta rollback could not restore ${item.path} to ${item.file.target}`, { cause: error }));
            }
        }
        if (failures.length) throw new AggregateError(failures, `Preserve-meta rollback retained recovery files: ${quarantined.map((item) => item.path).join(', ')}`);
    };
    try {
        for (const file of owned) {
            const quarantine = `${file.witness}.rollback`;
            if (await statOrMissing(quarantine)) throw new Error(`Preserve-meta rollback quarantine already exists: ${quarantine}`);
            await renamePath(file.target, quarantine, { overwrite: false });
            quarantined.push({ file, path: quarantine });
            await verifyFile(quarantine, file.input, file.stat);
        }
        // A competing writer may have filled a target while the owned pair was
        // quarantined. Restore our bytes without replacing it; never delete it.
        if (await Promise.all(owned.map((file) => statOrMissing(file.target))).then((values) => values.some(Boolean))) {
            await restore();
            throw new Error('Preserve-meta rollback found a competing target; owned files were restored when possible');
        }
        for (const item of quarantined) await deletePath(item.path, { useTrash: false });
        quarantined.length = 0;
    } catch (error) {
        if (quarantined.length && !restoreAttempted) {
            try { await restore(); }
            catch (restoreError) {
                throw new AggregateError([error, restoreError], `Preserve-meta rollback retained quarantine files for ${owned.map((file) => file.target).join(', ')}`, { cause: error });
            }
        }
        throw error;
    }
}

export interface PreserveMetaImportHost<T> {
    /** Must reject registered target assets and all already occupied UUIDs. */
    assertAvailable(target: string, identities: ImportedMetaIdentity): void;
    importInstalled(target: string, meta: RecordValue, identities: ImportedMetaIdentity): Promise<T>;
}

/** Import an external asset and existing sidecar before its first AssetDB observation. */
export async function importAssetPreservingMeta<T>(source: string, target: string, host: PreserveMetaImportHost<T>): Promise<T> {
    const provider = getFileSystemProvider();
    if (!provider.installNoReplace) throw new Error('Preserve-meta import requires filesystem provider installNoReplace support');
    if (!isAbsolute(source) || !isAbsolute(target)) throw new Error('Preserve-meta import requires absolute source and target paths');
    const parent = await realpath(dirname(target));
    const destination = join(parent, basename(target));
    if (destination !== resolve(target)) throw new Error('Preserve-meta target must not traverse symbolic links');
    if (await statOrMissing(target) || await statOrMissing(`${target}.meta`)) throw new Error('Preserve-meta target asset and sidecar must both be absent');
    if (resolve(source) === resolve(target) || source.endsWith('.meta')) throw new Error('Preserve-meta source must be an external main asset file');
    const input = await fingerprintFile(source);
    const { content: metadataBytes, stat: metadataStat } = await inspectFile(`${source}.meta`, (handle) => handle.readFile());
    const sidecar = { digest: createHash('sha256').update(metadataBytes).digest('hex'), stat: metadataStat };
    const metadata = object(JSON.parse(metadataBytes.toString('utf8')), 'Source metadata');
    const identities = importMetaIdentity(metadata);
    const uuids = [...identities.values()].map((value) => value.uuid.toLowerCase());
    for (const uuid of uuids) if (reservedUuids.has(uuid)) throw new Error(`Preserve-meta UUID is reserved by another import: ${uuid}`);
    // No await between availability check and reserving the complete identity set.
    host.assertAvailable(target, identities);
    uuids.forEach((uuid) => reservedUuids.add(uuid));
    const stagingSource = join(parent, `.import-meta-${randomUUID()}`);
    const stagingMeta = `${stagingSource}.meta`;
    const files: InstalledFile[] = [];
    // From publication of the main file onward, an independent refresh may see it.
    let published = false;
    let failed = false;
    let failure: unknown;
    let result: T | undefined;
    const stagingOwners = new Map<string, Stats>();
    try {
        // AssetDB directory scans exclude dot paths and **/*.meta. Staging must
        // stay on this volume so installNoReplace can publish using a hard link.
        await copyPath(source, stagingSource, { overwrite: false });
        stagingOwners.set(stagingSource, await lstat(stagingSource));
        await copyPath(`${source}.meta`, stagingMeta, { overwrite: false });
        stagingOwners.set(stagingMeta, await lstat(stagingMeta));
        await verifyFile(stagingSource, input);
        await verifyFile(stagingMeta, sidecar);
        await verifyFile(source, input, input.stat);
        await verifyFile(`${source}.meta`, sidecar, sidecar.stat);
        for (const [file, witness, original] of [[`${target}.meta`, stagingMeta, sidecar], [target, stagingSource, input]] as const) {
            host.assertAvailable(target, identities);
            const stat = await lstat(witness);
            const owned = { target: file, witness, input: original, stat, installed: false };
            files.push(owned);
            try { await provider.installNoReplace(witness, file); }
            catch (error) {
                // A host can fail after its atomic install succeeded. Also treat
                // a competing main file as visible: its importer may have read our
                // sidecar, so rolling the metadata back is no longer safe.
                const current = await statOrMissing(file);
                if (file === target && current) published = true;
                if (current && sameFile(stat, current)) owned.installed = true;
                throw error;
            }
            owned.installed = true;
            if (file === target) published = true;
            await verifyFile(file, original, stat);
        }
        // Do not reject our own identity if another refresh observed publication.
        result = await host.importInstalled(target, metadata, identities);
        await verifyFile(source, input, input.stat);
        await verifyFile(`${source}.meta`, sidecar, sidecar.stat);
        await verifyFile(target, input, files[1].stat);
    } catch (error) {
        failed = true;
        if (published) {
            // Importers may change metadata, generate files, and register assets.
            // Removing just the source pair would leave stale DB identity or race
            // another refresh. The caller's workspace transaction owns recovery.
            failure = new Error(`Preserve-meta import failed after the target became visible: ${reason(error)}. Target: ${target}. Files were retained; restore the caller workspace snapshot and recalibrate AssetDB before retrying, or recover manually.`, { cause: error });
        } else {
            try {
                // A source path created by another writer may already have made
                // our sidecar observable even if our own install never ran.
                if (files.some((file) => file.installed) && await statOrMissing(target)) {
                    throw new Error('A competing main file became visible; metadata was retained for AssetDB recovery');
                }
                await rollbackOwnedFiles(files);
                failure = error;
            } catch (cleanupError) {
                failure = new AggregateError([error, cleanupError], `Preserve-meta import failed: ${reason(error)}. Safe cleanup was incomplete for ${target}: ${reason(cleanupError)}`, { cause: error });
            }
        }
    }
    const cleanupErrors: unknown[] = [];
    for (const file of [stagingSource, stagingMeta]) {
        try {
            const stat = await statOrMissing(file);
            if (!stat) continue;
            const owner = stagingOwners.get(file);
            if (!owner || !stat.isFile() || !sameFile(owner, stat)) {
                throw new Error(`Preserve-meta kept unowned staging file for recovery: ${file}`);
            }
            // AssetDB may write through our meta hard link. The private staging
            // name is still ours even when its shared inode contents changed.
            await deletePath(file, { useTrash: false });
        } catch (error) { cleanupErrors.push(error); }
    }
    uuids.forEach((uuid) => reservedUuids.delete(uuid));
    if (cleanupErrors.length) {
        throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
            `Preserve-meta ${failed ? `import failed: ${reason(failure)}` : 'import completed'}; staging cleanup was incomplete for ${target}: ${cleanupErrors.map(reason).join('; ')}`,
            failed ? { cause: failure } : undefined);
    }
    if (failed) throw failure;
    return result!;
}
