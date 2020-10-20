/**
 * @author Miles Wells <miles.wells@ucl.ac.uk>
 * @requires ./queue.js
 * @requires ./coverage.js
 * @requires module:dotenv
 * @requires module:"@octokit/app"
 * @requires module:"@octokit/request"
 * @requires module:express
 * @requires module:localtunnel
 * @requires module:github-webhook-handler
 */
const fs = require('fs');
const express = require('express')
const srv = express();
const cp = require('child_process');
const queue = new (require('./queue.js'))()
const Coverage = require('./coverage');
const { App } = require('@octokit/app');
const { request } = require("@octokit/request");
const localtunnel = require('localtunnel');

const id = process.env.GITHUB_APP_IDENTIFIER;
const secret = process.env.GITHUB_WEBHOOK_SECRET;

// Configure a secure tunnel
const openTunnel = async () => {
  let args = {
    port: 3000,
 	 subdomain: process.env.TUNNEL_SUBDOMAIN,
	 host: process.env.TUNNEL_HOST
  };
  const tunnel = await localtunnel(args);
  console.log(`Tunnel open on: ${tunnel.url}`);
  tunnel.on('close', () => {console.log('Reconnecting'); openTunnel(); });
  tunnel.on('error', (e) => { console.error(e) });
}

// Create handler to verify posts signed with webhook secret.  Content type must be application/json
var createHandler = require('github-webhook-handler');
var handler = createHandler({ path: '/github', secret: process.env.GITHUB_WEBHOOK_SECRET });
var installationAccessToken;

const app = new App({
    id: process.env.GITHUB_APP_IDENTIFIER,
    privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY),
    webhooks: {secret}
});
// Authenticate app by exchanging signed JWT for access token
var token = app.getSignedJsonWebToken();

/**
 * Callback to deal with POST requests to /github endpoint
 * @param {Object} req - Request object.
 * @param {Object} res - Response object.
 * @param {Function} next - Handle to next callback in stack.
 */
srv.post('/github', async (req, res, next) => {
    console.log('Post received')
    try {
        token = await app.getSignedJsonWebToken();
        //getPayloadRequest(req) GET /orgs/:org/installation
        const { data } = await request("GET /repos/:owner/:repo/installation", {
            owner: process.env.REPO_OWNER,
            repo: process.env.REPO_NAME,
            headers: {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.github.machine-man-preview+json"
            }
        });
        // contains the installation id necessary to authenticate as an installation
        const installationId = data.id;
        installationAccessToken = await app.getInstallationAccessToken({ installationId });
        handler(req, res, () => res.end('ok'))
        //next();
    } catch (error) {
    next(error);
    }
});

/**
 * Load MATLAB test results from db.json file.
 * @param {string, array} id - Function to call with job and done callback when.
 */
function loadTestRecords(id) {
  let obj = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  if (!Array.isArray(obj)) obj = [obj]; // Ensure array
  let records = obj.filter(o => id.includes(o.commit));
  // If single arg return as object, otherwise keep as array
  return (!Array.isArray(id) && records.length === 1 ? records[0] : records)
}

/**
 * Compare coverage of two commits and post a failed status if coverage of head commit <= base commit.
 * @param {object} data - job data object with coverage field holding head and base commit ids.
 */
function compareCoverage(data) {
  let ids = data.coverage;
  let status, description;
  let records = loadTestRecords(Object.values(ids));
  // Filter duplicates just in case
  records = records.filter((set => o => !set.has(o.commit) && set.add(o.commit))(new Set));
  has_coverage = records.every(o => (typeof o.coverage !== 'undefined' && o.coverage > 0));
  // Check if any errored or failed to update coverage
  if (records.filter(o => o.status === 'error').length > 0) {
    status = 'failure';
    description = 'Failed to determine coverage as tests incomplete due to errors';
  } else if (records.length === 2 && has_coverage) {
    // Ensure first record is for head commit
    if (records[0].commit === ids.base) { records.reverse() }
    // Calculate coverage change
    let coverage = records[0].coverage - records[1].coverage;
    status = (coverage > 0 ? 'success' : 'failure');
    description = 'Coverage ' + (coverage > 0 ? 'increased' : 'decreased')
                              + ' from ' + Math.round(records[1].coverage*100)/100 + '%'
                              + ' to ' + Math.round(records[0].coverage*100)/100 + '%';
  } else {
    for (let commit in ids) {
       // Check test isn't already on the pile
       let job = queue.pile.filter(o => o.data.sha === ids[commit]);
       if (job.length > 0) { // Already on pile
          // Add coverage key to job data structure
          if (typeof job[0].data.coverage === 'undefined') { job[0].data.coverage = ids; }
       } else { // Add test to queue
          queue.add({
             skipPost: true,
             sha: ids[commit],
             owner: process.env.REPO_OWNER,
             repo: data.repo,
             status: '',
             context: '',
             coverage: ids // Note cf commit
          });
       }
    }
    return;
  }
  // Post a our coverage status
  request('POST /repos/:owner/:repo/statuses/:sha', {
          owner: process.env.REPO_OWNER,
          repo: data.repo,
          headers: {
              authorization: `token ${installationAccessToken}`,
              accept: 'application/vnd.github.machine-man-preview+json'
          },
          sha: ids.head,
          state: status,
          target_url: `${process.env.WEBHOOK_PROXY_URL}/events/${ids.head}`, // fail
          description: description,
          context: 'coverage/ZTEST'  // TODO Generalize
  });
}

