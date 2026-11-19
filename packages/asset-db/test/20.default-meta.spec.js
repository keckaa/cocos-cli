'use strict';

const assert = require('assert').strict;
const { fillUserData, setDefaultUserData } = require('../dist/libs/default-meta');

describe('asset import defaults', () => {
    it('copies nested defaults independently and preserves explicit per-asset settings', () => {
        setDefaultUserData('image', { compressSettings: { useCompressTexture: true, presetId: 'shared' }, flipVertical: false });
        const first = {};
        fillUserData('image', first);
        first.compressSettings.presetId = 'custom';
        const second = {};
        fillUserData('image', second);
        assert.deepEqual(second, { compressSettings: { useCompressTexture: true, presetId: 'shared' }, flipVertical: false });
        const explicit = { compressSettings: { useCompressTexture: false }, flipVertical: true };
        fillUserData('image', explicit);
        assert.deepEqual(explicit, { compressSettings: { useCompressTexture: false }, flipVertical: true });
    });
});
