/**
 * A module containing helper and callback functions for continuous integration.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const createDebug = require('debug');
const localtunnel = require('localtunnel');
const kill = require('tree-kill');
const shell = require('shelljs');

const config = require('./config/config').settings;
const Coverage = require('./coverage');
const queue = new (require('./queue.js'))();  // The queue object for our app to use


/**
 * Return a shortened version of an int or string id
 * @param {any} v - ID to shorten.
 * @param {int} len - Maximum number of chars.
 * @returns {String} v as a short string.
 */
function shortID(v, len = 7) {
    if (Array.isArray(v)) return v.map(v => shortID(v, len));
    if (Number.isInteger(v)) v = v.toString();
    if (typeof v === 'string' || v instanceof String) v = v.substr(0, len);
    return v;  // If not string, array or number, leave unchanged
}

// Attach shortID function to logger formatter
createDebug.formatters.g = shortID;
const log = createDebug('ci');
const _log = log.extend('lib');


/**
 * Test commit has is valid.  Assumes hash is at least 7 characters long.
 * @param {String} id - String under test.
 * @returns {boolean} true if id is a valid SHA
 */
function isSHA(id) {
    const regex = /^[0-9a-f]{7,40}$/i;
    return (typeof id === 'string' || id instanceof String) && id.match(regex) !== null;
}


/**
 * Returns a full filepath.  Plays nicely with ~.
 * @param {String} p - Path to resolve.
 * @returns {String} A full path
 */
function fullpath(p) {
    if (p[0] === '~') {
        return path.join(process.env.HOME, p.slice(1));
    } else {
        return path.resolve(p);
    }
}


/**
 * Util wraps input in array if not already one
 * @param {Object} x - Input to ensure as array.
 * @returns {Array} x as an array.
 */
function ensureArray(x) {
    return (Array.isArray(x)) ? x : [x];
}


/**
 * Will match one and only one of the string 'true','1', or 'on' regardless of capitalization and
 * regardless of surrounding white-space.  (Thx to shrewmouse).
 * @param {string} s - String to test
 * @returns {boolean} s as bool
 */
function strToBool(s) {
    return /^\s*(true|1|on)\s*$/i.test(s);
}


/**
 * Get the routine for a given context from the settings JSON.
 * @param {String} context - The context.
 * @returns {Array} The test routine, i.e. an array of functions/scripts to call
 */
function context2routine(context) {
    const opts = ('routines' in config) ? config['routines'] : null;
    if (!opts) return null;
    let routine = ('*' in opts) ? opts['*'] : [];
    if (context in opts) {
        routine += ensureArray(opts[context]);
    }
    return routine;
}


/**
 * Load test results from .db.json file.  NB: Size and order of returned records not guaranteed
 * @param {string, array} id - Commit SHA.
 */
function loadTestRecords(id) {
    // FIXME Catch JSON parse error
    _log('Loading test records from %s for id %g', config.dbFile, id);
    if (!id) throw new TypeError('invalid id');
    if (!fs.existsSync(config.dbFile)) {
        console.log('Records file not found');
        return [];
    }
    let obj = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
    obj = ensureArray(obj);
    let records = obj.filter(o => id.includes(o.commit));
    // If single arg return as object, otherwise keep as array
    return (!Array.isArray(id) && records.length === 1 ? records[0] : records);
}


/**
 * Save test results from .db.json file.  Any matching records are merged before saving.
 * @param {Object, Array} r - The record(s) to save.  Must contain an id field.
 */
async function saveTestRecords(r) {
    var obj;  // the test records
    const byID = (a, b) => b.commit.localeCompare(a.commit);
    r = ensureArray(r).sort(byID);
    if (!r.every(x => isSHA(x.commit))) {
        throw new APIError('"commit" not in record(s)');
    }
    try {
        let data = await fs.promises.readFile(config.dbFile, 'utf8');
        obj = ensureArray(JSON.parse(data));
        let ids = r.map(x => x.commit);
        let records = obj.filter(o => ids.indexOf(o.commit) >= 0);
        // Update existing records
        for (let old of records) {
            let o = r.filter(x => x.commit === old.commit);
            if (o.length > 0) {
                Object.assign(old, o.pop());
            }
        }
        let updated = records.map(x => x.commit);
        r = r.filter(x => updated.indexOf(x.commit) === -1);
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            console.log(`Records file not found at ${config.dbFile}`);
            console.log('Creating records file...');
            obj = [];
        } else {
            throw err;
        }
    }
    // Add new records
    obj = obj.concat(r);
    await fs.promises.writeFile(config.dbFile, JSON.stringify(obj));
}


