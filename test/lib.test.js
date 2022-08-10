const fs = require('fs');
const cp = require('child_process');
const events = require('events');
const shell = require('shelljs');
const path = require('path');

const config = require('../config/config').settings;
const assert = require('assert');
const sinon = require('sinon');
const expect = require('chai').expect;
const lib = require('../lib');
const queue = require('../lib').queue;
const {stdErr} = require('./fixtures/static');

ids = [
    'cabe27e5c8b8cb7cdc4e152f1cf013a89adc7a71',
    '1c33a6e2ac7d7fc098105b21a702e104e09767cf',
    'hf4ac7d7fc0983748702e10738hw4382f347fu38',  // Fake
    '7bdf62'  // errored
];


/**
 * A test for the function ensureArray.  Should return an array but not affect array inputs.
 */
describe('Test ensureArray:', function () {
    it('Check returns array', function () {
        let s = 'foo';
        assert(Array.isArray(lib.ensureArray(s)), 'failed to return array');
        assert.deepStrictEqual(lib.ensureArray(s), [s], 'failed to return array');
        let arr = ['bar'];
        assert.strictEqual(lib.ensureArray(arr), arr, 'failed to return array');
    });
});


/**
 * This tests the shields callback which returns sheilds.io API data for coverage and build status.
 */
describe('strToBool function', () => {
    it('Check valid true', () => {
        strings = ['on', 'true', 'True', '1', 'ON'];
        strings.forEach((x) => {
            expect(lib.strToBool(x)).true;
        });
    });

    it('Check valid false', () => {
        strings = ['', null, undefined, '0', 'false'];
        strings.forEach((x) => {
            expect(lib.strToBool(x)).false;
        });
    });
});


/**
 * A test for the function partial.  Should curry function input.
 */
describe('Test partial:', function () {
    it('expect curried function', function () {
        let f = (a, b) => {
            return a + b;
        };
        let f0 = lib.partial(f);
        expect(f0(2)).instanceOf(Function);
        expect(f0(2, 2)).eq(4);
    });
});


/**
 * A test for the function getRepoPath
 */
describe('Test getRepoPath:', function () {
    afterEach(() => {
        if (config.repos !== undefined) {
            delete config.repos;
        }
    });

    it('expect returned from env', function () {
        let repoPath = lib.getRepoPath();
        expect(repoPath).eq(process.env.REPO_PATH);
    });

    it('expect returned from config', function () {
        config.repos = {
            main: 'path/to/main',
            submodule: 'path/to/submodule'
        };
        let repoPath = lib.getRepoPath('main');
        expect(repoPath).eq(config.repos.main);
    });
});


/**
 * A test for the function addParam
 */
