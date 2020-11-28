/**
 * A module for configuring the reverse proxy, a local server to process and make requests and
 * middleware for authenticating Github requests and serving local test reports.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const express = require('express');
const srv = express();
const shell = require('shelljs');
const { App } = require('@octokit/app');  // FIXME deprecated
// const { createAppAuth } = require("@octokit/auth-app")
const { request } = require('@octokit/request');

const config = require('./config/config').settings;
const queue = require('./lib').queue;  // shared Queue from lib
const log = require('./lib').log;
const lib = require('./lib');


// The installation token is a temporary token required for making changes to the Github Checks.
// The token will be set each time a new Github request is received.
var installationAccessToken;
// A hash of the secret is send in the X-Hub-Signature; the handler checks the hash to validate
// that the request comes from GitHub.
const secret = process.env['GITHUB_WEBHOOK_SECRET'];
// Currently this app is only set up to process push and pull request events so we will have the
// handler reject any others.  We will also check that only these are set up in the config.
const supportedEvents = ['push', 'pull_request'];  // events the ci can handle
const maxN = 140;  // The maximum n chars of the status description
const ENDPOINT = 'logs';  // The URL endpoint for fetching status check details

// Check all config events are supported
const events = Object.keys(config.events);
if (events.some(evt => { return !supportedEvents.includes(evt); })) {
  let errStr = 'One or more events in config not supported. ' +
               `The following events are supported: ${supportedEvents.join(', ')}`;
  throw new ReferenceError(errStr)
}

// Create app instance for authenticating our GitHub app
const app = new App({
    id: process.env['GITHUB_APP_IDENTIFIER'],
    privateKey: fs.readFileSync(process.env['GITHUB_PRIVATE_KEY']),
    webhooks: { secret }
});

// Create handler to verify posts signed with webhook secret.  Content type must be application/json
const createHandler = require('github-webhook-handler');
const handler = createHandler({ path: '/github', secret: secret, events: supportedEvents});

/**
 * Fetch and assign the installation access token.  Should be called each time a POST is made to
 * our app's endpoint.
 * @returns {Promise} - A promise resolved when the installationAccessToken var has been set.
 */
function setAccessToken() {
   // Authenticate app by exchanging signed JWT for access token
   const token = app.getSignedJsonWebToken();
   // GET /orgs/:org/installation
   return request("GET /repos/:owner/:repo/installation", {
      owner: process.env['REPO_OWNER'],
      repo: process.env['REPO_NAME'],
      headers: {
         authorization: `bearer ${token}`,
         accept: "application/vnd.github.machine-man-preview+json"
      }
   }).then( res => {
      // contains the installation id necessary to authenticate as an installation
      let installationId = res.data.id;
      app.getInstallationAccessToken({ installationId }).then( token => {
         installationAccessToken = token
      });
   });
}


///////////////////// MAIN APP ENTRY POINT /////////////////////

/**
 * Callback to deal with POST requests from /github endpoint, authenticates as app and passes on
 * request to handler.
 * @param {Object} req - Request object.
 * @param {Object} res - Response object.
 * @param {Function} next - Handle to next callback in stack.
 * @todo split auth and handler middleware
 */
srv.post('/github', async (req, res, next) => {
   console.log('Post received')
   let id = req.header('x-github-hook-installation-target-id');
   if (id != process.env.GITHUB_APP_IDENTIFIER) { next() }  // Not for us; move on
   setAccessToken().then(
      handler(req, res, () => res.end('ok'))
   ).then(
      () => {},
      (err) => { next(err) }
   );
});


///////////////////// STATUS DETAILS /////////////////////

/**
 * Serve the reports tree as a static resource; allows users to inspect the HTML coverage reports.
 * We will add a link to the reports in the check details.
 */
srv.use(`/${ENDPOINT}/coverage`, express.static(path.join(config.dataPath, 'reports')))


/**
 * Serve the test results for requested commit id.  This will be the result of a user clicking on
 * the 'details' link next to the continuous integration check.  The result should be an HTML
 * formatted copy of the stdout for the job's process.
 */
srv.get(`/${ENDPOINT}/:id`, function (req, res) {
   let id = lib.shortID(req.params.id);
   let isSHA = lib.isSHA(req.params.id);
   console.log('Request for test log for ' + (isSHA? `commit ${id}` : `branch ${req.params.id}`));
   let logFile = path.join(config.dataPath, 'reports', req.params.id, `std_output-${id}.log`)
   fs.readFile(logFile, 'utf8', (err, data) => {
      if (err) {
         log('%s', err.message);
    	   res.statusCode = 404;
    	   res.send(`Record for ${isSHA? 'commit' : 'branch'} ${req.params.id} not found`);
      } else {
    	   res.statusCode = 200;
    	   // Wrap in HTML tags so that the formatting is a little nicer.
    	   let preText = '<html lang="en-GB"><body><pre>';
    	   let postText = '</pre></body></html>';
         res.send(preText + data + postText);
      }
   });
});



