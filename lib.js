/**
 * A module containing helper and callback functions for continuous integration.
 */
const localtunnel = require('localtunnel');
const config = require('./config/config').settings
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

class APIError extends Error {
  //...
}

module.exports = { ensureArray, loadTestRecords, compareCoverage, openTunnel, APIError, queue }
