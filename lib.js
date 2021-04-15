/**
 * A module containing helper and callback functions for continuous integration.
 */
const fs = require('fs');
const path = require('path');

const createDebug  = require('debug');
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
function shortID(v, len=7) {
   if (Array.isArray(v)) { return v.map(v => shortID(v, len)); }
   if (Number.isInteger(v)) { v = v.toString(); }
   if (typeof v === 'string' || v instanceof String) { v = v.substr(0, len); }
   return v;  // If not string, array or number, leave unchanged
}

// Attach shortID function to logger formatter
createDebug.formatters.g = shortID
const log = createDebug('ci');
const _log = log.extend('lib');


/**
 * Test commit has is valid.  Assumes hash is at least 7 characters long.
 * @param {String} id - String under test.
 * @returns {boolean} true if id is a valid SHA
 */
function isSHA(id) {
   const regex = /^[0-9a-f]{7,40}$/i;
   return (typeof id === 'string' || id instanceof String) && id.match(regex) !== null
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
function ensureArray(x) { return (Array.isArray(x))? x : [x]; }

/**
 * Will match one and only one of the string 'true','1', or 'on' regardless of capitalization and
 * regardless of surrounding white-space.  (Thx to shrewmouse).
 * @param {string} s - String to test
 * @returns {boolean} s as bool
 */
function strToBool(s) { return /^\s*(true|1|on)\s*$/i.test(s); }


/**
 * Get the routine for a given context from the settings JSON.
 * @param {String} context - The context.
 * @returns {Array} The test routine, i.e. an array of functions/scripts to call
 */
function context2routine(context) {
   const opts = ('routines' in config)? config['routines'] : null;
   if (!opts) { return null; }
   let routine = ('*' in opts)? opts['*'] : [];
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
  if (!id) { throw new TypeError('invalid id'); }
  if(!fs.existsSync(config.dbFile)) {
    console.log('Records file not found');
    return []
  }
  let obj = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
  obj = ensureArray(obj);
  let records = obj.filter(o => id.includes(o.commit));
  // If single arg return as object, otherwise keep as array
  return (!Array.isArray(id) && records.length === 1 ? records[0] : records)
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
         let o = r.filter(x => x.commit === old.commit );
         if (o.length > 0) {
            Object.assign(old, o.pop());
         }
      }
      let updated = records.map(x => x.commit);
      r = r.filter(x => updated.indexOf(x.commit) === -1);
   } catch (err) {
      if (err && err.code === 'ENOENT') {
         console.log(`Records file not found at ${config.dbFile}`);
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
function updateJobFromRecord(job) {
    let log = _log.extend('updateJobFromRecord');
    log('Loading test records for head commit %g', job.data['sha']);
    let rec = loadTestRecords(job.data['sha']);  // Load test result from json log
    if (rec.length === 0) {
       log('No record found, return false');
       return false;
    }      // No record found
    rec = Array.isArray(rec) ? rec.pop() : rec;  // in case of duplicates, take last
    job.data['status'] = rec['status'];
    job.data['description'] = rec['description'];
    job.data['coverage'] = ('coverage' in rec)? rec['coverage'] : null;
    if (!job.data['coverage'] && rec['status'] !== 'error') {
       log('Coverage missing, computing from XML');
       computeCoverage(job);  // Attempt to load from XML
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
         return function(...args2) {
            return curried.apply(this, args.concat(args2));
         }
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
      url += '/'
   }
   for (param of args) {
      url += (/\?/g.test(url)? '&' : '?') + param;
   }
   return url
}


/**
 * Check if job already has record, if so, update from record and finish, otherwise call tests function.
 * @param {Object} job - Job object which is being processed.
 * @param {Function} func - The tests function to run, e.g. `buildRoutine`.
 */
function shortCircuit(job, func=null) {
   // job.data contains the custom data passed when the job was created
   // job.id contains id of this job.
   let log = _log.extend('shortCircuit');
   log('Checking whether to load from saved for %s @ %g',
      (job.data.context || '').split('/').pop(), job.data.sha);

   // To avoid running our tests twice, set the force flag to false for any other jobs in pile that
   // have the same commit ID
   let sha = job.data.sha;
   let others = queue.pile.filter(o => (o.data.sha === sha) && (o.id !== job.id));
   for (let other of others) { other.data.force = false }
   // If lazy, load records to check whether we already have the results saved
   if (job.data.force === false) {  // NB: Strict equality; force by default
      _log('Updating job data directly from record for job #%g', job.id);
      if (updateJobFromRecord(job)) { return job.done(); }  // No need to run tests; skip to complete routine
   }

   // Go ahead and prepare to run tests
   if (func) { return func(job); }
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
  tunnel.on('close', () => {console.log('Reconnecting'); openTunnel(); });
  tunnel.on('error', (e) => { console.error(e) });
  return tunnel;
}


/**
 * Lists the submodules within a Git repository.  If none are found null is returned.
 * @param {String} repoPath - The path of the repository
 * @returns {Array} A list of submodule names, or null if none were found
 */
function listSubmodules(repoPath) {
   if (!shell.which('git')) { throw new Error('Git not found on path'); }
   shell.pushd(repoPath);
   let listModules = 'git config --file .gitmodules --get-regexp path';
   const modules = shell.exec(listModules)
   shell.popd();
   return (!modules.code && modules.stdout !== '')? modules.match(/(?<=submodule.)[\w-]+/g) : [];
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
   if (!config.repos) { return process.env['REPO_PATH']; }  // Legacy, to remove
   if (config.repos[name]) { return config.repos[name]; }  // Found path, return
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
function startJobTimer(job, kill_children=false) {
   const timeout = config.timeout || 8*60000;  // How long to wait for the tests to run
   return setTimeout(() => {
      console.log('Max test time exceeded');
      log(kill_children? 'Killing all processes' : 'Ending test process');
      let pid = job._child.pid;
      job._child.kill();
      if (kill_children) { kill(pid); }
   }, timeout);
}


/**
 * Function to update the coverage of a job by parsing the XML file.
 * @param {Object} job - Job object which has finished being processed.
 */
function computeCoverage(job) {
  if (typeof job.data.coverage !== 'undefined' && job.data.coverage) {
    console.log('Coverage already computed for job #' + job.id)
    return;
  }
  console.log('Updating coverage for job #' + job.id)
  const xmlPath = path.join(config.dataPath, 'reports', job.data.sha, 'CoverageResults.xml')
  const modules = listSubmodules(process.env.REPO_PATH);
  Coverage(xmlPath, job.data.repo, job.data.sha, modules, obj => {
    // Digest and save percentage coverage
    let misses = 0, hits = 0;
    for (let file of obj.source_files) {
      misses += file.coverage.filter(x => x === 0).length;
      hits += file.coverage.filter(x => x > 0).length;
    }
    const coverage = hits / (hits + misses) * 100  // As percentage
    job.data.coverage = coverage;  // Add to job
    // Load data and save  TODO Move to saveTestRecord(s) function in lib
    let records = JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
    records = ensureArray(records); // Ensure array
    for (let o of records) { if (o.commit === job.data.sha) { o.coverage = coverage; break; }}
    // Save object
    fs.writeFile(config.dbFile, JSON.stringify(records), function(err) {
    if (err) {
      job.status = 'error'
      job.description = 'Failed to compute coverage from XML'
      console.log(err);
      return;
    }
    // If this test was to ascertain coverage, call comparison function
    let toCompare = (job.data.context || '').startsWith('coverage') && job.data.base;
    if (toCompare) { compareCoverage(job); }
    });
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
    let curr = JSON.parse(JSON.stringify( job.data ));  // Make a copy
    curr.commit = curr.sha;  // rename field
    records = [curr, loadTestRecords(job.data.base)];
  }
  log('The following records were found: %O', records);
  const hasCoverage = records.every(o => (o.coverage > 0));

  // Check if any errored or failed to update coverage
  if (records.filter(o => o.status === 'error').length > 0) {
    log('One or more have error status; cannot compare coverage');
    job.data.status = 'failure';
    job.data.description = 'Failed to determine coverage as tests incomplete due to errors';

  // Both records present and they have coverage
  } else if (records.length === 2 && hasCoverage) {
    log('Calculating coverage difference');
    // Ensure first record is for head commit
    if (records[0].commit === job.data.base) { records.reverse() }
    // Calculate coverage change
    let delta = records[0].coverage - records[1].coverage;
    let passed = config.strict_coverage? delta > 0 : delta >= 0;
    job.data.status = (passed ? 'success' : 'failure');
    if (delta === 0) {
       job.data.description = `Coverage remains at ${Math.round(records[1].coverage * 100) / 100}%`;
    } else {
       job.data.description = `Coverage ${passed ? 'increased' : 'decreased'} ` +
                           `from ${Math.round(records[1].coverage * 100) / 100}% ` +
                           `to ${Math.round(records[0].coverage * 100) / 100}%`;
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
             repo: job.data.repo,
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
   if (!id) {
      throw new ReferenceError('Invalid "sha" field in input data')
   }
   var report = {'schemaVersion': 1, 'label': data.context};
   // Try to load coverage record
   let record = data.force? [] : loadTestRecords(id);
   // If no record found
   if (record.length === 0) {
      report['message'] = 'pending';
      report['color'] = 'orange';
      // Check test isn't already on the pile
      let onPile = false;
      for (let job of queue.pile) { if (job.data.sha === id) { onPile = true; break; } }
      if (!onPile) { // Add test to queue
         data['skipPost'] = true
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
                  if (fail > 0) { report['message'] += `, ${fail} failed`; }
                  if (skip > 0) { report['message'] += `, ${skip} skipped`; }
               } else {
                  report['message'] = (record['status'] === 'success' ? 'passed' : 'failed')
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
               throw new ReferenceError('Context required for badge request')
            } else {
               throw new TypeError('Unsupported context badge request')
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
   fullpath, strToBool, saveTestRecords, listSubmodules, getRepoPath, addParam, context2routine
}