// Serve the test results for requested commit id
srv.get('/github/:id', function (req, res) {
  console.log('Request for test log for commit ' + req.params.id.substring(0,6))
  let log = `.\\src\\matlab_tests-${req.params.id}.log`;
  fs.readFile(log, 'utf8', (err, data) => {
    if (err) {
    	res.statusCode = 404;
    	res.send(`Record for commit ${req.params.id} not found`);
    } else {
    	res.statusCode = 200;
    	preText = '<html lang="en-GB"><body><pre>';
    	postText = '</pre></body></html>';
      res.send(preText + data + postText);

    }
  });
  /*
  const record = loadTestRecords(req.params.id);
  if (typeof record == 'undefined') {
  	res.statusCode = 404;
  	res.send(`Record for commit ${req.params.id} not found`);
  } else {
  	res.send(record['results']);
  }
  */
});

// Serve the coverage results
srv.get('/coverage/:repo/:branch', async (req, res) => {
  // Find head commit of branch
  try {
    const { data } = await request('GET /repos/:owner/:repo/git/refs/heads/:branch', {
      owner: process.env.REPO_OWNER,
      repo: req.params.repo,
      branch: req.params.branch
    });
    if (data.ref.endsWith('/' + req.params.branch)) {
      console.log('Request for ' + req.params.branch + ' coverage')
      let id = data.object.sha;
      var report = {'schemaVersion': 1, 'label': 'coverage'};
      try { // Try to load coverage record
        record = await loadTestRecords(id);
        if (typeof record == 'undefined' || record['coverage'] == '') {throw 404} // Test not found for commit
        if (record['status'] === 'error') {throw 500} // Test found for commit but errored
        report['message'] = Math.round(record['coverage']*100)/100 + '%';
        report['color'] = (record['coverage'] > 75 ? 'brightgreen' : 'red');
      } catch (err) { // No coverage value
        report['message'] = (err === 404 ? 'pending' : 'unknown');
        report['color'] = 'orange';
        // Check test isn't already on the pile
        let onPile = false;
        for (let job of queue.pile) { if (job.id === id) { onPile = true; break; } }
        if (!onPile) { // Add test to queue
          queue.add({
            skipPost : true,
            sha: id,
            owner: process.env.REPO_OWNER,
            repo: req.params.repo,
            status: '',
            context: ''});
        }
      } finally { // Send report
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(report));}
    } else { throw 404 } // Specified repo or branch not found
  } catch (error) {
    let msg = (error === 404 ? `${req.params.repo}/${req.params.branch} not found` : error); // @fixme error thrown by request not 404
    console.error(msg)
    res.statusCode = 401; // If not found, send 401 for security reasons
    res.send(msg);
  }
});