///////////////////// SHIELDS API EVENTS /////////////////////

/**
 * Serve the coverage results and build status for the shields.io coverage badge API.  Attempts to
 * load the test results from file and if none exist, adds a new job to the queue.
 */
srv.get('/:badge/:repo/:branch', async (req, res) => {
   const data = {
      owner: process.env['REPO_OWNER'],
      repo: req.params.repo,
      branch: req.params.branch,
   }
   // Find head commit of branch
   return request('GET /repos/:owner/:repo/git/refs/heads/:branch', data)
      .then(response => {
         data['context'] = req.params.badge;
         data['sha'] = response.data.object.sha;
         console.log(`Request for ${data.branch} ${data.context}`)
         const report = lib.getBadgeData(data);
         // Send report
         res.setHeader('Content-Type', 'application/json');
         res.end(JSON.stringify(report));})
      .catch(err => {  // Specified repo or branch not found
         console.error(`${data.owner}/${data.repo}/${data.branch} not found`)
         res.sendStatus((err.status === 404) ? 404 : 500)
      });
});


///////////////////// QUEUE EVENTS /////////////////////

function runTests(job) {
   const debug = log.extend('runTests');
   let runTests  // the child process
   debug('starting job timer');
   const timer = lib.startJobTimer(job, runTests);

   // Go ahead with tests
   const sha = job.data['sha'];
   const repoPath = getRepoPath(job.data.repo);
   const logName = path.join(config.dataPath, 'reports', sha, `std_output-${lib.shortID(sha)}.log`);
   fs.mkdir(path.join(config.dataPath, 'reports', sha), { recursive: true }, (err) => {
      if (err) throw err;
   });
   let fcn = lib.fullpath(config.test_function);
   debug('starting test child process %s', fcn);
   runTests = cp.execFile(fcn, [sha, repoPath, config.dataPath], (error, stdout, stderr) => {
      debug('clearing job timer');
      clearTimeout(timer);
      if (error) { // Send error status
         debug('error from test function: %o', error)
         let message;
         // Isolate error from log
         // For MATLAB return the line that begins with 'Error'
         let fn = (str) => { return str.startsWith('Error in \'') };
         message = stderr.split(/\r?\n/).filter(fn).join(';');
         // For Python, cat from the lost line that doesn't begin with whitespace
         if (!message) {
            let errArr = stderr.split(/\r?\n/);
            let idx = errArr.reverse().findIndex(v => {return v.match('^\\S')});
            message = stderr.split(/\r?\n/).slice(-idx-1).join(';');
         }
         if (!message) { message = error.code; }
         job.done(new Error(message));  // Propagate
      } else {
         if (!lib.updateJobFromRecord(job)) {
            job.done(new Error('Failed to return test result'));
         } else {
            job.done();
         }
      }
   });

   // Write output to file
   runTests.stdout.pipe(process.stdout);  // Pipe to display
   let logDump = fs.createWriteStream(logName, { flags: 'a' });
   runTests.stdout.pipe(logDump);
   runTests.on('exit', () => { logDump.close(); });
   // runTests.stdout.write = runTests.stderr.write = logDump.write.bind(access);
   return runTests;
}

function prepareEnv(job, callback) {
   log('Preparing environment for job #%g', job.id)
   const repoPath = getRepoPath(job.data.repo);
   switch (config.setup_function) {
      case undefined:
         // run some basic git commands
         checkout(repoPath, job.data.sha);
         return callback(job);
      case null:  // No prep required
         return callback(job);
      default:
         const sha = job.data['sha'];
         const logName = path.join(config.dataPath, 'reports', sha, `std_output-${lib.shortID(sha)}.log`);
         log('Calling %s with args %o', config.setup_function, [sha, repoPath, logName]);
         let fcn = lib.fullpath(config.setup_function);
         const prepEnv = cp.execFile(fcn, [sha, repoPath, logName], (err, stdout, stderr) => {
            if (err) {
               let errmsg = (err.code === 'ENOENT')? `File "${fcn}" not found` : err.code;
               console.error('Checkout failed: ' + stderr || errmsg);
               job.done(new Error(`Failed to prepare env: ${stderr || errmsg}`));  // Propagate error
               return;
            }
            callback(job);
         });
         prepEnv.stdout.pipe(process.stdout);
         let logDump = fs.createWriteStream(logName, { flags: 'w' });
         prepEnv.stdout.pipe(logDump);
         prepEnv.on('exit', () => { logDump.close(); });
         return prepEnv;
   }
}

/**
 * Checkout Git repository.
 * @param {String} repoPath - The path of the repository
 * @param {String} ref - A commit SHA or branch name
 * @todo Add error handling
 */