describe('Test addParam:', function () {
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
describe('Test context2routine:', function () {
    it('expect returns default', function () {
        const context = 'anything';
        const expected = config['routines']['*'];
        expect(lib.context2routine(context)).eq(expected);
    });
});


/**
 * A test for the function compareCoverage.
 */
describe('Test compareCoverage:', function () {
    var job;
    const _default_coverage = config.strict_coverage;

    beforeEach(function () {
        queue.process(async (_job, _done) => {});  // nop
        queue.pile = [];
        job = {
            data: {
                sha: null
            }
        };
    });

    afterEach(function () {
        // Restore default config param
        config.strict_coverage = _default_coverage;
    });

    it('expect coverage diff', function () {
        // Test decrease in coverage
        job.data.sha = ids[0];
        job.data.base = ids[1];
        lib.compareCoverage(job);
        expect(job.data.status).eq('failure');
        expect(job.data.description).contains('decreased');
        expect(queue.pile).empty;

        // Test increase in coverage
        job.data.coverage = 95.56;
        lib.compareCoverage(job);
        expect(job.data.status).eq('success');
        expect(job.data.description).contains('increased');
        expect(queue.pile).empty;

        // Test slight increase
        job.data.coverage = 75.7746;
        lib.compareCoverage(job);
        expect(job.data.status).eq('success');
        expect(job.data.description).contains('increased slightly');
        expect(queue.pile).empty;
    });

    it('test strict coverage', function () {
        job.data.sha = ids[0];
        job.data.base = ids[1];
        job.data.coverage = 75.77018633540374;

        // Test strict coverage off
        config.strict_coverage = false;
        lib.compareCoverage(job);
        expect(job.data.status).eq('success');
        expect(job.data.description).contains('remains at');
        expect(queue.pile).empty;

        // Test strict coverage on
        config.strict_coverage = true;
        lib.compareCoverage(job);
        expect(job.data.status).eq('failure');
        expect(job.data.description).contains('remains at');
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
        expect(queue.pile[0].data.sha).eq(ids[1]);
        expect(queue.pile[1].data.skipPost).false;
        expect(queue.pile[1].data.context).eq(job.data.context);
    });
});


/**
 * A test for the function updateJobFromRecord.
 * @todo add test for compareCoverage call
 */
describe('Test updateJobFromRecord', function () {
    var job;

    beforeEach(function () {
        queue.process(async (_job, _done) => {});  // nop
        queue.pile = [];
        job = {
            data: {
                sha: null
            }
        };
    });

    it('expect no record found', async function () {
        job.data.sha = ids[2];
        const updated = await lib.updateJobFromRecord(job);
        expect(updated).false;
    });

    it('expect updated', async function () {
        job.data.sha = ids[0];
        const updated = await lib.updateJobFromRecord(job);
        expect(updated).true;
        expect(job.data).deep.keys(['sha', 'status', 'description', 'coverage']);
    });
});


/**
 * A test for inserting the duration in description field by updateJobFromRecord.
 */
describe('Test duration in description', function () {
    var job;
    var _dbFile = config.dbFile;

    before(function (done) {
        job = {
            data: {
                sha: ids[1]
            },
            created: new Date(Date.now() - 1000 * 60 * 10)
        };
        config.dbFile = path.join(path.parse(config.dbFile).dir, '._db.json');
        fs.copyFile(_dbFile, config.dbFile, err => {
            if (err) throw err;
            done();
        });
    });

    after(function () {
        queue.pile = [];  // In case a job was added
        fs.unlinkSync(config.dbFile);
        config.dbFile = _dbFile;
    });

    it('expect duration in description', async function () {
        const updated = await lib.updateJobFromRecord(job);
        expect(updated).true;
        expect(job.data.description).contains('10 min');
    });

    it('expect truncated description', async function () {
        const records = JSON.parse(await fs.promises.readFile(config.dbFile, 'utf8'));
        records[1]['description'] = 'Lorem ipsum '.repeat(13);
        await fs.promises.writeFile(config.dbFile, JSON.stringify(records));
        const updated = await lib.updateJobFromRecord(job);
        expect(updated).true;
        expect(job.data.description.length).lte(config.max_description_len);
        expect(job.data.description.endsWith('... (took 10 min)')).true;
    });
});


/**
 * A test for the function startJobTimer.  Should kill the process when time is up and update the
 * job data.
 */
describe('Test startJobTimer:', function () {
    var clock;

    before(() => {
        clock = sinon.useFakeTimers();
        queue.process(() => {});
        queue.pile = [];
    });

    it('expect process killed', function (done) {
        const childProcess = {
            kill: () => { done(); },
            pid: 10108
        };
        const job = queue.add({});
        job.child = childProcess;
        lib.startJobTimer(job);
        // Skip to the end...
        clock.tick(config.timeout + 1);
    });

    it('expect tree-killed', function (done) {
        // Test tree-kill switch.  We can't stub function exports so we'll use a slow ping command
        // and kill it.  Should be relatively consistent across platforms.
        const job = queue.add({});
        const cmd = 'ping 127.0.0.1 -n 6 > nul';
        job.child = cp.exec(cmd, () => { done(); });
        job._child.kill = () => {
        };  // nop
        lib.startJobTimer(job, true);
        // Skip to the end...
        clock.tick(config.timeout + 1);
    });

    after(() => {
        clock.restore();
    });

    afterEach(() => {
        queue.pile = [];
    });
});


/**
 * A test for the function initCoveralls.  Should modify the env variables with coveralls data.
 */
describe('Test initCoveralls:', function () {
    var env_bk;

    before(() => {
        env_bk = process.env;
    });

    it('expect env modified', function () {
        const job = {
            id: Number(Math.floor(Math.random() * 1e6)),
            data: {
                sha: ids[0],
                branch: 'FooBar'
            }
        };
        lib.initCoveralls(job);
        expect(process.env.COVERALLS_GIT_COMMIT).eq(ids[0]);
        expect(process.env.COVERALLS_GIT_BRANCH).eq('FooBar');
        expect(process.env.COVERALLS_SERVICE_JOB_ID).eq(job.id.toString());
        expect(process.env).to.not.have.property('CI_PULL_REQUEST');
        expect(process.env).to.not.have.property('COVERALLS_SERVICE_NAME');
        // Remove branch from job data
        delete job.data.branch;
        lib.initCoveralls(job);
        expect(process.env).to.not.have.property('COVERALLS_GIT_BRANCH');
    });

    afterEach(() => {
        process.env = env_bk;
    });
});


/**
 * This tests the buildRoutine function.
 */
describe('running tests', () => {
    var sandbox;  // Sandbox for spying on queue
    var spawnStub;  // Main fileExec stub
    var execEvent;
    var job;

    function childProcessStub(errmsg) {
        if (errmsg) {
            return () => {  // Return function to raise exception
                setImmediate(() => {
                    execEvent.stderr.emit('data', errmsg);
                });
                setImmediate(() => {
                    execEvent.exitCode = 1;
                    execEvent.emit('exit', execEvent.exitCode, null);
                });
                setImmediate(() => {
                    execEvent.emit('close', 1, null);
                });
                return execEvent;
            };
        } else {
            return () => {  // Return function to successfully execute
                setImmediate(() => {
                    execEvent.exitCode = 0;
                    execEvent.emit('exit', execEvent.exitCode, null);
                });
                setImmediate(() => {
                    execEvent.emit('close', 0, null);
                });
                return execEvent;
            };
        }
    }

    before(() => {
        sandbox = sinon.createSandbox();
    });

    beforeEach(function () {
        spawnStub = sandbox.stub(cp, 'spawn');
        execEvent = new events.EventEmitter();
        execEvent.stdout = execEvent.stderr = new events.EventEmitter();
        execEvent.stdout.pipe = sandbox.spy();
        execEvent.exitCode = null; // NB: Must be set before another process is attached to Job
        job = {
            id: 123,
            data: {sha: ids[0]},
            done: () => {}
        };
    });

    it('expect default routine', fin => {
        // Create a job field with no routine field
        job.done = validate;
        let log = path.join(config.dataPath, 'reports', ids[0], 'std_output-cabe27e.log');
        let tasks = config['routines']['*'].map(x => path.resolve(path.join(__dirname, '..', x)));
        spawnStub.callsFake(childProcessStub());
        lib.buildRoutine(job);

        function validate(err) {
            for (let fn of tasks) {
                spawnStub.calledWith(fn, [ids[0], config.repo, config.dataPath]);
            }
            expect(spawnStub.calledTwice).true;
            expect(err).undefined;
            expect(fs.existsSync(log)).true;
            fin();
        }
    });

    it('test missing file error', fin => {
        job.done = validate;

        // Raise a file not found error
        spawnStub.callsFake(() => {
            const err = new Error('ENOENT');
            err.code = 'ENOENT';
            err.path = config['routines']['*'][0];
            setImmediate(() => {
                execEvent.emit('error', err, null);
            });
            return execEvent;
        });
        sandbox.stub(fs.promises, 'writeFile');
        sandbox.stub(fs.promises, 'readFile').resolves('[]');
        lib.buildRoutine(job).finally(fin);

        function validate(err) {
            expect(spawnStub.calledOnce).true;
            expect(err.message).matches(/File ".*?" not found/);
        }
    });

    it('test misc spawn error', fin => {
        job.done = validate;

        // Raise a file not found error
        spawnStub.callsFake(() => {
            const err = new Error('Unknown error');
            err.code = -1;
            err.path = config['routines']['*'][0];
            setImmediate(() => {
                execEvent.emit('error', err, null);
            });
            return execEvent;
        });
        sandbox.stub(fs.promises, 'writeFile');
        sandbox.stub(fs.promises, 'readFile').resolves('[]');
        lib.buildRoutine(job).finally(fin);

        function validate(err) {
            expect(spawnStub.calledOnce).true;
            expect(err.message).matches(/Failed to spawn/);
        }
    });

    /**
     * This tests handling error caused by routine failing to save a test record into the JSON db
     */
    it('test update from record error', fin => {
        job.done = validate;
        job.data.sha = ids[2];  // No record for this SHA

        // Raise a file not found error
        spawnStub.callsFake(childProcessStub());
        sandbox.stub(fs.promises, 'writeFile');
        sandbox.stub(fs.promises, 'readFile').resolves('[]');
        lib.buildRoutine(job).finally(fin);

        function validate(err) {
            expect(spawnStub.calledTwice).true;
            expect(err.message).contains('test result');
        }
    });

    it('runtests parses MATLAB error', (fin) => {
        var err;
        const errmsg = 'Error in MATLAB_function line 23';
        job.done = (e) => { err = e; };

        // Exit with a MATLAB error
        spawnStub.callsFake(childProcessStub(errmsg));
        sandbox.stub(fs.promises, 'readFile').resolves('[]');
        sandbox.stub(fs.promises, 'writeFile').callsFake((db_path, rec) => {
            expect(db_path).eq(config.dbFile);
            expect(rec).contains(errmsg);
            expect(spawnStub.calledOnce).true;
            expect(err.message).to.have.string(errmsg);
            fin();
        });
        lib.buildRoutine(job);
    });

    it('runtests parses Python error', fin => {
        var err;
        job.done = (e) => { err = e; };

        // Exit with a Python error
        spawnStub.callsFake(childProcessStub(stdErr));
        sandbox.stub(fs.promises, 'readFile').resolves('[]');
        sandbox.stub(fs.promises, 'writeFile').callsFake((db_path, rec) => {
            expect(db_path).eq(config.dbFile);
            let errmsg = 'FileNotFoundError: Invalid data root folder ';
            expect(rec).contains(errmsg);
            expect(spawnStub.calledOnce).true;
            expect(err.message).to.have.string(errmsg);
            fin();
        });
        lib.buildRoutine(job);
    });

    it('runtests parses flake error', fin => {
        var err;
        job.done = (e) => { err = e; };
        const flake_stderr = ('foobar...\n' +
            './oneibl/params.py:4:1: F401 \'pathlib.PurePath\' imported but unused\n' +
            './ibllib/tests/qc/test_dlc_qc.py:11:1: F401 \'brainbox.core.Bunch\' imported but unused'
        );

        // Exit with flake8 errors
        spawnStub.callsFake(childProcessStub(flake_stderr));
        sandbox.stub(fs.promises, 'readFile').resolves('[]');
        sandbox.stub(fs.promises, 'writeFile').callsFake((db_path, rec) => {
            expect(db_path).eq(config.dbFile);
            expect(rec).contains('2 flake8 errors');
            expect(spawnStub.calledOnce).true;
            expect(err.message).matches(/F401 '.*' imported but unused/);
            fin();
        });
        lib.buildRoutine(job);
    });

    it('should open and close log', fin => {
        const logSpy = {
            close: sandbox.stub(),
            on: () => {}
        };
        sandbox.stub(fs, 'createWriteStream').returns(logSpy);
        sandbox.stub(fs, 'mkdir');
        logSpy.close.callsFake(fin);
        spawnStub.callsFake(childProcessStub());
        lib.buildRoutine(job);
    });

    it('expect loads test record', fin => {
        queue.process(lib.buildRoutine);
        queue.on('error', _ => {});

        function validate(err, job) {
            expect(err).undefined;
            expect(job._child).eq(execEvent);
            expect(job.data.status).eq('failure');
            expect(job.data.coverage).approximately(22.1969, 0.001);
            fin();
        }

        sandbox.stub(queue._events, 'finish').value([validate]);
        spawnStub.callsFake(childProcessStub());
        queue.add({sha: ids[0]});
    });

    afterEach(function (done) {
        queue.pile = [];
        delete queue.process;
        sandbox.verifyAndRestore();
        const logDir = path.join(config.dataPath, 'reports');
        fs.rmdir(logDir, {recursive: true}, err => {
            if (err) throw err;
            done();
        });
    });

});


/**
 * A test for the function loadTestRecords.
 */
describe('Test loading test records:', function () {
    // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    before(function () {
        assert(process.env.NODE_ENV.startsWith('test'), 'Test run outside test env');
    });

    it('Check loading existing record', function () {
        let id = ids[0];
        const record = lib.loadTestRecords(id);
        assert(record != null, 'failed to load record');
        assert(!Array.isArray(record), 'failed to return single obj');
        assert.strictEqual(record.commit, id, 'failed to return correct record');
    });

    it('Check loading multiple records', function () {
        const records = lib.loadTestRecords(ids);
        assert(records != null, 'failed to load records');
        assert(Array.isArray(records), 'failed to return array');
        assert.strictEqual(records.length, ids.length - 1, 'failed to return both records');
    });

    it('Check loading fail', function () {
        let id = ids[2];  // this commit is not in db
        const record = lib.loadTestRecords(id);
        let isEmptyArr = x => {
            return Array.isArray(x) && x.length === 0;
        };
        assert(isEmptyArr(record));
        assert(isEmptyArr(lib.loadTestRecords([id, id])));
    });
});


