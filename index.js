/**
 * @author Miles Wells <miles.wells@ucl.ac.uk>
 * @requires ./queue.js
 * @requires ./coverage.js
 * @requires module:dotenv
 * @requires module:"@octokit/app"
 * @requires module:"@octokit/request"
 * @requires module:express
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

const id = process.env.GITHUB_APP_IDENTIFIER;
const secret = process.env.GITHUB_WEBHOOK_SECRET;

// Configure ssh tunnel
const cmd = 'ssh -tt -R gladius:80:localhost:3000 serveo.net';
const sh = String(cp.execFileSync('where', ['git'])).replace(/cmd\\git.exe\s*/gi, 'bin\\sh.exe');
const tunnel = () => {
  let ssh = cp.spawn(sh, ['-c', cmd])
  ssh.stdout.on('data', (data) => { console.log(`stdout: ${data}`); });
  ssh.on('exit', () => { console.log('Reconnecting to Serveo'); tunnel(); });
  ssh.on('error', (e) => { console.error(e) });
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
            owner: "cortex-lab",
            repo: "Rigbox",
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
 * @param {string} id - Function to call with job and done callback when.
 */
function loadTestRecords(id) {
  let obj = JSON.parse(fs.readFileSync('./db.json', 'utf8'));
  if (!Array.isArray(obj)) obj = [obj]; // Ensure array
  return obj.find(o => o.commit === id);
};

// Serve the test results for requested commit id
srv.get('/github/:id', function (req, res) {
  console.log('Request for test results for commit ' + req.params.id.substring(0,6))
  const record = loadTestRecords(req.params.id);
  if (typeof record == 'undefined') {
  	res.statusCode = 404;
  	res.send(`Record for commit ${req.params.id} not found`);
  } else {
  	res.send(record['results']);
  }
});

// Serve the coverage results
srv.get('/coverage/:repo/:branch', async (req, res) => {
  // Find head commit of branch
  try {
    const { data } = await request('GET /repos/:owner/:repo/git/refs/heads/:branch', {
      owner: 'cortex-lab', // @todo Generalize repo owner
      repo: req.params.repo,
      branch: req.params.branch
    });
    if (data.ref.endsWith('/' + req.params.branch)) {
      console.log('Request for ' + req.params.branch + ' coverage')
      let id = data.object.sha;
      var report = {'schemaVersion': 1, 'label': 'coverage'};
      try { // Try to load coverage record
        record = await loadTestRecords(id);
        if (typeof record == 'undefined' || record['coverage'] == '') {throw 404}; // Test not found for commit
        if (record['status'] === 'error') {throw 500}; // Test found for commit but errored
        report['message'] = Math.round(record['coverage']*100)/100 + '%';
        report['color'] = (record['coverage'] > 75 ? 'brightgreen' : 'red');
      } catch (err) { // No coverage value
        report['message'] = (err === 404 ? 'pending' : 'unknown');
        report['color'] = 'orange';
        // Check test isn't already on the pile
        let onPile = false;
        for (let job of queue.pile) { if (job.id === id) { onPile = true; break; } };
        if (!onPile) { // Add test to queue
          queue.add({
            skipPost : true,
            sha: id,
            owner: 'cortex-lab', // @todo Generalize repo owner
            repo: req.params.repo,
            status: '',
            context: ''});
        }
      } finally { // Send report
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(report));}
    } else { throw 404 }; // Specified repo or branch not found
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
      owner: 'cortex-lab', // @todo Generalize repo owner
      repo: req.params.repo,
      branch: req.params.branch
    });
    if (data.ref.endsWith('/' + req.params.branch)) {
      console.log('Request for ' + req.params.branch + ' build status')
      let id = data.object.sha;
      var report = {'schemaVersion': 1, 'label': 'build'};
      try { // Try to load coverage record
        record = await loadTestRecords(id);
        if (typeof record == 'undefined' || record['status'] == '') {throw 404}; // Test not found for commit
        report['message'] = (record['status'] === 'success' ? 'passing' : 'failing');
        report['color'] = (record['status'] === 'success' ? 'brightgreen' : 'red');
      } catch (err) { // No coverage value
        report['message'] = (err === 404 ? 'pending' : 'unknown');
        report['color'] = 'orange';
        // Check test isn't already on the pile
        let onPile = false;
        for (let job of queue.pile) { if (job.id === id) { onPile = true; break; } };
        if (!onPile) { // Add test to queue
          queue.add({
            skipPost: true,
            sha: id,
            owner: 'cortex-lab', // @todo Generalize repo owner
            repo: req.params.repo,
            status: '',
            context: ''});
        }
      } finally { // Send report
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(report));}
    } else { throw 404 }; // Specified repo or branch not found
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
  var path = process.env.RIGBOX_REPO_PATH;
  if (job.data['repo'] === 'alyx-matlab' || job.data['repo'] === 'signals') {
    path = path + '\\' + job.data['repo'];}
  if (job.data['repo'] === 'alyx') { sha = 'dev' }; // For Alyx checkout master
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
           job.data['context'] = 'Tests stalled after ~2 min';
           runTests.kill();
      	  done(new Error('Job stalled')) }, 5*60000);
     let args = ['-r', `runAllTests (""${job.data.sha}"",""${job.data.repo}"")`,
       '-wait', '-log', '-nosplash', '-logfile', 'matlab_tests.log'];
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
    if (err) { console.log(err); }
    });
  });
});

// Let fail silently: we report error via status
queue.on('error', err => {return;});
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
  for (commit of event.payload.commits) { // For each commit pushed...
    try {
    // Post a 'pending' status while we do our tests
    await request('POST /repos/:owner/:repo/statuses/:sha', {
            owner: 'cortex-lab',
            repo: event.payload.repository.name,
            headers: {
                authorization: `token ${installationAccessToken}`,
                accept: 'application/vnd.github.machine-man-preview+json'
            },
            sha: commit['id'],
            state: 'pending',
            target_url: `${process.env.WEBHOOK_PROXY_URL}/events/${commit.id}`, // fail
            description: 'Tests error',
            context: 'continuous-integration/ZTEST'
    });
    // Add a new test job to the queue
    queue.add({
        sha: commit['id'],
        owner: 'cortex-lab', // @todo Generalize repo owner field
        repo: event.payload.repository.name,
        status: '',
        context: ''
    });
    } catch (error) {console.log(error)}
  };
});

// Start the server in the port 3000
var server = srv.listen(3000, function () {
   var host = server.address().address
   var port = server.address().port

   console.log("Handler listening at http://%s:%s", host, port)
});
// Start tunnel
tunnel();

// Log any unhandled errors
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  console.log(reason.stack)
});