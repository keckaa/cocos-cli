import { join, resolve } from 'path';
import Module from 'module';

export interface IEngineLoader {
    import(id: string): Promise<unknown>;
}

const ModuleInternal = Module as typeof Module & {
    _resolveFilename(this: Module, request: string): void;
    _load(this: Module, request: string): void;
};

const modulePrototype = Module.prototype as typeof Module.prototype & {
    _compile(content: string, filename: string): unknown;
};

const dollar = '$';
const virtualPrerequisiteAnchor = `applyImportMap(System, importMap, require${dollar}${dollar}7.pathToFileURL(importMapFile).href);\n`;
const virtualPrerequisiteHook = `
        const originalInstantiate = System.instantiate.bind(System);
        System.instantiate = function (url, parentUrl) {
            if (typeof url === 'string' && url.startsWith('virtual:///prerequisite-imports/')) {
                return Promise.resolve([[], function () {
                    return { setters: [], execute () {} };
                }]);
            }
            return originalInstantiate(url, parentUrl);
        };

`;

/** 3.8.8 编辑器包在非 EDITOR 模式下会 import virtual:///prerequisite-imports。4.0 loader 没有这段锚点，不会改。 */
function loadEditorLoader(engineDevPath: string): IEngineLoader {
    const loaderPath = resolve(join(engineDevPath, 'editor'), 'loader.js');
    const originalCompile = modulePrototype._compile;
    modulePrototype._compile = function (content: string, filename: string) {
        if (filename === loaderPath && content.includes(virtualPrerequisiteAnchor) && !content.includes('virtual:///prerequisite-imports/')) {
            const inserted = virtualPrerequisiteAnchor + virtualPrerequisiteHook;
            content = content.replace(virtualPrerequisiteAnchor, () => inserted);
        }
        return originalCompile.call(this, content, filename);
    };
    try {
        return (require(loaderPath) as { default: IEngineLoader }).default;
    } finally {
        modulePrototype._compile = originalCompile;
    }
}

export class EngineLoader {
    static isEngineModule(request: string): boolean {
        return request === 'cc' || (request.startsWith('cc/') && !request.startsWith('cc/preload')) || request.startsWith('cce:/internal/');
    }

    private static engineModules: Record<string, any> = {};
    public static getEngineModuleById(id: string): any {
        return EngineLoader.engineModules[id];
    }

    private static loader: IEngineLoader | undefined;

    private static createEngineLoader(engineDevPath: string): IEngineLoader {
        return loadEditorLoader(engineDevPath);
    }

    public static async init(engineDevPath: string, modules: string[]) {
        this.loader = this.createEngineLoader(engineDevPath);
        await this.requiredModules(modules);

        const vendorResolveFilename = ModuleInternal._resolveFilename;
        ModuleInternal._resolveFilename = function (request: string) {
            if (EngineLoader.isEngineModule(request)) {
                return request;
            } else {
                // @ts-ignore

                return vendorResolveFilename.apply(this, arguments);
            }
        };

        const vendorLoad = ModuleInternal._load;
        ModuleInternal._load = function (request: string) {
            if (EngineLoader.isEngineModule(request)) {
                const module = EngineLoader.getEngineModuleById(request);
                if (module) {
                    return module;
                } else {
                    throw new Error(
                        `Can not load engine module: ${request}. Valid engine modules are: ${Object.keys(EngineLoader.engineModules).join(',')}`,
                    );
                }
            } else {
                // @ts-ignore

                return vendorLoad.apply(this, arguments);
            }
        };
    }

    public static async requiredModules(modules: string[]) {
        if (!this.loader) {
            throw new Error(`Failed to load engine module ${modules.join(',')}. ` + 'Loader has not been initialized. engineLoader.init.');
        }

        for (const module of modules) {
            try {
                EngineLoader.engineModules[module] = await this.loader!.import(module);
            } catch (e) {
                console.error(`Failed to load engine module: ${module}  e: ${e}`);
            }
        }
    }

    public static async importModule(module: string) {
        if (!this.loader) {
            throw new Error(`Failed to load engine module ${module}. ` + 'Loader has not been initialized. engineLoader.init.');
        }

        return await this.loader.import(module);
    }
}
