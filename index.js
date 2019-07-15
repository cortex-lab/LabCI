/**
 * @author Miles Wells <miles.wells@ucl.ac.uk>
 * @requires ./queue.js
 * @requires module:dotenv
 * @requires module:"@octokit/app"
 * @requires module:"@octokit/request"
 * @requires module:express
 * @requires module:github-webhook-handler
 * @requires module:smee-client
 */
const fs = require('fs');
const express = require('express')
const srv = express();
const cp = require('child_process');
const queue = new (require('./queue.js'))()
const { App } = require('@octokit/app');
const { request } = require("@octokit/request");

const id = process.env.GITHUB_APP_IDENTIFIER;
const secret = process.env.GITHUB_WEBHOOK_SECRET;

// Create new tunnel to receive hooks
const SmeeClient = require('smee-client')
const smee = new SmeeClient({
  source: process.env.WEBHOOK_PROXY_URL,
  target: 'http://localhost:3000/github',
  logger: console
})

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
        next();
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
  if (!Array.isArray(obj)) obj = [obj];
  let record;
  for (record of obj) {
    if (record['commit'] === id) {
       return record;
     }
  };
};

/*
// Serve the test results for requested commit id
srv.get('/github/:id', function (req, res) {
  console.log(req.params.id)
  const record = loadTestRecords(req.params.id);
  res.send(record['results']);
}); */

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
     let args = ['-r', `runAllTests (""${job.data.sha}"",""${job.data.repo}"")`, '-wait', '-log', '-nosplash'];
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
  request("POST /repos/:owner/:repo/statuses/:sha", {
    owner: job.data['owner'],
    repo: job.data['repo'],
    headers: {
        authorization: `token ${installationAccessToken}`,
        accept: "application/vnd.github.machine-man-preview+json"},
    sha: job.data['sha'],
    state: job.data['status'],
    target_url: `${process.env.WEBHOOK_PROXY_URL}/events/${job.data.sha}`, // FIXME replace url
    description: job.data['context'],
    context: 'continuous-integration/ZTEST'
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
        owner: 'cortex-lab',
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
const events = smee.start()

// Log any unhandled errors
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  console.log(reason.stack)
});