/**
 * Updates a job's data from saved test records.
 * @param {Object} job - Job object which is being processed.
 * @returns {boolean} - true if record was found
 */
async function updateJobFromRecord(job) {
    let log = _log.extend('updateJobFromRecord');
    log('Loading test records for head commit %g', job.data['sha']);
    let rec = loadTestRecords(job.data['sha']);  // Load test result from json log
    if (rec.length === 0) {  // No record found
        log('No record found, return false');
        return false;
    }
    rec = Array.isArray(rec) ? rec.pop() : rec;  // in case of duplicates, take last
    job.data['status'] = rec['status'];
    job.data['description'] = rec['description'];
    // Append the duration in minutes if available
    if (rec['status'] === 'success' && job.created) {
        let diff = (new Date().getTime() - job.created.getTime()) / 1000;
        let duration = ` (took ${Math.round(diff / 60)} min)`;
        // Truncate description if necessary
        let strSize = (config.max_description_len - duration.length);
        if (job.data['description'].length > strSize) {
            job.data['description'] = job.data['description'].slice(0, strSize - 3) + '...';
        }
        job.data['description'] += duration;
    }
    job.data['coverage'] = ('coverage' in rec) ? rec['coverage'] : null;
    if (!job.data['coverage'] && rec['status'] !== 'error') {
        log('Coverage missing, computing from XML');
        await computeCoverage(job);  // Attempt to load from XML  FIXME deal with failure
    } else if ((job.data.context || '').startsWith('coverage')) {
        log('Comparing coverage to base commit');
        compareCoverage(job);  // If this test was to ascertain coverage, call comparison function
    }
    return true;
}


/**
 * Curry a function for passing incomplete args.
 * @param {Object} func - Function to be curried.
 */
function partial(func) {
    return function curried(...args) {
        if (args.length >= func.length) {
            return func.apply(this, args);
        } else {
            return function (...args2) {
                return curried.apply(this, args.concat(args2));
            };
        }
    };
}


/**
 * Append URL parameters to a URL.
 * @param {String} url - The URL to append parameters to.
 * @param {String} args - One or more URL parameters to append, e.g. 'param=value'
 */
function addParam(url, ...args) {
    if (url.indexOf('&') === -1 && !url.endsWith('/')) {
        url += '/';
    }
    for (let param of args) {
        url += (/\?/g.test(url) ? '&' : '?') + param;
    }
    return url;
}


/**
 * Check if job already has record, if so, update from record and finish, otherwise call tests function.
 * @param {Object} job - Job object which is being processed.
 * @param {Function} func - The tests function to run, e.g. `buildRoutine`.
 */
async function shortCircuit(job, func = null) {
    // job.data contains the custom data passed when the job was created
    // job.id contains id of this job.
    let log = _log.extend('shortCircuit');
    log('Checking whether to load from saved for %s @ %g',
        (job.data.context || '').split('/').pop(), job.data.sha);

    // To avoid running our tests twice, set the force flag to false for any other jobs in pile that
    // have the same commit ID
    let sha = job.data.sha;
    let others = queue.pile.filter(o => (o.data.sha === sha) && (o.id !== job.id));
    for (let other of others) other.data.force = false;
    // If lazy, load records to check whether we already have the results saved
    if (job.data.force === false) {  // NB: Strict equality; force by default
        _log('Updating job data directly from record for job #%g', job.id);
        if (await updateJobFromRecord(job)) return job.done();  // No need to run tests; skip to complete routine
    }

    // Go ahead and prepare to run tests
    if (func) return func(job);
}


/**
 * Configures a persistent reverse proxy to use the same port as our local server.
 * @returns (Class) - A localtunnel instance
 */
const openTunnel = async () => {
    let args = {
        port: config.listen_port,
        subdomain: process.env.TUNNEL_SUBDOMAIN,
        host: process.env.TUNNEL_HOST
    };
    const tunnel = await localtunnel(args);
    console.log(`Tunnel open on: ${tunnel.url}`);
    tunnel.on('close', () => {
        console.log('Reconnecting');
        openTunnel();
    });
    tunnel.on('error', (e) => {
        console.error(e);
    });
    return tunnel;
};


/**
 * Lists the submodules within a Git repository.  If none are found null is returned.
 * @param {String} repoPath - The path of the repository
 * @returns {Array} A list of submodule names, or null if none were found
 */
