const fs = require('fs');
const cp = require('child_process');
const shell = require('shelljs');

const config = require('../config/config').settings
const assert = require('assert')
const sinon = require('sinon');
const expect = require('chai').expect
const lib = require('../lib');
const queue = require('../lib').queue;

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
        assert(Array.isArray(lib.ensureArray(s)), 'failed to return array')
        assert.deepStrictEqual(lib.ensureArray(s), [s], 'failed to return array')
        let arr = ['bar']
        assert.strictEqual(lib.ensureArray(arr), arr, 'failed to return array')
    });
});


/**
 * This tests the shields callback which returns sheilds.io API data for coverage and build status.
 */
describe("strToBool function", () => {
   it('Check valid true', () => {
       strings = ['on', 'true', 'True', '1', 'ON'];
       strings.forEach((x) => { expect(lib.strToBool(x)).true; });
   });

   it('Check valid false', () => {
       strings = ['', null, undefined, '0', 'false'];
       strings.forEach((x) => { expect(lib.strToBool(x)).false; });
   });
});


/**
 * A test for the function partial.  Should curry function input.
 */
describe('Test partial:', function() {
    it('expect curried function', function () {
        let f = (a, b) => { return a + b; };
        let f0 = lib.partial(f);
        expect(f0(2)).instanceOf(Function);
        expect(f0(2, 2)).eq(4);
    });
});


/**
 * A test for the function getRepoPath
 */
describe('Test getRepoPath:', function() {
    it('expect returned from env', function () {
        let repoPath = lib.getRepoPath();
        expect(repoPath).eq(process.env.REPO_PATH);
    });
});


/**
 * A test for the function addParam
 */
describe('Test addParam:', function() {
    it('expect deals with slash', function () {
        let url = 'https://example.com';
        const param = 'param=value';
        expect(lib.addParam(url, param)).eq(lib.addParam(url + '/', param));
        url += '/foo';
        expect(lib.addParam(url, param)).eq(url + '/?' + param);
        expect(lib.addParam(url, param)).eq(lib.addParam(url + '/', param));
    });

    it('expect handles multiple params', function () {
        const url = 'https://example.com';
        const param1 = 'param=value';
        const param2 = 'par=val';
        const expected = 'https://example.com/?param=value&par=val';
        expect(lib.addParam(url, param1, param2)).eq(expected);
    });
});


/**
 * A test for the function context2routine
 */
describe('Test context2routine:', function() {
    it('expect returns default', function () {
        const context = 'anything';
        const expected = config['routines']['*'];
        expect(lib.context2routine(context)).eq(expected);
    });
});


/**
 * A test for the function compareCoverage.
 * @todo add test for strict compare
 */
describe('Test compareCoverage:', function() {
   var job;

   beforeEach(function () {
      queue.process(async (_job, _done) => {
      });  // nop
      queue.pile = [];
      job = {
         data: {
            sha: null
         }
      };
   })

   it('expect coverage diff', function () {
      // Test decrease in coverage
      job.data.sha = ids[0];
      job.data.base = ids[1];
      lib.compareCoverage(job);
      expect(job.data.status).eq('failure');
      expect(job.data.description).contains('decreased');
      expect(queue.pile).empty;

      // Test increase in coverage
      job.data.coverage = 95.56
      lib.compareCoverage(job);
      expect(job.data.status).eq('success');
      expect(job.data.description).contains('increased');
      expect(queue.pile).empty;
   });

   it('expect ReferenceError', function () {
      job.data.base = null;
      expect(() => lib.compareCoverage(job)).throws(ReferenceError);
   });

   it('expect fail status', function () {
      job.data.sha = ids[0];
      job.data.base = ids[3];  // errored
      lib.compareCoverage(job);
      expect(job.data.status).eq('failure');
      expect(job.data.description).contains('incomplete');
      expect(queue.pile).empty;
   });

   it('expect job added', function () {
      // Test decrease in coverage
      job.data.sha = ids[2];  // fake
      job.data.base = ids[1];
      job.data.context = 'coverage';
      lib.compareCoverage(job);
      expect(queue.pile.length).eq(2);
      expect(job.data.skipPost).true;  // Job should be skipped to allow time for jobs to run
      expect(queue.pile[0].data.sha).eq(ids[1])
      expect(queue.pile[1].data.skipPost).false;
      expect(queue.pile[1].data.context).eq(job.data.context)
   });
});


/**
 * A test for the function updateJobFromRecord.
 * @todo add test for compareCoverage call
 */
describe('Test updateJobFromRecord:', function() {
    var job;

    beforeEach(function() {
        queue.process(async (_job, _done) => {});  // nop
        queue.pile = [];
        job = {
            data: {
                sha: null
            }
        };
   })

    it('expect no record found', function () {
        job.data.sha = ids[2];
        const updated = lib.updateJobFromRecord(job);
        expect(updated).false;
    });

    it('expect updated', function () {
        job.data.sha = ids[0];
        const updated = lib.updateJobFromRecord(job);
        expect(updated).true;
        expect(job.data).deep.keys(['sha', 'status', 'description', 'coverage']);
    });
});


