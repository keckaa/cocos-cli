import { deserialize } from 'cc';
import { default as doSerialize, IOptions } from './parser';
import { asAsset, setName, findRootObject } from './dynamic-builder';

function hasCompiledMacros(): boolean {
    return !!(deserialize as { _macros?: object })._macros;
}

export function serialize(obj: Exclude<any, null | undefined>, options?: IOptions): string | object {
    // console.time('Serialize in dynamic format');
    options = Object.assign({
        builder: 'dynamic',
    }, options);
    const res = doSerialize(obj, options);
    // console.timeEnd('Serialize in dynamic format');

    // if (!options.forceInline) {
    //     // console.time('Serialize by legacy module');
    //     const expectedRes = serializeLegacy(obj, options);
    //     // console.timeEnd('Serialize by legacy module');
    //     if (typeof res === 'string') {
    //         if (res !== expectedRes) {
    //             console.warn('Different serialize result, new:');
    //             console.log(res);
    //             console.warn('Old:');
    //             console.log(expectedRes);
    //             return expectedRes;
    //         }
    //     }
    // }

    return res;
}

serialize.asAsset = asAsset;
serialize.setName = setName;
serialize.findRootObject = findRootObject;

export function serializeCompiled(obj: Exclude<any, null | undefined>, options: IOptions): string | object {
    if (!hasCompiledMacros()) {
        return serialize(obj, Object.assign({}, options, { builder: 'dynamic' }));
    }
    options = Object.assign({
        builder: 'compiled',
        dontStripDefault: false,
    }, options);
    return doSerialize(obj, options);
}

serializeCompiled.getRootData = (data: any) => {
    if (!hasCompiledMacros()) {
        return data;
    }
    return require('./compiled/builder').getRootData(data);
};
serializeCompiled.packJSONs = (jsons: any) => {
    if (!hasCompiledMacros()) {
        return jsons;
    }
    return require('./compiled/pack-jsons').default(jsons);
};