function checkout(repoPath, ref) {
   if (!shell.which('git')) { throw new Error('Git not found on path'); }
   let verify = (cmd) => { if (!cmd) {
      shell.popd();
      throw new Error('Failed to checkout: ' + cmd.stderr);
   } };
   if (!shell.pushd(repoPath)) {
      shell.mkdir(path.resolve(repoPath + path.sep + '..'));
      shell.pushd(repoPath);
      verify(shell.exec(`git clone https://github.com/${env.process['REPO_OWNER']}/${env.process['REPO_NAME']}.git`));
      verify(shell.exec(`git checkout ${ref}`));
   } else {
      verify(shell.exec('git fetch -a'));
      verify(shell.exec('git reset --hard HEAD'));
      verify(shell.exec(`git checkout ${ref}`));
      verify(shell.exec('git submodule update --init --recursive'));
      verify(shell.exec('git submodule foreach git reset --hard HEAD'));
      verify(shell.exec('git status'));
   }
   shell.popd();
}


/**
 * Lists the submodules within a Git repository.  If none are found null is returned.
 * @param {String} repoPath - The path of the repository
 * @returns {Array} A list of submodule names, or null if none were found
 */
function listSubmodules(repoPath) {
   if (!shell.which('git')) { throw new Error('Git not found on path'); }
   shell.pushd(repoPath);
   let listModules = 'git config --file .gitmodules --get-regexp path | awk \'{ print $2 }\'';
   const modules = shell.exec(listModules);
   shell.popd();
   return (!modules.code && modules.stdout !== '')? modules.split('\n') : null;
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
   if (config.repos.name) { return config.repos.name; }  // Found path, return
   for (let repo of config.repos) {
      let modules = listSubmodules(repo);
      if (modules && modules.includes(name)) {
         // If the repo is a submodule, modify path
         return repo + path.sep + name;
      }
   }
}


///////////////////// OTHER /////////////////////

/**
 * Updates the status of a Github check, given an object of data from a Job.
 * @param {Object} data - A dictionary of data including the commit sha, status string and context.
 * @param {String} targetURL - The target URL string pointing to the check's details.
 * @returns {Function} - A Github request Promise.
 */
function updateStatus(data, targetURL = '') {
   const debug = log.extend('updateStatus');
   // Validate inputs
   if (!data.sha) { throw new ReferenceError('SHA undefined') }  // require sha
   let supportedStates = ['pending', 'error', 'success', 'failure'];
   if (supportedStates.indexOf(data.status) === -1) {
      throw new lib.APIError(`status must be one of "${supportedStates.join('", "')}"`)
   }
   debug('Updating status to "%s" for %g', data['status'], data['sha']);
   return request("POST /repos/:owner/:repo/statuses/:sha", {
      owner: data['owner'] || process.env['REPO_OWNER'],
      repo: data['repo'],
      headers: {
         authorization: `token ${installationAccessToken}`,
         accept: "application/vnd.github.machine-man-preview+json"
      },
      sha: data['sha'],
      state: data['status'],
      target_url: targetURL,
      description: data['description'].substring(0, maxN),
      context: data['context']
    });
}


/**
 * Callback triggered when a GitHub event occurs.  Here we deal with all events, adding jobs to the
 * Queue as needed.  If an event is not specified in the config, the callback will return ok but do
 * nothing.
 * Payload reference https://developer.github.com/webhooks/event-payloads/
 * @param {Object} event - The GitHub event object.
 * @todo Save full coverage object for future inspection
 * @todo Add support for ignore list for specific actions
 * @todo Add support for regex in branch ignore list
 */
