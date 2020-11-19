/**
 * A module containing helper and callback functions for continuous integration.
 */
const localtunnel = require('localtunnel');
const config = require('./config/config').settings
const Coverage = require('./coverage');
const queue = new (require('./queue.js'))()  // The queue object for our app to use
const fs = require('fs')


/**
 * Util wraps input in array if not already one
 * @param {Object} x - Input to ensure as array.
 * @returns {Array} x as an array.
 */
function ensureArray(x) { return (Array.isArray(x))? x : [x]; }


/**
 * Load test results from .db.json file.  NB: Size and order of returned records not guaranteed
 * @param {string, array} id - Function to call with job and done callback when.
 */
function loadTestRecords(id) {
  // FIXME Check file exists, catch JSON parse error
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
 * @todo WIP
 */
function saveTestRecords(r) {
   const byID = (a, b) => b.commit.localeCompare(a.commit);
   r = ensureArray(r).sort(byID);
   if (!r.every(x => 'commit' in x)) {
      throw new APIError('"commit" not in record(s)')
   }
   return fs.readFile(config.dbFile, 'utf8', function(err, data) {
      var obj;
      if (err && err.code === 'ENOENT') {
         console.log(`Records file not found at ${config.dbFile}`);
         obj = [];
      } else {
         obj = ensureArray(JSON.parse(data));
         let ids = r.map(x => x.commit);
         let records = obj.filter(o => ids.indexOf(o.commit) >= 0);
         // Update existing records
         for (let old of records) {
            let o = r.filter(x => x.id === old.commit);
            if (o.length > 0) {
               Object.assign(old, o.pop());
            }
         }
         let updated = records.map(x => x.commit);
         r = r.filter(x => updated.indexOf(x.commit) === -1);
      }
      // Add new records
      obj = obj.concat(r);
      return fs.writeFile(config.dbFile, JSON.stringify(obj));
   })
}


/**
 * Updates a job's data from saved test records.
 * @param {Object} job - Job object which is being processed.
 * @returns {boolean} - true if record was found
 */
function updateJobFromRecord(job) {
    let rec = loadTestRecords(job.data['sha']);  // Load test result from json log
    if (rec.length === 0) { return false; }      // No record found
    rec = Array.isArray(rec) ? rec.pop() : rec;  // in case of duplicates, take last
    job.data['status'] = rec['status'];
    job.data['description'] = rec['description'];
    job.data['coverage'] = ('coverage' in rec)? rec['coverage'] : null;
    if (!job.data['coverage']) {
       computeCoverage(job);  // Attempt to load from XML
    } else if ((job.data.context || '').startsWith('coverage')) {
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
 * Check if job already has record, if so, update from record and finish, otherwise call tests function.
 * @param {Function} func - The tests function to run, e.g. `runTestsMATLAB` or `runTestsPython`.
 * @param {Object} job - Job object which is being processed.
 * @param {Function} done - Callback on complete.
 */
function shortCircuit(func, job, done) {
   // job.data contains the custom data passed when the job was created
   // job.id contains id of this job.

   // To avoid running our tests twice, set the force flag to false for any other jobs in pile that
   // have the same commit ID
   let sha = job.data.sha;
   let others = queue.pile.filter(o => (o.data.sha === sha) && (o.id !== job.id));
   for (let other of others) { other.data.force = false }
   // If lazy, load records to check whether we already have the results saved
   if (job.data.force === false) {  // NB: Strict equality; force by default
      const updated = updateJobFromRecord(job)
      if (updated) { return done(); }  // No need to run tests; skip to complete routine
   }

   // Go ahead and prepare to run tests
   return func(job, done);
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
 * Updates the status of a Github check, given an object of data from a Job.
 * @param {Object} job - The Job to be updated upon timeout.
 * @param {ChildProcess} childProcess - The process to kill upon timeout.  The process should
 * cancel the returned timer in its callback.
 * @param {Function} done - Callback on complete (optional).
 * @returns {number} - A timeout object.
 */
function startJobTimer(job, childProcess, done=null) {
   const timeout = config.timeout || 8*60000;  // How long to wait for the tests to run
   return setTimeout(() => {
      console.log('Max test time exceeded');
      job.data['status'] = 'error';
      job.data['description'] = `Tests stalled after ~${(timeout / 60000).toFixed(0)} min`;
      childProcess.kill();
      if (done !== null) { done(new Error('Job stalled')); }
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
  let xmlPath = path.join(config.dataPath, 'reports', job.data.sha, 'CoverageResults.xml')
  Coverage(xmlPath, job.data.repo, job.data.sha, obj => {
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
    if ((job.data.context || '').startsWith('coverage')) { compareCoverage(job); }
    });
  });
}


/**
 * Compare coverage of two commits and post a failed status if coverage of head commit <= base commit.
 * @param {Object} job - Job object which has finished being processed.
 * @todo Add support for forked PRs
 */
function compareCoverage(job) {
  var records;
  if (!job.coverage) {
    records = loadTestRecords([job.sha, job.data.base]);
    // Filter duplicates just in case
    records = records.filter((set => o => !set.has(o.commit) && set.add(o.commit))(new Set));
  } else {
    let curr = JSON.parse(JSON.stringify( job.data ));  // Make a copy
    curr.commit = curr.sha;  // rename field
    records = [curr, loadTestRecords(job.data.base)];
  }
  const has_coverage = records.every(o => (typeof o.coverage !== 'undefined' && o.coverage > 0));

  // Check if any errored or failed to update coverage
  if (records.filter(o => o.status === 'error').length > 0) {
    job.data.status = 'failure';
    job.data.description = 'Failed to determine coverage as tests incomplete due to errors';

  // Both records present and they have coverage
  } else if (records.length === 2 && has_coverage) {
    // Ensure first record is for head commit
    if (records[0].commit === job.data.base) { records.reverse() }
    // Calculate coverage change
    let coverage = records[0].coverage - records[1].coverage;
    job.data.status = (coverage > 0 ? 'success' : 'failure');
    job.data.description = `Coverage ${coverage > 0 ? 'increased' : 'decreased'} ` +
                           `from ${Math.round(records[1].coverage * 100) / 100}% ` +
                           `to ${Math.round(records[0].coverage * 100) / 100}%`

  } else { // We need to add a new job for incomplete coverage
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
 * 'context' must be 'coverage' or 'status'.
 */
function getBadgeData(data) {
   let id = data.sha;
   if (!id) {
      throw new ReferenceError('Invalid "sha" field in input data')
   }
   var report = {'schemaVersion': 1, 'label': data.context === 'status'? 'build' : 'coverage'};
   // Try to load coverage record
   let record = loadTestRecords(id);
   // If no record found
   if (record.length === 0) {
      report['message'] = 'pending';
      report['color'] = 'orange';
      // Check test isn't already on the pile
      let onPile = false;
      for (let job of queue.pile) { if (job.id === id) { onPile = true; break; } }
      if (!onPile) { // Add test to queue
         data['skipPost'] = true
         queue.add(data);
      }
   } else {
      record = Array.isArray(record) ? record.pop() : record;  // in case of duplicates, take last
      switch (data.context) {
         case 'status':
            if (record['status'] === 'error' || !record['coverage']) {
               report['message'] = 'unknown';
               report['color'] = 'orange';
            } else {
               report['message'] = (record['status'] === 'success' ? 'passing' : 'failing');
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
   ensureArray, loadTestRecords, compareCoverage, computeCoverage, getBadgeData,
   openTunnel, APIError, queue, partial, startJobTimer, updateJobFromRecord, shortCircuit
}
