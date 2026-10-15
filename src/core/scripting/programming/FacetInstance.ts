import { existsSync } from 'fs';
import { join } from 'path';
import { ProgrammingFacet } from './Facet';

let programmingFacet: ProgrammingFacet | null = null;
let createProgrammingFacetPromise: Promise<ProgrammingFacet> | null = null;

/** 4.0 浏览器引擎在 dev-cli/web；3.8.8 编辑器包在 dev/editor。 */
function resolveEngineDistRoot(enginePath: string): string {
    const devCliWeb = join(enginePath, 'bin', '.cache', 'dev-cli', 'web');
    if (existsSync(devCliWeb)) {
        return devCliWeb;
    }
    return join(enginePath, 'bin', '.cache', 'dev', 'editor');
}

export async function createProgrammingFacet(enginePath: string, projectPath: string, features: string[]) {
    if (!programmingFacet) {
        programmingFacet = await ProgrammingFacet.create(
            {
                root: enginePath,
                distRoot: resolveEngineDistRoot(enginePath),
                baseUrl: '/scripting/engine',
                features,
            },
            projectPath
        );
    }
    return programmingFacet;
}

export async function waitForProgrammingFacet(): Promise<ProgrammingFacet> {
    if (!createProgrammingFacetPromise) {
        const { Engine } = await import('../../engine');
        const { default: scripting } = await import('../');
        const enginePath = Engine.getInfo().typescript.path;
        const features = Engine.getConfig().includeModules || [];
        createProgrammingFacetPromise = createProgrammingFacet(enginePath, scripting.projectPath, features);
        createProgrammingFacetPromise.catch(() => {
            createProgrammingFacetPromise = null;
        });
    }
    await createProgrammingFacetPromise;

    return programmingFacet!;
}

export function getPreviewFacet() {
    if (!programmingFacet) {
        throw new Error('ProgrammingFacet not init, please init firstly.');
    }
    return programmingFacet;
}
