import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { resolveProjectIdentity } from '../../src/mcp/managed-session';

describe('managed project identity', () => {
    it('accepts a Creator 3.8.8 package.json project without project.json', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-managed-project-'));
        fs.writeJsonSync(path.join(root, 'package.json'), { name: 'fixture', creator: { version: '3.8.8' } });

        const identity = resolveProjectIdentity(root);

        expect(identity.projectPath).toBe(fs.realpathSync(root));
        expect(identity.projectIdentity).toMatch(/^[a-f0-9]{64}$/);
        expect(identity.projectJsonDigest).toMatch(/^[a-f0-9]{64}$/);
        fs.removeSync(root);
    });

    it('keeps project.json fixtures supported', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-managed-project-'));
        fs.writeFileSync(path.join(root, 'project.json'), '{"engine":"3.8.8"}\n');

        expect(resolveProjectIdentity(root).projectIdentity).toMatch(/^[a-f0-9]{64}$/);
        fs.removeSync(root);
    });
});