function listSubmodules(repoPath) {
    if (!shell.which('git')) throw new Error('Git not found on path');
    shell.pushd(repoPath);
    let listModules = 'git config --file .gitmodules --get-regexp path';
    const modules = shell.exec(listModules);
    shell.popd();
    return (!modules.code && modules.stdout !== '') ? modules.match(/(?<=submodule.)[\w-]+/g) : [];
}


/**
 * Get the corresponding repository path for a given repo.  The function first checks the settings.
 * If the `repos` field doesn't exist, the path in ENV is used.  If the name is not a key in the
 * `repos` object then we check each repo path for submodules and return the first matching
 * submodule path.  Otherwise returns null.
 * @param {String} name - The name of the repository
 * @returns {String} The repository path if found
 */
function getRepoPath(name) {
    if (!config.repos) return process.env['REPO_PATH'];  // Legacy, to remove
    if (config.repos[name]) return config.repos[name];  // Found path, return
    const modules = listSubmodules(process.env['REPO_PATH']);
    let repoPath = process.env['REPO_PATH'];
    if (modules && modules.includes(name)) {
        // If the repo is a submodule, modify path
        repoPath += (path.sep + name);
    }
    return repoPath;  // No modules matched, return default
}


/**
 * Starts a timer with a callback to kill the job's process.
 * @param {Object} job - The Job with an associated process in the data field.
 * @param {boolean} kill_children - If true all child processes are killed.
 * @returns {number} - A timeout object.
 */
function startJobTimer(job, kill_children = false) {
    const timeout = config.timeout || 8 * 60000;  // How long to wait for the tests to run
    return setTimeout(() => {
        console.log('Max test time exceeded');
        log(kill_children ? 'Killing all processes' : 'Ending test process');
        let pid = job._child.pid;
        job._child.kill();
        if (kill_children) {
            kill(pid);
        }
    }, timeout);
}


/**
 * Set dynamic env variables for node-coveralls.
 * NB: This does not support submodules.
 * @param {Object} job - The Job with an associated process in the data field.
 */
async function initCoveralls(job) {
    const debug = log.extend('pipeline');
    debug('Setting COVERALLS env variables');
    process.env.COVERALLS_SERVICE_JOB_ID = job.id;
    const envMap = {
        'COVERALLS_SERVICE_NAME': job.data.context,
        'COVERALLS_GIT_COMMIT': job.data.sha,
        'COVERALLS_GIT_BRANCH': job.data.branch,
        'CI_PULL_REQUEST': job.data.pull_number
    };
    for (let key in envMap) { // assign value or delete key
        if (envMap[key]) { process.env[key] = envMap[key]; } else { delete process.env[key]; }
    }
}

/**
 * Build task pipeline.  Takes a list of scripts/functions and builds a promise chain.
 * @param {Object} job - The Job with an associated process in the data field.
 * @returns {Promise} - The job routine
 */