// Serve the build status
srv.get('/status/:repo/:branch', async (req, res) => {
  // Find head commit of branch
  try {
    const { data } = await request('GET /repos/:owner/:repo/git/refs/heads/:branch', {
      owner: process.env.REPO_OWNER,
      repo: req.params.repo,
      branch: req.params.branch
    });
    if (data.ref.endsWith('/' + req.params.branch)) {
      console.log('Request for ' + req.params.branch + ' build status')
      let id = data.object.sha;
      var report = {'schemaVersion': 1, 'label': 'build'};
      try { // Try to load coverage record
        record = await loadTestRecords(id);
        if (typeof record == 'undefined' || record['status'] == '') {throw 404} // Test not found for commit
        report['message'] = (record['status'] === 'success' ? 'passing' : 'failing');
        report['color'] = (record['status'] === 'success' ? 'brightgreen' : 'red');
      } catch (err) { // No coverage value
        report['message'] = (err === 404 ? 'pending' : 'unknown');
        report['color'] = 'orange';
        // Check test isn't already on the pile
        let onPile = false;
        for (let job of queue.pile) { if (job.id === id) { onPile = true; break; } }
        if (!onPile) { // Add test to queue
          queue.add({
            skipPost: true,
            sha: id,
            owner: process.env.REPO_OWNER,
            repo: req.params.repo,
            status: '',
            context: ''});
        }
      } finally { // Send report
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(report));}
    } else { throw 404 } // Specified repo or branch not found
  } catch (error) {
    let msg = (error === 404 ? `${req.params.repo}/${req.params.branch} not found` : error); // @fixme error thrown by request not 404
    console.error(msg)
    res.statusCode = 401; // If not found, send 401 for security reasons
    res.send(msg);
  }
});

// Define how to process tests.  Here we checkout git and call MATLAB
queue.process(async (job, done) => {
  // job.data contains the custom data passed when the job was created
  // job.id contains id of this job.
  var sha = job.data['sha']; // Retrieve commit hash
  // If the repo is a submodule, modify path
  var path = process.env.REPO_PATH;
  if (job.data['repo'] === 'alyx-matlab' || job.data['repo'] === 'signals') {
    path = path + '\\' + job.data['repo'];}
  if (job.data['repo'] === 'alyx') { sha = 'dev' } // For Alyx checkout master
  // Checkout commit
  checkout = cp.execFile('checkout.bat ', [sha, path], (error, stdout, stderr) => {
     if (error) { // Send error status
       console.error('Checkout failed: ', stderr);
       job.data['status'] = 'error';
       job.data['context'] = 'Failed to checkout code: ' + stderr;
       done(error); // Propagate error
       return;
     }
     console.log(stdout)
     // Go ahead with MATLAB tests
     var runTests;
     const timer = setTimeout(function() {
      	  console.log('Max test time exceeded')
      	  job.data['status'] = 'error';
           job.data['context'] = 'Tests stalled after ~8 min';
           runTests.kill();
      	  done(new Error('Job stalled')) }, 8*60000);
     let args = ['-r', `runAllTests (""${job.data.sha}"",""${job.data.repo}"")`,
       '-wait', '-log', '-nosplash', '-logfile', `.\\src\\matlab_tests-${job.data.sha}.log`];
     runTests = cp.execFile('matlab', args, (error, stdout, stderr) => {
       clearTimeout(timer);
       if (error) { // Send error status
         // Isolate error from log
         let errStr = stderr.split(/\r?\n/).filter((str) =>
           {return str.startsWith('Error in \'')}).join(';');
         job.data['status'] = 'error';
         job.data['context'] = errStr;
         done(error); // Propagate
       } else {
         const rec = loadTestRecords(job.data['sha']); // Load test result from json log
         job.data['status'] = rec['status'];
         job.data['context'] = rec['description'];
         done();
       }
     });
  });
});

/**
 * Callback triggered when job finishes.  Called both on complete and error.
 * @param {Object} job - Job object which has finished being processed.
 */
queue.on('finish', job => { // On job end post result to API
  console.log(`Job ${job.id} complete`)
  // If job was part of coverage test and error'd, call compare function
  // (otherwise this is done by the on complete callback after writing coverage to file)
  if (typeof job.data.coverage !== 'undefined' && job.data['status'] == 'error') {
    compareCoverage(job.data);
  }
  if (job.data.skipPost === true) { return; }
  request("POST /repos/:owner/:repo/statuses/:sha", {
    owner: job.data['owner'],
    repo: job.data['repo'],
    headers: {
        authorization: `token ${installationAccessToken}`,
        accept: "application/vnd.github.machine-man-preview+json"},
    sha: job.data['sha'],
    state: job.data['status'],
    target_url: `${process.env.WEBHOOK_PROXY_URL}/github/${job.data.sha}`, // FIXME replace url
    description: job.data['context'],
    context: 'continuous-integration/ZTEST'
  });
});

/**
 * Callback triggered when job completes.  Called when all tests run to end.
 * @param {Object} job - Job object which has finished being processed.
 * @todo Save full coverage object for future inspection
 */