/**
 * A test for the function startJobTimer.  Should kill the process when time is up and update the
 * job data.
 */
describe('Test startJobTimer:', function() {
    var clock;

    before(() => { clock = sinon.useFakeTimers(); });

    it('expect process killed', function (done) {
        const childProcess = {
            kill: () => { done(); },
            pid: 10108
        };
        const job = { data: {process: childProcess} };
        lib.startJobTimer(job);
        // Skip to the end...
        clock.tick(config.timeout + 1);
    });

    it('expect tree-killed', function (done) {
        // Test tree-kill switch.  We can't stub function exports so we'll use a slow ping command
        // and kill it.  Should be relatively consistent across platforms.
        const cmd = 'ping 127.0.0.1 -n 6 > nul';
        const childProcess = cp.exec(cmd, () => { done(); });
        childProcess.kill = () => {};  // nop
        const job = { data: {process: childProcess} };
        lib.startJobTimer(job, true);
        // Skip to the end...
        clock.tick(config.timeout + 1);
    });

    after(() => { clock.restore(); })
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
        const record = lib.loadTestRecords(id);
        assert(record != null, 'failed to load record')
        assert(!Array.isArray(record), 'failed to return single obj')
        assert.strictEqual(record.commit, id, 'failed to return correct record')
    });

    it('Check loading multiple records', function () {
        const records = lib.loadTestRecords(ids);
        assert(records != null, 'failed to load records')
        assert(Array.isArray(records), 'failed to return array')
        assert.strictEqual(records.length, ids.length-1, 'failed to return both records')
    });

    it('Check loading fail', function () {
        let id = ids[2]  // this commit is not in db
        const record = lib.loadTestRecords(id);
        let isEmptyArr = x => { return Array.isArray(x) && x.length === 0; }
        assert(isEmptyArr(record))
        assert(isEmptyArr(lib.loadTestRecords([id, id])))
    });
});


/**
 * A test for the function saveTestRecords.
 */
describe('Test saving test records:', function() {
    var backup;

    // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    before(function () {
        assert(process.env.NODE_ENV.startsWith('test'), 'Test run outside test env')
        backup = config.dbFile + Date.now();
        fs.copyFileSync(config.dbFile, backup);
    });

    it('Check saving existing record', async function () {
        const record = lib.loadTestRecords(ids[0]);
        delete record['results'];  // remove a field
        record['status'] = 'passed';  // change a field
        await lib.saveTestRecords(record);
        const new_record = lib.loadTestRecords(record['commit']);
        assert.strictEqual(new_record.status, record.status, 'failed to update record');
        assert(new_record.results !== undefined);
    });

    it('Check saving new records', async function () {
        const records = [
           lib.loadTestRecords(ids[1]),
           {
            'commit': ids[1].replace('2', '3'), // not in db
            'status': 'error',
           }
        ];
        records[0]['status'] = 'error';  // change a field
        await lib.saveTestRecords(records);
        const new_records = lib.loadTestRecords(records.map(x => x.commit));
        assert(new_records.length === 2);
        for (o of new_records) {
           assert.strictEqual(o.status, 'error', 'failed to update all records');
        }
    });

    it('Check validation errors', function (done) {
        const record = {
           commit: ids[2],
           status: 'success'
        };
        lib.saveTestRecords(record).catch(err => {
           expect(err).instanceOf(lib.APIError);
           done();
        });
    });

    after(function () {
        fs.renameSync(backup, config.dbFile);
    });
});


/**
 * This tests the shields callback which returns sheilds.io API data for coverage and build status.
 */
describe("getBadgeData function", () => {
   const sandbox = sinon.createSandbox();  // Sandbox for spying on queue
   var input;  // Input data for function

   beforeEach(function () {
      queue.process(async (_job, _done) => {})  // nop
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
      data = lib.getBadgeData(input);
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
      data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // Errored
      input['sha'] = ids[3];
      expected['message'] = 'unknown';
      expected['color'] = 'orange';
      data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // No coverage
      input['sha'] = ids[2];
      expected['message'] = 'pending';
      expected['color'] = 'orange';
      data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.calledOnce(queue.add);
   });

   it('Check build status', function () {
      var data, expected;

      // Failed tests
      input['sha'] = ids[0];
      input['context'] = 'build';
      data = lib.getBadgeData(input);
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
      data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // Errored
      input['sha'] = ids[3];
      expected['message'] = 'errored';
      expected['color'] = 'red';
      data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.notCalled(queue.add);

      // No coverage
      input['sha'] = ids[2];
      expected['message'] = 'pending';
      expected['color'] = 'orange';
      data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.calledOnce(queue.add);

      // Shouldn't add as job already queued
      data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.calledOnce(queue.add);
   });

   it('Check force flag', function () {
      input['sha'] = ids[1];
      input['context'] = 'build';
      input['force'] = true;  // set force flag to true
      const expected = {
         schemaVersion: 1,
         label: 'build',
         message: 'pending',
         color: 'orange'
      };
      let data = lib.getBadgeData(input);
      expect(data).to.deep.equal(expected);
      sandbox.assert.calledOnce(queue.add);
   });

   it('Check error handling', function () {
      expect(() => lib.getBadgeData(input)).to.throw(ReferenceError, 'sha');
      input['sha'] = ids[0]
      expect(() => lib.getBadgeData(input)).to.throw(ReferenceError, 'Context');
      input['context'] = 'updated'
      expect(() => lib.getBadgeData(input)).to.throw(TypeError, 'context');
   });

   afterEach(function () {
      queue.pile = [];
      sandbox.restore();
   });

});


