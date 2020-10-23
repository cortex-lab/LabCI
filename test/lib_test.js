const config = require('../config/config').settings
const assert = require('assert')
const { ensureArray, loadTestRecords, compareCoverage } = require('../lib');
ids = [
    'cabe27e5c8b8cb7cdc4e152f1cf013a89adc7a71',
    '1c33a6e2ac7d7fc098105b21a702e104e09767cf',
    'hf4ac7d7fc0983748702e10738hw4382f347fu38'  // Fake
];

describe('Test ensureArray:', function() {
    it('Check returns array', function () {
        let s = 'foo'
        assert(Array.isArray(ensureArray(s)), 'failed to return array')
        assert.deepStrictEqual(ensureArray(s), [s], 'failed to return array')
        let arr = ['bar']
        assert.strictEqual(ensureArray(arr), arr, 'failed to return array')
    });
});

describe('Test loading test records:', function() {
    // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    before(function () {
        assert(process.env.NODE_ENV.startsWith('test'), 'Test run outside test env')
    })

    it('Check loading existing record', function () {
        let id = ids[0];
        const record = loadTestRecords(id);
        assert(record != null, 'failed to load record')
        assert(!Array.isArray(record), 'failed to return single obj')
        assert.strictEqual(record.commit, id, 'failed to return correct record')
    });

    it('Check loading multiple records', function () {
        const records = loadTestRecords(ids);
        assert(records != null, 'failed to load records')
        assert(Array.isArray(records), 'failed to return array')
        assert.strictEqual(records.length, 2, 'failed to return both records')
    });

    it('Check loading fail', function () {
        let id = ids.pop()  // this commit is not in db
        const record = loadTestRecords(id);
        let isEmptyArr = x => { return Array.isArray(x) && x.length === 0; }
        assert(isEmptyArr(record))
        assert(isEmptyArr(loadTestRecords([id, id])))
    });
});