async function buildRoutine(job) {
    const debug = log.extend('pipeline');
    const data = job.data;
    // Get task list from job data, or from context if missing
    const tasks = data.routine ? ensureArray(data.routine) : context2routine(data.context);
    // Throw an error if there is no routine defined for this job
    if (!tasks) throw new Error(`No routine defined for context ${data.context}`);

    debug('Building routine for job #%g', job.id);
    // variables shared between functions
    const repoPath = getRepoPath(data.repo);
    const sha = data['sha'];
    const logDir = path.join(config.dataPath, 'reports', sha);
    const logName = path.join(logDir, `std_output-${shortID(sha)}.log`);
    await fs.promises.mkdir(logDir, { recursive: true });
    const logDump = fs.createWriteStream(logName, {flags: 'w'});
    logDump.on('close', () => {
        debug('Renaming log file');
        let checkName = '_' + (data.context || '').split('/')[0];
        let newName = path.join(logDir, `std_output-${shortID(sha)}${checkName}.log`);
        // fs.rename(logName, newName, () => debug(`Log renamed to ${newName}`));
        fs.copyFile(logName, newName, () => debug(`Log copied to ${newName}`));
    });
    const ops = config.shell ? {'shell': config.shell} : {};

    // If environment variable COVERALLS_REPO_TOKEN is not null, set dynamic variables
    if (process.env.COVERALLS_REPO_TOKEN) await initCoveralls(job);

    const init = () => debug('Executing pipeline for job #%g', job.id);
    const routine = tasks.reduce(applyTask, Promise.resolve().then(init));
    return routine
        .then(updateJob)
        .catch(handleError)
        .finally(() => logDump.close());

    /**
     * Build task pipeline.  Should recursively call functions to produce chain of spawn callbacks.
     * Must return promises.
     * @param {Promise} pipeline - The promise chain to add to
     * @param {String} task - The script
     * @param {Number} idx - The current index in the pipeline
     * @param {Array} taskList - An array of functions or scripts to execute consecutively
     * @returns {Promise} - The job routine with `task` added to it.
     */
    function applyTask(pipeline, task, idx, taskList) {
        return pipeline.then(() => {
            debug('Starting task "%s" (%i/%i)', task, idx + 1, taskList.length);
            const timer = startJobTimer(job, config.kill_children === true);
            task = fullpath(task);  // Ensure absolute path
            return new Promise(function (resolve, reject) {
                // Spawn a process to execute our task
                const child = cp.spawn(task, [sha, repoPath, config.dataPath], ops);
                let stdout = '', stderr = '';
                // Pipe output to log file
                child.stdout.pipe(logDump, {end: false});
                child.stderr.pipe(logDump, {end: false});
                // Keep output around for reporting errors
                child.stdout.on('data', chunk => {
                    stdout += chunk;
                });
                child.stderr.on('data', chunk => {
                    stderr += chunk;
                });
                // error emitted called when spawn itself fails, or process could not be killed
                child.on('error', err => {
                    debug('clearing job timer');
                    clearTimeout(timer);
                    reject(err);
                })
                    .on('exit', () => {
                        debug('clearing job timer');
                        clearTimeout(timer);
                    })
                    .on('close', (code, signal) => {
                        const callback = (code === 0) ? resolve : reject;
                        const proc = {
                            code: code,
                            signal: signal,
                            stdout: stdout,
                            stderr: stderr,
                            process: child
                        };
                        callback(proc);
                    });
                job.child = child;  // Assign the child process to the job
            });
        });
    }

    /**
     * Handle any errors raised during the job routine.  If any process exits with a non-zero code
     * this handler will divine the error, update the record and trigger the relevant job callbacks.
     * @param {Object} errored - The stdout, stderr, ChildProcess, exit code and signal,
     * or a childProcess Error object.
     */
    function handleError(errored) {
        let message;  // Error message to pass to job callbacks and to save into records
        // The script that threw the error
        const file = (errored instanceof Error) ? errored.path : errored.process.spawnfile;

        // Check if the error is a spawn error, this is thrown when spawn itself fails, i.e. due to
        // missing shell script
        if (errored instanceof Error) {
            if (errored.code === 'ENOENT') {
                // Note the missing file (not necessarily the task script that's missing)
                message = file ? `File "${file}" not found` : 'No such file or directory';
            } else {
                message = `${errored.code} - Failed to spawn ${file}`;
            }
            // Check if the process was killed (we'll assume by the test timeout callback)
        } else if (errored.process.killed || errored.signal === 'SIGTERM') {
            message = `Tests stalled after ~${(config.timeout / 60000).toFixed(0)} min`;
        } else {  // Error raised by process; dig through stdout for reason
            debug('error from test function %s', file);
            // Isolate error from log
            // For MATLAB return the line that begins with 'Error'
            let fn = (str) => {
                return str.startsWith('Error in \'');
            };
            message = errored.stderr.split(/\r?\n/).filter(fn).join(';');
            // For Python, cat from the lost line that doesn't begin with whitespace
            if (!message && errored.stderr.includes('Traceback ')) {
                let errArr = errored.stderr.split(/\r?\n/);
                let idx = errArr.reverse().findIndex(v => {
                    return v.match('^\\S');
                });
                message = errored.stderr.split(/\r?\n/).slice(-idx - 1).join(';');
            }
            // Check for flake8 errors, capture first (NB: flake8 sends output to stdout, not stderr)
            if (!message && errored.stdout.match(/:\d+:\d+: [EWF]\d{3}/)) {
                let errArr = errored.stdout.split(/\r?\n/);
                let err = errArr.filter(v => {
                    return v.match(/[EWF]\d{3}/);
                });
                message = `${err.length} flake8 error${err.length === 1 ? '' : 's'}... ${err[0]}`;
            }
            // Otherwise simply use the full stderr (will be truncated)
            if (!message) message = errored.stderr;
        }
        // Save error into records for future reference.
        let report = {
            'commit': sha,
            'results': message,
            'status': 'error',
            'description': 'Error running ' + (file || 'test routine')
        };
        saveTestRecords(report).then(() => {
            debug('updated test records');
        });
        job.done(new Error(message));  // Propagate
    }

    /**
     * Update the job and mark complete.  Called when job routine completes without error.
     * @param {Object} proc - The stdout, stderr, ChildProcess, exit code and signal
     */
    async function updateJob(proc) {
        debug('Job routine complete');
        // Attempt to update the job data from the JSON records, throw error if this fails
        if (!await updateJobFromRecord(job)) {
            job.done(new Error('Failed to return test result'));
        } else {
            job.done(); // All good
        }
    }
}


