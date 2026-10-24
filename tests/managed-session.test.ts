import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { realpathSync } from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import {
    assertManagedRequest,
    beginManagedSession,
    clearManagedSession,
    getManagedSessionProbe,
} from '../src/mcp/managed-session';
import { MANAGED_CAPABILITY_VERSION } from '../src/mcp/managed-session';
import { ServerService } from '../src/server/server';

async function listen(port = 0): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
    return { server, port: (server.address() as { port: number }).port };
}

describe('managed cocos-cli session', () => {
    afterEach(() => clearManagedSession());

    it('returns a probe bound to the canonical project and rejects stale identity', async () => {
        const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'cocos-managed-'));
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'project.json'), JSON.stringify({ name: 'managed-fixture', version: '1.0.0' }));

        const probe = beginManagedSession(root, 19527);
        expect(probe.capabilityVersion).toBe(MANAGED_CAPABILITY_VERSION);
        expect(probe.projectPath).toBe(realpathSync(root));
        expect(probe.port).toBe(19527);
        expect(probe.sessionNonce).toHaveLength(36);
        expect(probe.enginePath).toContain('3.8.8');
        expect(probe.engineDigest).toMatch(/^[0-9a-f]{64}$/);

        expect(assertManagedRequest({
            sessionNonce: probe.sessionNonce,
            projectIdentity: probe.projectIdentity,
            projectRealpath: root,
        })).toMatchObject({ sessionNonce: probe.sessionNonce, projectIdentity: probe.projectIdentity });

        expect(() => assertManagedRequest({
            sessionNonce: 'stale-session',
            projectIdentity: probe.projectIdentity,
            projectRealpath: root,
        })).toThrow(/nonce/);
        expect(getManagedSessionProbe().projectIdentity).toBe(probe.projectIdentity);
    });

    it('strict server mode fails when the requested port is occupied', async () => {
        const occupied = await listen();
        const service = new ServerService();
        try {
            await expect(service.start(occupied.port, '127.0.0.1', { strictPort: true })).rejects.toMatchObject({ code: 'EADDRINUSE' });
            expect(service.port).not.toBe(occupied.port + 1);
        } finally {
            await new Promise<void>((resolve) => occupied.server.close(() => resolve()));
            await service.stop().catch(() => undefined);
        }
    });
});