/**
 * A test for the function saveTestRecords.
 */
describe('Test saving test records:', function () {
    var backup;
    const dbFile = config.dbFile;  // Store default path so we can change it

    // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    before(function () {
        assert(process.env.NODE_ENV.startsWith('test'), 'Test run outside test env');
        backup = config.dbFile + Date.now();
        fs.copyFileSync(config.dbFile, backup);
    });

    // Restore correct dbFile path
    afterEach(done => {
        if (config.dbFile !== dbFile) {
            fs.unlink(config.dbFile, err => {
                if (err) {
                    console.error(err);
                }
                config.dbFile = dbFile;
                done();
            });
        } else {
            done();
        }
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
                'status': 'error'
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

    it('Check missing file error', function (done) {
        config.dbFile = path.join(path.parse(config.dbFile)['dir'], '.missing_db.json');  // Non-existent db file
        assert(!fs.existsSync(config.dbFile));
        const record = {
            commit: ids[0],
            status: 'success'
        };
        lib.saveTestRecords(record).then(() => {
            expect(fs.existsSync(config.dbFile)).true;
            done();
        });
    });

    it('Expect catches parse file error', async () => {
        const incomplete = '{"commit": "7bdf62", "status": "error", "description": "."}]';
        await fs.promises.writeFile(config.dbFile, incomplete);
        const record = {
            commit: ids[0],
            status: 'success'
        };
        try {
            await lib.saveTestRecords(record);
            assert(false, 'failed to throw error');
        } catch (err) {
            expect(err).instanceOf(SyntaxError);
        }
    });

    after(function () {
        fs.renameSync(backup, config.dbFile);
    });
});


