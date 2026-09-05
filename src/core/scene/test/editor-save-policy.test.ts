import {
    isSourceNewerThanRevision,
    shouldRejectExplicitSave,
    shouldSaveOnSwitch,
    shouldSkipCloseSave,
} from '../scene-process/service/editors/editor-save-policy';

describe('editor-save-policy', () => {
    describe('shouldSaveOnSwitch', () => {
        it('does not save when the current asset was deleted', () => {
            expect(shouldSaveOnSwitch({
                assetExists: false,
                isDirty: true,
                sourceNewerOnDisk: false,
            })).toBe(false);
        });

        it('does not save a clean editor even if disk is unchanged', () => {
            expect(shouldSaveOnSwitch({
                assetExists: true,
                isDirty: false,
                sourceNewerOnDisk: false,
            })).toBe(false);
        });

        it('does not save a clean editor when disk was changed externally', () => {
            expect(shouldSaveOnSwitch({
                assetExists: true,
                isDirty: false,
                sourceNewerOnDisk: true,
            })).toBe(false);
        });

        it('saves unsaved editor changes when disk is unchanged', () => {
            expect(shouldSaveOnSwitch({
                assetExists: true,
                isDirty: true,
                sourceNewerOnDisk: false,
            })).toBe(true);
        });

        it('does not save unsaved editor changes over a newer disk file', () => {
            expect(shouldSaveOnSwitch({
                assetExists: true,
                isDirty: true,
                sourceNewerOnDisk: true,
            })).toBe(false);
        });

        it('keeps legacy auto-save when undo is unavailable and disk is unchanged', () => {
            expect(shouldSaveOnSwitch({
                assetExists: true,
                isDirty: undefined,
                sourceNewerOnDisk: false,
            })).toBe(true);
        });

        it('does not auto-save when undo is unavailable but disk is newer', () => {
            expect(shouldSaveOnSwitch({
                assetExists: true,
                isDirty: undefined,
                sourceNewerOnDisk: true,
            })).toBe(false);
        });
    });

    describe('isSourceNewerThanRevision', () => {
        it('is not newer when either side is missing', () => {
            expect(isSourceNewerThanRevision(null, { mtimeMs: 2, size: 10 })).toBe(false);
            expect(isSourceNewerThanRevision({ mtimeMs: 1, size: 10 }, null)).toBe(false);
        });

        it('detects mtime or size changes', () => {
            expect(isSourceNewerThanRevision(
                { mtimeMs: 1, size: 10 },
                { mtimeMs: 2, size: 10 },
            )).toBe(true);
            expect(isSourceNewerThanRevision(
                { mtimeMs: 1, size: 10 },
                { mtimeMs: 1, size: 11 },
            )).toBe(true);
            expect(isSourceNewerThanRevision(
                { mtimeMs: 1, size: 10 },
                { mtimeMs: 1, size: 10 },
            )).toBe(false);
        });
    });

    describe('shouldRejectExplicitSave', () => {
        it('rejects only when the source file is newer than the editor session', () => {
            expect(shouldRejectExplicitSave(true)).toBe(true);
            expect(shouldRejectExplicitSave(false)).toBe(false);
        });
    });

    describe('shouldSkipCloseSave', () => {
        it('skips when the caller asked not to save', () => {
            expect(shouldSkipCloseSave({ requestedSave: false, isDirty: true })).toBe(true);
        });

        it('skips a requested save when the editor is clean', () => {
            expect(shouldSkipCloseSave({ requestedSave: true, isDirty: false })).toBe(true);
        });

        it('performs a requested save when dirty', () => {
            expect(shouldSkipCloseSave({ requestedSave: true, isDirty: true })).toBe(false);
        });

        it('performs a requested save when undo is unavailable', () => {
            expect(shouldSkipCloseSave({ requestedSave: true, isDirty: undefined })).toBe(false);
        });
    });
});
