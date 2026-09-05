export interface SourceRevision {
    mtimeMs: number;
    size: number;
}

export function isSourceNewerThanRevision(
    recorded: SourceRevision | null | undefined,
    current: SourceRevision | null | undefined,
): boolean {
    if (!recorded || !current) {
        return false;
    }
    return current.mtimeMs !== recorded.mtimeMs || current.size !== recorded.size;
}

export function shouldSaveOnSwitch(input: {
    assetExists: boolean;
    isDirty: boolean | undefined;
    sourceNewerOnDisk: boolean;
}): boolean {
    if (!input.assetExists) {
        return false;
    }
    if (input.sourceNewerOnDisk) {
        return false;
    }
    if (input.isDirty === false) {
        return false;
    }
    return true;
}

export function shouldRejectExplicitSave(sourceNewerOnDisk: boolean): boolean {
    return sourceNewerOnDisk;
}

export function shouldSkipCloseSave(input: {
    requestedSave: boolean;
    isDirty: boolean | undefined;
}): boolean {
    if (!input.requestedSave) {
        return true;
    }
    return input.isDirty === false;
}
