import { createHash, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { GlobalPaths } from '../global';
import pkgJson from '../../package.json';

export const MANAGED_CAPABILITY_VERSION = '1.0.0';

export const MANAGED_CAPABILITIES = [
    'managed-session-probe',
    'managed-assets-query',
    'managed-assets-import',
    'managed-assets-create',
    'managed-assets-replace',
    'managed-assets-reimport',
    'managed-assets-move',
    'managed-assets-delete',
] as const;

export interface ManagedSessionProbe {
    capabilityVersion: string;
    capabilities: readonly string[];
    serviceName: string;
    serviceVersion: string;
    serviceCommit: string;
    creatorVersion: string;
    enginePath: string;
    engineDigest: string;
    projectPath: string;
    projectIdentity: string;
    port: number;
    pid: number;
    sessionNonce: string;
    schemaDigest: string;
}

export interface ManagedSessionRequest {
    sessionNonce: string;
    projectIdentity: string;
    projectRealpath: string;
}

export class ManagedSessionError extends Error {
    readonly statusCode: 400 | 409 | 503;

    constructor(message: string, statusCode: 400 | 409 | 503 = 409) {
        super(message);
        this.name = 'ManagedSessionError';
        this.statusCode = statusCode;
    }
}

interface ManagedSessionState extends ManagedSessionProbe {
    projectJsonDigest: string;
}

let currentSession: ManagedSessionState | null = null;

function sha256(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableJson).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function getServiceCommit(): string {
    if (process.env.COCOS_CLI_COMMIT) {
        return process.env.COCOS_CLI_COMMIT;
    }
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: resolve(__dirname, '../..'),
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
        }).trim() || 'unknown';
    } catch {
        return 'unknown';
    }
}

function getEngineMetadata(enginePath: string): { creatorVersion: string; engineDigest: string } {
    const packagePath = join(enginePath, 'package.json');
    const packageData = readFileSync(packagePath);
    const packageJson = JSON.parse(packageData.toString()) as { version?: unknown };
    return {
        creatorVersion: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
        // The engine package is the stable, portable input available on a worker. The
        // lock file records this digest together with the resolved realpath.
        engineDigest: sha256(packageData),
    };
}

export function resolveProjectIdentity(projectPath: string): { projectPath: string; projectIdentity: string; projectJsonDigest: string } {
    const projectRealpath = realpathSync(resolve(projectPath));
    const projectJsonPath = join(projectRealpath, 'project.json');
    const projectConfigPath = existsSync(projectJsonPath) ? projectJsonPath : join(projectRealpath, 'package.json');
    if (!existsSync(projectConfigPath)) {
        throw new ManagedSessionError(`Managed project is missing project.json or package.json: ${projectRealpath}`, 400);
    }
    const projectConfig = readFileSync(projectConfigPath);
    const projectJsonDigest = sha256(projectConfig);
    const identityPayload = projectConfigPath === projectJsonPath
        ? { path: projectRealpath, projectJsonDigest }
        : { path: projectRealpath, projectPackageDigest: projectJsonDigest };
    return {
        projectPath: projectRealpath,
        // Include the canonical path so two copies with identical descriptors
        // cannot accidentally share a managed session identity.
        projectIdentity: sha256(stableJson(identityPayload)),
        projectJsonDigest,
    };
}

export function computeManagedSchemaDigest(): string {
    return sha256(stableJson({ version: MANAGED_CAPABILITY_VERSION, capabilities: MANAGED_CAPABILITIES }));
}

export function beginManagedSession(projectPath: string, port: number): ManagedSessionProbe {
    const identity = resolveProjectIdentity(projectPath);
    const engine = getEngineMetadata(realpathSync(GlobalPaths.enginePath));
    currentSession = {
        capabilityVersion: MANAGED_CAPABILITY_VERSION,
        capabilities: [...MANAGED_CAPABILITIES],
        serviceName: 'cocos-cli',
        serviceVersion: typeof pkgJson.version === 'string' ? pkgJson.version : 'unknown',
        serviceCommit: getServiceCommit(),
        creatorVersion: engine.creatorVersion,
        enginePath: realpathSync(GlobalPaths.enginePath),
        engineDigest: engine.engineDigest,
        projectPath: identity.projectPath,
        projectIdentity: identity.projectIdentity,
        port,
        pid: process.pid,
        sessionNonce: randomUUID(),
        schemaDigest: computeManagedSchemaDigest(),
        projectJsonDigest: identity.projectJsonDigest,
    };
    return getManagedSessionProbe();
}

export function getManagedSessionProbe(): ManagedSessionProbe {
    if (!currentSession) {
        throw new ManagedSessionError('Managed session is not initialized', 503);
    }
    const { projectJsonDigest: _projectJsonDigest, ...probe } = currentSession;
    return { ...probe, capabilities: [...probe.capabilities] };
}

export function getManagedSessionState(): Readonly<ManagedSessionState> | null {
    return currentSession;
}

export function clearManagedSession(): void {
    currentSession = null;
}

export function assertManagedRequest(request: ManagedSessionRequest): ManagedSessionProbe {
    if (!currentSession) {
        throw new ManagedSessionError('Managed session is not initialized', 503);
    }
    if (!request || typeof request.sessionNonce !== 'string' || typeof request.projectIdentity !== 'string' || typeof request.projectRealpath !== 'string') {
        throw new ManagedSessionError('Managed request must include sessionNonce, projectIdentity and projectRealpath', 400);
    }
    const projectRealpath = realpathSync(resolve(request.projectRealpath));
    if (request.sessionNonce !== currentSession.sessionNonce) {
        throw new ManagedSessionError('Managed session nonce does not match the active service session', 409);
    }
    if (request.projectIdentity !== currentSession.projectIdentity) {
        throw new ManagedSessionError('Managed project identity does not match the active project', 409);
    }
    if (projectRealpath !== currentSession.projectPath) {
        throw new ManagedSessionError(`Managed project realpath does not match the active project: ${projectRealpath}`, 409);
    }
    return getManagedSessionProbe();
}
