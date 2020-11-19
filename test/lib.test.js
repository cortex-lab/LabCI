const config = require('../config/config').settings
const assert = require('assert')
const sinon = require('sinon');
const expect = require('chai').expect
const { ensureArray, loadTestRecords, queue, getBadgeData } = require('../lib');
// TODO update package test script and add cross_env dev dependency
ids = [
    'cabe27e5c8b8cb7cdc4e152f1cf013a89adc7a71',
    '1c33a6e2ac7d7fc098105b21a702e104e09767cf',
    'hf4ac7d7fc0983748702e10738hw4382f347fu38',  // Fake
    '7bdf62'  // errored
];


/**
 * A test for the function ensureArray.  Should return an array but not affect array inputs.
 */
describe('Test ensureArray:', function() {
    it('Check returns array', function () {
        let s = 'foo'
        assert(Array.isArray(ensureArray(s)), 'failed to return array')
        assert.deepStrictEqual(ensureArray(s), [s], 'failed to return array')
        let arr = ['bar']
        assert.strictEqual(ensureArray(arr), arr, 'failed to return array')
    });
});


/**
 * A test for the function loadTestRecords.
 */
describe('Test loading test records:', function() {
    // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    before(function () {
        assert(process.env.NODE_ENV.startsWith('test'), 'Test run outside test env')
    });

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
        assert.strictEqual(records.length, ids.length-1, 'failed to return both records')
    });

    it('Check loading fail', function () {
        let id = ids[2]  // this commit is not in db
        const record = loadTestRecords(id);
        let isEmptyArr = x => { return Array.isArray(x) && x.length === 0; }
        assert(isEmptyArr(record))
        assert(isEmptyArr(loadTestRecords([id, id])))
    });
});


/**
 * This tests the shields callback which returns sheilds.io API data for coverage and build status.
 */
describe("getBadgeData function", () => {
   var scope;  // Our server mock
   var sandbox;  // Sandbox for spying on queue
   var input;  // Input data for function

   beforeEach(function () {
      queue.process(async (_job, _done) => {})  // nop
      sandbox = sinon.createSandbox();
      sandbox.spy(queue);
      input = {
         sha: null,
         owner: process.env['REPO_OWNER'],
         repo: '',
         branch: '',
         context: ''
      };
   });

   it('Check Coverage', function () {
      var data, expected;

      // Low coverage
      input['sha'] = ids[0];
      input['context'] = 'coverage';
      data = getBadgeData(input);
      expected = {
         schemaVersion: 1,
         label: input['context'],
         message: '22.2%',
         color: 'red'
      };
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // High coverage
      input['sha'] = ids[1];
      expected['message'] = '75.77%';
      expected['color'] = 'brightgreen';
      data = getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // Errored
      input['sha'] = ids[3];
      expected['message'] = 'unknown';
      expected['color'] = 'orange';
      data = getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // No coverage
      input['sha'] = ids[2];
      expected['message'] = 'pending';
      expected['color'] = 'orange';
      data = getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.calledOnce(queue.add);
   });

   it('Check build status', function () {
      var data, expected;

      // Failed tests
      input['sha'] = ids[0];
      input['context'] = 'status';
      data = getBadgeData(input);
      expected = {
         schemaVersion: 1,
         label: 'build',
         message: 'failing',
         color: 'red'
      };
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // High coverage
      input['sha'] = ids[1];
      expected['message'] = 'passing';
      expected['color'] = 'brightgreen';
      data = getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // Errored
      input['sha'] = ids[3];
      expected['message'] = 'unknown';
      expected['color'] = 'orange';
      data = getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // No coverage
      input['sha'] = ids[2];
      expected['message'] = 'pending';
      expected['color'] = 'orange';
      data = getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.calledOnce(queue.add);
   });

   it('Check error handling', function () {
      expect(() => getBadgeData(input)).to.throw(ReferenceError, 'sha');
      input['sha'] = ids[0]
      expect(() => getBadgeData(input)).to.throw(ReferenceError, 'Context');
      input['context'] = 'updated'
      expect(() => getBadgeData(input)).to.throw(TypeError, 'context');
   });

   afterEach(function () {
      queue.pile = [];
      sandbox.restore();
   });

});
