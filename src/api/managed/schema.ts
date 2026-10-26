import { z } from 'zod';

export const SchemaManagedSessionProbeRequest = z.object({
    expectedProjectRealpath: z.string().min(1).optional(),
    expectedProjectIdentity: z.string().min(1).optional(),
    expectedPort: z.number().int().min(1).max(65535).optional(),
    expectedServiceCommit: z.string().min(1).optional(),
    expectedSchemaDigest: z.string().min(1).optional(),
}).optional().describe('Optional managed session expectations used to reject a stale or wrong MCP service.');

export const SchemaManagedRequest = z.object({
    sessionNonce: z.string().min(1),
    projectIdentity: z.string().min(1),
    projectRealpath: z.string().min(1),
}).describe('Managed request identity, bound to one verified project and service session.');

export const SchemaManagedExpectedAsset = z.object({
    uuid: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
}).optional().describe('Expected identity of the imported or changed main asset.');

export const SchemaManagedImportOptions = z.object({
    overwrite: z.boolean().optional(),
    rename: z.boolean().optional(),
    expected: SchemaManagedExpectedAsset,
}).optional();

export const SchemaManagedImport = SchemaManagedRequest.extend({
    source: z.string().min(1),
    target: z.string().min(1),
    options: SchemaManagedImportOptions,
});

export const SchemaManagedCreate = SchemaManagedRequest.extend({
    target: z.string().min(1),
    content: z.string().optional(),
    template: z.string().min(1).optional(),
    uuid: z.string().min(1).optional(),
    userData: z.record(z.string(), z.unknown()).optional(),
    customOptions: z.record(z.string(), z.unknown()).optional(),
    expected: SchemaManagedExpectedAsset,
});

export const SchemaManagedReplace = SchemaManagedRequest.extend({
    source: z.string().min(1),
    target: z.string().min(1),
    expected: SchemaManagedExpectedAsset,
});

export const SchemaManagedPath = SchemaManagedRequest.extend({
    path: z.string().min(1),
    expected: SchemaManagedExpectedAsset,
});

export const SchemaManagedMove = SchemaManagedRequest.extend({
    source: z.string().min(1),
    target: z.string().min(1),
    expected: SchemaManagedExpectedAsset,
});

export const SchemaManagedDelete = SchemaManagedRequest.extend({
    path: z.string().min(1),
    expected: SchemaManagedExpectedAsset,
});

export const SchemaManagedQuery = SchemaManagedRequest.extend({
    path: z.string().min(1),
    expected: SchemaManagedExpectedAsset,
});

export const SchemaManagedSessionProbe = z.object({
    capabilityVersion: z.string().min(1),
    capabilities: z.array(z.string().min(1)),
    serviceName: z.string().min(1),
    serviceVersion: z.string().min(1),
    serviceCommit: z.string().min(1),
    creatorVersion: z.string().min(1),
    enginePath: z.string().min(1),
    engineDigest: z.string().min(1),
    projectPath: z.string().min(1),
    projectIdentity: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    pid: z.number().int().positive(),
    sessionNonce: z.string().min(1),
    schemaDigest: z.string().min(1),
});

export const SchemaManagedSessionReadiness = z.object({
    sessionNonce: z.string().min(1),
    projectIdentity: z.string().min(1),
    projectRealpath: z.string().min(1),
    assetDbReady: z.boolean(),
    assetDbBusy: z.boolean(),
    previewReady: z.boolean(),
    ready: z.boolean(),
    diagnostics: z.array(z.string()),
});

export const SchemaImportReceiptAsset = z.object({
    name: z.string().optional(),
    source: z.string().optional(),
    url: z.string().optional(),
    file: z.string().optional(),
    uuid: z.string().optional(),
    type: z.string().optional(),
    importer: z.string().optional(),
    imported: z.boolean().optional(),
    invalid: z.boolean().optional(),
    library: z.record(z.string(), z.string()).optional(),
    depends: z.array(z.string()).optional(),
    redirect: z.unknown().optional(),
    subAssets: z.record(z.string(), z.any()).optional(),
}).passthrough();

export const SchemaImportReceipt = z.object({
    receiptVersion: z.literal(1),
    requestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    responseDigest: z.string().regex(/^[0-9a-f]{64}$/),
    sessionNonce: z.string().min(1),
    projectIdentity: z.string().min(1),
    projectRealpath: z.string().min(1),
    operation: z.enum(['query', 'create', 'import', 'replace', 'reimport', 'move', 'delete']),
    source: z.string().optional(),
    target: z.string().optional(),
    status: z.enum(['completed', 'failed']),
    asset: SchemaImportReceiptAsset.nullable(),
    assets: z.array(SchemaImportReceiptAsset).optional(),
    diagnostics: z.array(z.string()),
    completedAt: z.string().datetime(),
}).passthrough();

export type ManagedSessionProbeRequest = z.infer<typeof SchemaManagedSessionProbeRequest>;
export type ManagedRequest = z.infer<typeof SchemaManagedRequest>;
export type ManagedSessionReadiness = z.infer<typeof SchemaManagedSessionReadiness>;
export type ManagedExpectedAsset = z.infer<typeof SchemaManagedExpectedAsset>;
export type ImportReceipt = z.infer<typeof SchemaImportReceipt>;