/**
 * Function to update the coverage of a job by parsing the XML file.
 * @param {Object} job - Job object which has finished being processed.
 */
function computeCoverage(job) {
    if (typeof job.data.coverage !== 'undefined' && job.data.coverage) {
        console.log('Coverage already computed for job #' + job.id);
        return;
    }
    console.log('Updating coverage for job #' + job.id);
    const xmlPath = path.join(config.dataPath, 'reports', job.data.sha, 'CoverageResults.xml');
    const modules = listSubmodules(process.env.REPO_PATH);
    return Coverage(xmlPath, job.data.repo, job.data.sha, modules).then(obj => {
        // Digest and save percentage coverage
        let misses = 0, hits = 0;
        for (let file of obj.source_files) {
            misses += file.coverage.filter(x => x === 0).length;
            hits += file.coverage.filter(x => x > 0).length;
        }
        const coverage = hits / (hits + misses) * 100;  // As percentage
        job.data.coverage = coverage;  // Add to job
        // Load data and save  TODO Move to saveTestRecord(s) function in lib
        let records = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
        records = ensureArray(records); // Ensure array
        for (let o of records) {
            if (o.commit === job.data.sha) {
                o.coverage = coverage;
                break;
            }
        }
        // Save object
        return fs.promises.writeFile(config.dbFile, JSON.stringify(records)).then(() => {
            console.log('Coverage saved into records');
            // If this test was to ascertain coverage, call comparison function
            let toCompare = (job.data.context || '').startsWith('coverage') && job.data.base;
            if (toCompare) return compareCoverage(job);
        });
    }).catch(err => {
        job.status = 'error';
        job.description = 'Failed to compute coverage from XML';  // Add error msg
        console.error(err);
    });
}


/**
 * Compare coverage of two commits and post a failed status if coverage of head commit <= base commit.
 * @param {Object} job - Job object which has finished being processed.
 * @todo Add support for forked PRs
 */
function compareCoverage(job) {
    let log = _log.extend('compareCoverage');
    if (!(job.data.sha && job.data.base)) {
        throw new ReferenceError('No sha (head) or base commit in job data');
    }
    log('Comparing coverage for %g -> %g', job.data.sha, job.data.base);
    var records;
    if (!job.data.coverage) {
        log('No coverage in job data; loading from records');
        records = loadTestRecords([job.data.sha, job.data.base]);
        // Filter duplicates just in case
        records = records.filter((set => o => !set.has(o.commit) && set.add(o.commit))(new Set));
    } else {
        let curr = JSON.parse(JSON.stringify(job.data));  // Make a copy
        curr.commit = curr.sha;  // rename field
        records = [curr, loadTestRecords(job.data.base)];
    }
    // log('The following records were found: %O', records);
    const hasCoverage = records.every(o => (o.coverage > 0));

    // Check if any errored or failed to update coverage
    if (records.filter(o => o.status === 'error').length > 0) {
        log('One or more have error status; cannot compare coverage');
        job.data.status = 'failure';
        let which = records[0].status === 'error' ? 'HEAD' : 'BASE';  // Which branch is failing?
        job.data.description = `Failed to determine coverage as tests incomplete on ${which} due to errors`;

        // Both records present and they have coverage
    } else if (records.length === 2 && hasCoverage) {
        log('Calculating coverage difference');
        // Ensure first record is for head commit
        if (records[0].commit === job.data.base) records.reverse();
        // Calculate coverage change
        let delta = records[0].coverage - records[1].coverage;
        let passed = config.strict_coverage ? delta > 0 : delta >= 0;
        job.data.status = (passed ? 'success' : 'failure');
        if (delta === 0) {
            job.data.description = `Coverage remains at ${Math.round(records[1].coverage * 100) / 100}%`;
        } else {
            job.data.description = `Coverage ${passed ? 'increased' : 'decreased'} `;
            let previous = Math.round(records[1].coverage * 100) / 100;
            let current = Math.round(records[0].coverage * 100) / 100;
            job.data.description += (current === previous? 'slightly' : `from ${previous}% to ${current}%`);
        }

    } else { // We need to add a new job for incomplete coverage
        log('Missing record for base commit; adding new jobs');
        // TODO This could be refactored for efficiency
        // Ensure we have coverage for base branch
        queue.add({
            skipPost: true, // don't post, to be left for next job
            force: false,  // should skip if coverage already saved
            sha: job.data.base,
            owner: process.env.REPO_OWNER,
            repo: job.data.repo
        });
        // Ensure we have coverage for head commit and post result
        queue.add({
            skipPost: false, // don't post, to be left for next job
            force: false,  // should skip if coverage already saved
            sha: job.data.sha,
            base: job.data.base,
            owner: process.env.REPO_OWNER,
            repo: job.data.repo,
            context: job.data.context  // conserve context
        });
        // Skip our current job as we're waiting for base coverage
        job.data.skipPost = true;
    }
}