/**
 * This tests the shields callback which returns sheilds.io API data for coverage and build status.
 */
describe('getBadgeData function', () => {
    const sandbox = sinon.createSandbox();  // Sandbox for spying on queue
    var input;  // Input data for function

    beforeEach(function () {
        queue.process(async (_job, _done) => {
        });  // nop
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

    it('Check tests status', function () {
        var data, expected;

        // Failed tests
        input['sha'] = ids[0];
        input['context'] = 'tests';
        data = lib.getBadgeData(input);
        expected = {
            schemaVersion: 1,
            label: 'tests',
            message: '297 passed, 18 failed, 5 skipped',
            color: 'red'
        };
        expect(data).to.deep.equal(expected);
        sandbox.assert.notCalled(queue.add);

        // Errored
        input['sha'] = ids[3];
        expected['message'] = 'errored';
        expected['color'] = 'red';
        data = lib.getBadgeData(input);
        expect(data).to.deep.equal(expected);
        sandbox.assert.notCalled(queue.add);

        // No stats field
        input['sha'] = ids[1];
        expected['message'] = 'passed';
        expected['color'] = 'brightgreen';
        data = lib.getBadgeData(input);
        expect(data).to.deep.equal(expected);
        sandbox.assert.notCalled(queue.add);
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
        input['sha'] = ids[0];
        expect(() => lib.getBadgeData(input)).to.throw(ReferenceError, 'Context');
        input['context'] = 'updated';
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
describe('Test short circuit', function () {

    beforeEach(function () {
        queue.process(async (_job, _done) => {
        });  // nop
        queue.pile = [];
    });

    it('expect force flag set', function (done) {
        // We expect that the job that's on the pile has 'force' set to false
        // Add job to the pile
        queue.add({sha: ids[0]});  // Record exists
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

        lib.shortCircuit(job, () => {
            tests(true);
        });
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
describe('Test shortID', function () {

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
describe('Test isSHA', function () {

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
describe('Test listSubmodules', function () {
    const sandbox = sinon.createSandbox();
    const submodules = 'submodule.alyx-matlab.path alyx-matlab\nsubmodule.signals.path signals\n';

    beforeEach(function () {
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

    afterEach(function () {
        sandbox.restore();
    });

});