queue.on('complete', job => { // On job end post result to API
  console.log('Updating coverage for job #' + job.id)
  Coverage('./CoverageResults.xml', job.data.repo, job.data.sha, obj => {
    // Digest and save percentage coverage
    let misses = 0, hits = 0;
    for (let file of obj.source_files) {
      misses += file.coverage.filter(x => x === 0).length;
      hits += file.coverage.filter(x => x > 0).length;
    }
    // Load data and save
    let records = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
    if (!Array.isArray(records)) records = [records]; // Ensure array
    for (let o of records) { if (o.commit === job.data.sha) {o.coverage = hits / (hits + misses) * 100; break; }} // Add percentage
    // Save object
    fs.writeFile('./db.json', JSON.stringify(records), function(err) {
    if (err) { console.log(err); return; }
    // If this test was to ascertain coverage, call comparison function
    if (typeof job.data.coverage !== 'undefined') { compareCoverage(job.data); }
    });
  });
});

// Let fail silently: we report error via status
queue.on('error', err => {});
// Log handler errors
handler.on('error', function (err) {
  console.error('Error:', err.message)
})

// Handle push events
handler.on('push', async function (event) {
  // Log the event
  console.log('Received a push event for %s to %s',
    event.payload.repository.name,
    event.payload.ref)
  // Ignore documentation branches
  if (event.payload.ref.endsWith('documentation')) { return; }
  try { // Run tests for head commit only
    let head_commit = event.payload.head_commit.id;
    // Post a 'pending' status while we do our tests
    await request('POST /repos/:owner/:repo/statuses/:sha', {
            owner: process.env.REPO_OWNER,
            repo: event.payload.repository.name,
            headers: {
                authorization: `token ${installationAccessToken}`,
                accept: 'application/vnd.github.machine-man-preview+json'
            },
            sha: head_commit,
            state: 'pending',
            target_url: `${process.env.WEBHOOK_PROXY_URL}/events/${head_commit}`, // fail
            description: 'Tests running',
            context: 'continuous-integration/ZTEST'
    });
    // Add a new test job to the queue
    queue.add({
        sha: head_commit,
        owner: process.env.REPO_OWNER,
        repo: event.payload.repository.name,
        status: '',
        context: ''
    });
  } catch (error) {console.log(error)}
});

// Handle pull request events
// Here we'll update coverage
handler.on('pull_request', async function (event) {
  // Ignore documentation branches
  if (event.payload.pull_request.head.ref === 'documentation') { return; }
  // Log the event
  console.log('Received a pull_request event for %s to %s',
    event.payload.pull_request.head.repo.name,
    event.payload.pull_request.head.ref)
  if (!event.payload.action.endsWith('opened') && event.payload.action !== 'synchronize') { return; }
  try { // Compare test coverage
    let head_commit = event.payload.pull_request.head.sha;
    let base_commit = event.payload.pull_request.base.sha;
    if (false) { // TODO for alyx only
      // Post a 'pending' status while we do our tests
      await request('POST /repos/:owner/:repo/statuses/:sha', {
          owner: process.env.REPO_OWNER,
          repo: event.payload.repository.name,
          headers: {
              authorization: `token ${installationAccessToken}`,
              accept: 'application/vnd.github.machine-man-preview+json'
          },
          sha: head_commit,
          state: 'pending',
          target_url: `${process.env.WEBHOOK_PROXY_URL}/events/${head_commit}`, // fail
          description: 'Tests running',
          context: 'continuous-integration/ZTEST'
      });
    }

    // Post a 'pending' status while we do our tests
    request('POST /repos/:owner/:repo/statuses/:sha', {
          owner: process.env.REPO_OWNER,
          repo: event.payload.repository.name,
          headers: {
              authorization: `token ${installationAccessToken}`,
              accept: 'application/vnd.github.machine-man-preview+json'
          },
          sha: head_commit,
          state: 'pending',
          target_url: `${process.env.WEBHOOK_PROXY_URL}/events/${head_commit}`, // fail
          description: 'Checking coverage',
          context: 'coverage/ZTEST'
    });
    // Check coverage exists
    let data = {
      repo: event.payload.repository.name,
      coverage: {head: head_commit, base: base_commit}
    };
    compareCoverage(data);
  } catch (error) {console.log(error)}
});

// Start the server in the port 3000
var server = srv.listen(3000, function () {
   var host = server.address().address
   var port = server.address().port

   console.log("Handler listening at http://%s:%s", host, port)
});

// Start tunnel
openTunnel();

// Log any unhandled errors
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  console.log(reason.stack)
});
