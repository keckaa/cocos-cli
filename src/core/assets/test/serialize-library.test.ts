import { spawnSync } from 'child_process';
import { join } from 'path';

// A separate process uses the configured 3.8.8 engine and the real CLI preload.
// It neither opens a project nor leaks EngineLoader's require hooks into Jest.
describe('animation library in the configured engine', () => {
    test.each(['roundtrip', 'dependencies', 'export', 'import', 'gltf'])('%s', (scenario) => {
        const root = join(__dirname, '../../../..');
        const result = spawnSync(process.execPath, [
            join(root, 'tests/helpers/animation-library.cjs'), scenario,
        ], { cwd: root, encoding: 'utf8', timeout: 60000 });
        if (result.error || result.status !== 0) {
            throw new Error(`${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
        }
        expect(result.stdout).toContain(`PASS ${scenario}`);
    });
});