/**
 * Get the coverage results and build status data for the shields.io coverage badge API.
 * If test results don't exist, a new job is added to the queue and the message is set to 'pending'
 * @param {Object} data - An object with the keys 'sha', 'repo', 'owner' and 'context'.
 * 'context' must be 'coverage', 'build', or 'tests'.
 */
function getBadgeData(data) {
    let id = data.sha;
    if (!id) throw new ReferenceError('Invalid "sha" field in input data');
    const report = {'schemaVersion': 1, 'label': data.context};
    // Try to load coverage record
    let record = data.force ? [] : loadTestRecords(id);
    // If no record found
    if (record.length === 0) {
        report['message'] = data.context === 'tests'? 'in progress' : 'pending';
        report['color'] = 'orange';
        // Check test isn't already on the pile
        let onPile = false;
        for (let job of queue.pile) {
            if (job.data.sha === id) {
                onPile = true;
                break;
            }
        }
        if (!onPile) { // Add test to queue
            data['skipPost'] = true;
            queue.add(data);
        }
    } else {
        record = Array.isArray(record) ? record.pop() : record;  // in case of duplicates, take last
        switch (data.context) {
            case 'build':
                if (record['status'] === 'error') {
                    report['message'] = 'errored';
                    report['color'] = 'red';
                } else {
                    report['message'] = (record['status'] === 'success' ? 'passing' : 'failing');
                    report['color'] = (record['status'] === 'success' ? 'brightgreen' : 'red');
                }
                break;
            case 'tests':
                if (record['status'] === 'error') {
                    report['message'] = 'errored';
                    report['color'] = 'red';
                } else {
                    if (record['statistics']) {
                        let pass = record['statistics']['passed'];
                        let fail = record['statistics']['failed'] + record['statistics']['errored'];
                        let skip = record['statistics']['skipped'];
                        report['message'] = `${pass} passed`;
                        if (fail > 0) {
                            report['message'] += `, ${fail} failed`;
                        }
                        if (skip > 0) {
                            report['message'] += `, ${skip} skipped`;
                        }
                    } else {
                        report['message'] = (record['status'] === 'success' ? 'passed' : 'failed');
                    }
                    report['color'] = (record['status'] === 'success' ? 'brightgreen' : 'red');
                }

                break;
            case 'coverage':
                if (record['status'] === 'error' || !record['coverage']) {
                    report['message'] = 'unknown';
                    report['color'] = 'orange';
                } else {
                    report['message'] = Math.round(record['coverage'] * 100) / 100 + '%';
                    report['color'] = (record['coverage'] > 75 ? 'brightgreen' : 'red');
                }
                break;
            default:
                if (!data['context']) {
                    throw new ReferenceError('Context required for badge request');
                } else {
                    throw new TypeError('Unsupported context badge request');
                }
        }
    }
    return report;
}


class APIError extends Error {
    //...
}

module.exports = {
    ensureArray, loadTestRecords, compareCoverage, computeCoverage, getBadgeData, log, shortID,
    openTunnel, APIError, queue, partial, startJobTimer, updateJobFromRecord, shortCircuit, isSHA,
    fullpath, strToBool, saveTestRecords, listSubmodules, getRepoPath, addParam, context2routine,
    buildRoutine
};