/**
 * A test for the main queue process callback.
 */
describe('Test short circuit', function() {

    beforeEach(function () {
        queue.process(async (_job, _done) => {});  // nop
        queue.pile = [];
    });

    it('expect force flag set', function (done) {
       // We expect that the job that's on the pile has 'force' set to false
        // Add job to the pile
        queue.add( { sha: ids[0] })  // Record exists
        function tests(run) {
           expect(run).true;
           expect(queue.pile[0].data.force).false;
           done();
        }
        const job = {
           data: {
              sha: ids[0]  // Record exists
           },
           done: () => tests(false)
        };

        lib.shortCircuit(job, () => { tests(true); });
    });

    it('expect short circuit', function (done) {
       // We expect that the job that's on the pile has 'force' set to false
        const job = {
           data: {
              sha: ids[0],  // record exists
              force: false  // load from record
           }
        };
        function tests(run) {
           expect(run).false;
           expect(job.data.status).eq('failure');
           done();
        }
        job.done = () => tests(false);
        lib.shortCircuit(job, () => tests(true));
    });

    it('expect forced test function called', function (done) {
       // Record doesn't exist, so we expect the tests to be run anyway
        function tests(run) {
           expect(run).true;
           done();
        }
        const job = {
           data: {
              sha: ids[2],  // record exists
              force: false  // load from record
           },
           done: () => tests(false)
        };
        lib.shortCircuit(job, () => tests(true));
    });
});


/**
 * A test for shortID function.
 */
describe('Test shortID', function() {

   it('expect short str from int', function () {
      const out = lib.shortID(987654321);
      expect(out).eq('9876543');
   });

   it('expect short str from str', function () {
      const out = lib.shortID('98r7654321o', 3);
      expect(out).eq('98r');
   });

   it('expect works with arrays', function () {
      const out = lib.shortID([987654321, '7438ht43', null], 3);
      expect(out).deep.equal(['987', '743', null]);
   });

});


/**
 * A test for isSHA function.
 */
describe('Test isSHA', function() {

   it('expect true on SHA', function () {
      expect(lib.isSHA(ids[0])).true;
   });

   it('expect false on fake', function () {
      expect(lib.isSHA(ids[2])).false;
   });
});


/**
 * A test for listSubmodules function.
 */
describe('Test listSubmodules', function() {
    const sandbox = sinon.createSandbox();
    const submodules = 'submodule.alyx-matlab.path alyx-matlab\nsubmodule.signals.path signals\n';

    beforeEach(function() {
        sandbox.spy(shell, 'pushd');
        sandbox.spy(shell, 'popd');
    });

   it('expect array returned', function () {
      // NB: This test is over-engineered :(
       const output = {
           code: 0,
           stdout: submodules,
           match: (str) => submodules.match(str)
       };
       sandbox
           .stub(shell, 'exec')
           .returns(output);
       sandbox
           .stub(shell, 'which')
           .withArgs('git')
           .returns(true);
       const moduleList = lib.listSubmodules(process.env['REPO_PATH']);
       expect(moduleList).deep.eq(['alyx-matlab', 'signals']);
       expect(shell.pushd.calledOnce);
       expect(shell.pushd.calledOnceWith(process.env['REPO_PATH']));
       expect(shell.popd.calledOnce);
   });

   it('expect empty array returned', function () {
        const output = {
           code: 0,
           stdout: '',
           match: (str) => ''.match(str)
        };
        sandbox
           .stub(shell, 'exec')
           .returns(output);
        sandbox
           .stub(shell, 'which')
           .withArgs('git')
           .returns(true);
        const moduleList = lib.listSubmodules(process.env['REPO_PATH']);
        expect(moduleList).to.be.empty;
   });

   it('expect error', function () {
        sandbox
           .stub(shell, 'which')
           .withArgs('git')
           .returns(null);
        expect(() => lib.listSubmodules(process.env['REPO_PATH'])).to.throw();
   });

    afterEach(function() {
        sandbox.restore();
    });

});