async function eventCallback (event) {
  const debug = log.extend('event');
  debug('eventCallback called');
  var ref;  // ref (i.e. branch name) and head commit
  const eventType = event.event;  // 'push' or 'pull_request'
  var job_template = {  // the data structure containing information about our check
     sha: null,  // The head commit sha to test on
     base: null,  // The previous commit sha (for comparing changes in code coverage)
     force: false,  // Whether to run tests when results already cached
     owner: process.env['REPO_OWNER'], // event.payload.repository.owner.login
     repo: event.payload.repository.name,  // The repository name
     status: 'pending',  // The check state to update our context with
     description: null,  // A brief description of what transpired
     context: null // The precise check name, keeps track of what check we're doing
  }

  // Double-check the event was intended for our app.  This is also done using the headers before
  // this stage.  None app specific webhooks could be set up and would make it this far.  Could add
  // some logic here to deal with generic webhook requests (i.e. skip check status update).
  if (event.payload['installation']['id'] !== process.env['GITHUB_APP_IDENTIFIER']) {
    debug('install id = ' + event.payload['installation']['id']);
     //throw new lib.APIError('Generic webhook events not supported');  // FIXME store install id
  }

  // Harvest data payload depending on event type
  switch(eventType) {
  case 'pull_request':
    let pr = event.payload.pull_request;
    ref = pr.head.ref;
    job_template['sha'] = pr.head.sha;
    job_template['base'] = pr.base.sha;
    // Check for repo fork; throw error if forked  // TODO Add full stack test for this behaviour
    let isFork = (pr.base.repo.owner.login !== pr.head.repo.owner.login)
                 || (pr.base.repo.owner.login !== process.env['REPO_OWNER'])
                 || (pr.head.repo.name !== pr.base.repo.name);
    if (isFork) { throw ReferenceError('Forked PRs not supported; check config file') }
    break;
  case 'push':
    ref = event.payload.ref;
    job_template['sha'] = event.payload.head_commit.id || event.payload.after;  // Run tests for head commit only
    job_template['base'] = event.payload.before;
    break;
  default: // Shouldn't get this far
    throw new TypeError(`event "${event.event}" not supported`)
  }

  // Log the event
  console.log('Received a %s event for %s to %s',
    eventType.replace('_', ' '), job_template['repo'], ref)
  debug('job template: %O', job_template);

  // Determine what to do from settings
  if (!(eventType in config.events)) {
     // No events set; return
     debug('Event "%s" not set in config', eventType);
     return;
  }
  const todo = config.events[eventType] || {}  // List of events to process

  // Check if ref in ignore list
  let ref_ignore = lib.ensureArray(todo.ref_ignore || []);
  if (ref_ignore.indexOf(ref.split('/').pop()) > -1) {
     // Do nothing if in ignore list
     debug('Ref %s in config ignore list', ref_ignore);
     return;
  }

  // Check if action in actions list, if applicable
  let actions = lib.ensureArray(todo.actions || []);
  if (event.payload.action && actions && actions.indexOf(event.payload.action) === -1) {
     debug('Action "%s" not set in config', event.payload.action);
     return;
  }

  // Validate checks to run
  const checks = lib.ensureArray(todo.checks || []);
  if (!todo.checks) {
     // No checks to perform
     debug('No checks set in config');
     return;
  }

  // For each check we update it's status and add a job to the queue
  let isString = x => { return (typeof x === 'string' || x instanceof String); }
  for (let check of checks) {
    // Invent a description for the initial status update
    if (!isString(check)) { throw new TypeError('Check must be a string') }
    // Copy job data and update check specific fields
    let data = Object.assign({}, job_template);
    data.context = `${check}/${process.env['USERDOMAIN'] || process.env['NAME']}`
    switch (check) {
      case 'coverage':
        data.description = 'Checking coverage';
        break;
      case 'continuous-integration':
        data.description = 'Tests running';
        break;
      default:  // generic description
        data.description = 'Check in progress';
    }

    // If we have two checks to perform and one already on the pile, set force to false
    let qLen = queue.pile.length;
    data.force = !(checks.length > 1 && qLen > 0 && queue.pile[qLen-1].data.sha === data.sha);

    // Update the status and start job
    // Post a 'pending' status while we do our tests
    // We wait for the job to be added before we continue so the force flag can be set
    updateStatus(data).then( // Log outcome
       () => {
          console.log(`Updated status to "pending" for ${data.context}`);
          // Add a new test job to the queue
          queue.add(data);
       },
       (err) => {
          console.log(`Failed to update status to "pending" for ${data.context}`);
          console.log(err);
       }
    );
  }
}


///////////////////// QUEUE EVENTS /////////////////////

/**
 * Callback triggered when job finishes.  Called both on complete and error.
 * @param {Object} job - Job object which has finished being processed.
 */
queue.on('finish', (err, job) => { // On job end post result to API
  var target = '';  // We will only update the endpoint for coverage jobs
  console.log(`Job #${lib.shortID(job.id)} finished` + (err ? ' with error' : ''));
  if (job.data.skipPost === true) { return; }

  // Update target URL
  if (!job.data.skipPost && job.data.context.startsWith('coverage')) {
     // No URL for coverage if errored
     target = err? '' : `${process.env['WEBHOOK_PROXY_URL']}/${ENDPOINT}/coverage/${job.data.sha}`;
  } else {
     target = `${process.env['WEBHOOK_PROXY_URL']}/${ENDPOINT}/${job.data.sha}`;
  }

  // Update status if error occurred
  if (err) {
     job.data['status'] = 'error';
     job.data['description'] = err.message;
  }

  updateStatus(job.data, target).then(  // Log outcome
      () => { console.log(`Updated status to "${job.data.status}" for ${job.data.context}`); },
      (err) => {
          console.log(`Failed to update status to "${job.data.status}" for ${job.data.context}`);
          console.log(err);
      }
  );
});


module.exports = {
   updateStatus, srv, handler, setAccessToken, prepareEnv, runTests, eventCallback
}
