/**
 * A module for configuring the reverse proxy, a local server to process and make requests and
 * middleware for authenticating Github requests and serving local test reports.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const express = require('express');
const srv = express();
const app = require("@octokit/auth-app");
const { request } = require('@octokit/request');
const escapeHtml = require('escape-html');

const config = require('./config/config').settings;
const queue = require('./lib').queue;  // shared Queue from lib
const log = require('./lib').log;
const lib = require('./lib');

// The installation token is a temporary token required for making changes to the Github Checks.
// The token may be set each time a new Github request is received, and before an API request.
var token = {'tokenType': null};
// A hash of the secret is send in the X-Hub-Signature; the handler checks the hash to validate
// that the request comes from GitHub.
const secret = process.env['GITHUB_WEBHOOK_SECRET'];
// Currently this app is only set up to process push and pull request events so we will have the
// handler reject any others.  We will also check that only these are set up in the config.
const supportedEvents = ['push', 'pull_request'];  // events the ci can handle
const maxN = 140;  // The maximum n chars of the status description
const ENDPOINT = 'logs';  // The URL endpoint for fetching status check details
// An optional static directory for serving css files
const STATIC = './public';

// Check all config events are supported
const events = Object.keys(config.events);
if (events.some(evt => { return !supportedEvents.includes(evt); })) {
  let errStr = 'One or more events in config not supported. ' +
               `The following events are supported: ${supportedEvents.join(', ')}`;
  throw new ReferenceError(errStr)
}

// Create handler to verify posts signed with webhook secret.  Content type must be application/json
const createHandler = require('github-webhook-handler');
const handler = createHandler({ path: '/github', secret: secret, events: supportedEvents});


/**
 * Fetch and assign the installation access token.  Should be called each time a POST is made to
 * our app's endpoint.
 * @returns {Promise} - A promise resolved when the installationAccessToken var has been set.
 */
async function setAccessToken() {
    let debug = log.extend('auth');
    // Return if token still valid
    if (new Date(token.expiresAt) > new Date()) { return; }
    // Create app instance for authenticating our GitHub app
    const auth = app.createAppAuth({
       appId: process.env['GITHUB_APP_IDENTIFIER'],
       privateKey: fs.readFileSync(process.env['GITHUB_PRIVATE_KEY']),
       webhooks: { secret }
    });

    if (token.tokenType !== 'installation') {
        debug('Fetching install ID');
        // Retrieve JSON Web Token (JWT) to authenticate as app
        token = await auth({type: "app"});
        // Get installation ID
        const {data: {id}} = await request("GET /repos/:owner/:repo/installation", {
            owner: process.env['REPO_OWNER'],
            repo: process.env['REPO_NAME'],
            headers: {
                authorization: `bearer ${token.token}`,
                accept: "application/vnd.github.machine-man-preview+json"
            }
        });
        token.installationId = id;
    }
    debug('Fetching install token');
    // Retrieve installation token
    const options = {
        type: 'installation',
        installationId: token.installationId
    };
    token = await auth(options);
    debug('Authentication complete');
}


///////////////////// MAIN APP ENTRY POINT /////////////////////

/**
 * Register invalid Github POST requests to handler via /github endpoint.
 * Failed spoof attempts may end up here but most likely it will be unsupported webhook events.
 */
handler.on('error', function (err) {
  console.log('Error:', err.message);
});

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
   if (id != process.env.GITHUB_APP_IDENTIFIER) { next(); return; }  // Not for us; move on
   if (supportedEvents.includes(req.header('X-GitHub-Event'))) {
      await setAccessToken();
      handler(req, res, () => res.end('ok'));
   } else {
      log('GitHub Event "%s" not supported', req.header('X-GitHub-Event'));
      res.sendStatus(400);
   }
});


///////////////////// STATUS DETAILS /////////////////////

/**
 * Serve the test records for requested commit id.  Returns JSON data for the commit.
 * @param {string} id - A commit SHA of any length, or branch name.
 * @param {boolean|null} [isBranch] - If true, id treated as a branch name. Inferred from id by default.
 * @param {string} [module] - (Sub)module name. REPO_NAME by default.
 * @return {Promise} - Resolved to full commit SHA.
 */
function fetchCommit(id, isBranch=null, module) {
   isBranch = isBranch === null ? !lib.isSHA(id) : isBranch
   const data = {
      owner: process.env['REPO_OWNER'],
      repo: module || process.env.REPO_NAME,
      id: id
   };
   let endpoint = `GET /repos/:owner/:repo/${isBranch ? 'branches': 'commits'}/:id`;
   return request(endpoint, data).then(response => {
      return isBranch ? response.data.commit.sha : response.data.sha;
   });
}

/**
 * Parse the short SHA or branch name and redirect to static reports directory.
 */
srv.get(`/coverage/:id`, (req, res) => {
   let id = lib.shortID(req.params.id);
   let isSHA = (req.query.branch || !lib.isSHA(req.params.id)) === false;
   console.log('Request for test coverage for ' + (isSHA? `commit ${id}` : `branch ${req.params.id}`));
   fetchCommit(req.params.id, !isSHA, req.query.module)
      .then(id => {
         log('Commit ID found: %s', id);
         res.redirect(301, `/${ENDPOINT}/coverage/${id}`);
      })
      .catch(err => {
         log('%s', err.message);
    	   res.statusCode = 404;
    	   res.send(`Coverage for ${isSHA? 'commit' : 'branch'} ${req.params.id} not found`);
      });
})

/**
 * Serve the reports tree as a static resource; allows users to inspect the HTML coverage reports.
 * We will add a link to the reports in the check details.
 */
srv.use(`/${ENDPOINT}/coverage`, express.static(path.join(config.dataPath, 'reports')))

/**
 * Serve the css and javascript for the log Webpage.
 */
srv.use(`/static`, express.static(STATIC))

/**
 * Serve the test records for requested commit id.  Returns JSON data for the commit.
 */
srv.get(`/${ENDPOINT}/records/:id`, function (req, res) {
   let id = lib.shortID(req.params.id);
   let isSHA = (req.query.branch || !lib.isSHA(req.params.id)) === false;
   console.log('Request for test records for ' + (isSHA? `commit ${id}` : `branch ${req.params.id}`));
   fetchCommit(req.params.id, !isSHA, req.query.module)
      .then(id => {
         log('Commit ID found: %s', id);
         let record = lib.loadTestRecords(id);
         if (record) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(record));
         } else {
            res.statusCode = 404;
    	      res.send(`${isSHA? 'Commit' : 'Branch'} ${id} not recognized.`);
         }
      })
      .catch(err => {
         log('%s', err.message);
    	   res.statusCode = 404;
    	   res.send(`Record for ${isSHA? 'commit' : 'branch'} ${req.params.id} not found`);
      });
});

/**
 * Serve the test results for requested commit id.  This will be the result of a user clicking on
 * the 'details' link next to the continuous integration check.  The result should be an HTML
 * formatted copy of the stdout for the job's process.
 */
srv.get(`/${ENDPOINT}/:id`, function (req, res) {
   let id = lib.shortID(req.params.id);
   let log_only = (req.query.type || '').startsWith('log')
   let isSHA = (req.query.branch || !lib.isSHA(req.params.id)) === false;
   console.log(
      `Request for test ${log_only ? 'log' : 'stdout'} for ` +
      (isSHA? `commit ${id}` : `branch ${req.params.id}`)
   );
   fetchCommit(req.params.id, !isSHA, req.query.module)
      .then(id => {
         // let url = lib.addParam('/static/log.html', `id=${id}`);
         // if (log_only) { url = lib.addParam(url, 'type=log'); }
         // for (let job of queue.pile) {
         //    if (job.data.sha === id) {
         //       url = lib.addParam(url, 'autoupdate=');
         //       break;
         //    }
         // }
         res.sendFile(path.join(STATIC + 'log.html'));
      })
      .catch(err => {
         log('%s', err.message);
    	   res.statusCode = 404;
    	   res.send(`Record for ${isSHA? 'commit' : 'branch'} ${req.params.id} not found`);
      });
});


/**
 * Serve the test results for requested commit id.  Returns the raw text log.
 */
srv.get(`/${ENDPOINT}/raw/:id`, function (req, res) {
   let id = lib.shortID(req.params.id);
   let log_only = (req.query.type || '').startsWith('log')
   let filename = log_only? `test_output.log` : `std_output-${lib.shortID(id)}.log`;
   let logFile = path.join(config.dataPath, 'reports', id, filename);
   let jobStatus = 'unknown';
   for (let job of queue.pile) {
      if (job.data.sha === req.params.id) {
         jobStatus = running === true? 'running' : 'queued';
         break;
      }
   }

   fs.readFile(logFile, 'utf8', (err, data) => {
      if (err) {
         // Check if queued...
         if (jobStatus === 'queued') {
            data = 'Job waiting to start...';
         } else {
            log('%s', err.message);
            res.statusCode = 404;
            res.send(`Record for commit ${id} not found`);
            return;
         }
      }
      res.statusCode = 200;
      res.header('job_status', jobStatus);
      res.send(escapeHtml(data));
   });
});


///////////////////// SHIELDS API EVENTS /////////////////////

/**
 * Serve the coverage results and build status for the shields.io coverage badge API.  Attempts to
 * load the test results from file and if none exist, adds a new job to the queue.
 */
srv.get('/:badge/:repo/:id', async (req, res) => {
   const context = req.params.badge === 'status' ? 'build' : req.params.badge;
   const data = {
      owner: process.env['REPO_OWNER'],
      repo: req.params.repo,
      routine: lib.context2routine(context)
   };
   // Check we have a matching routine
   if (!data.routine) {
      console.error(`No routine for "${context}" context`);
      return res.sendStatus(404);
   }
   let isSHA = lib.isSHA(req.params.id);
   // Find head commit of branch
   return fetchCommit(req.params.id, !isSHA, req.params.repo)
      .then(id => {
         data['context'] = context;
         data['sha'] = id;
         data['force'] = req.query.force === '' || lib.strToBool(req.query.force);
         console.log(`Request for ${req.params.id} ${data.context}`)
         const report = lib.getBadgeData(data);  // TODO If pending return 201, else 200
         // Send report
         res.setHeader('Content-Type', 'application/json');
         res.end(JSON.stringify(report));})
      .catch(err => {  // Specified repo or branch not found
         console.error(`${data.owner}/${data.repo}/${req.params.id} not found`)
         res.sendStatus((err.status === 404) ? 404 : 500)
      });
});


///////////////////// QUEUE EVENTS /////////////////////

/**
 * Build task pipeline.  Takes a list of scripts/functions and builds a promise chain.
 * @param {Object} job - The path of the repository
 * @returns {Promise} - The job routine
 */
async function buildRoutine(job) {
   const debug = log.extend('pipeline');
   const data = job.data;
   // Get task list from job data, or from context if missing
   const tasks = data.routine? lib.ensureArray(data.routine) : lib.context2routine(data.context);
   // Throw an error if there is no routine defined for this job
   if (!tasks) { throw new Error(`No routine defined for context ${data.context}`); }

   debug('Building routine for job #%g', job.id);
   // variables shared between functions
   const repoPath = lib.getRepoPath(data.repo);
   const sha = data['sha'];
   const logDir = path.join(config.dataPath, 'reports', sha);
   const logName = path.join(logDir, `std_output-${lib.shortID(sha)}.log`);
   await fs.promises.mkdir(logDir, { recursive: true });
   const logDump = fs.createWriteStream(logName, { flags: 'w' });
   logDump.on('close', () => debug('Closing log file'));
   const ops = config.shell? {'shell': config.shell} : {};

   const init = () => debug('Executing pipeline for job #%g', job.id);
   const routine = tasks.reduce(applyTask, Promise.resolve().then(init));
   return routine
      .then(updateJob)
      .catch(handleError)
      .finally(() => logDump.close())

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
         const timer = lib.startJobTimer(job, config.kill_children === true);
         task = lib.fullpath(task);  // Ensure absolute path
         return new Promise(function (resolve, reject) {
            // Spawn a process to execute our task
            const child = cp.spawn(task, [sha, repoPath, logDir], ops);
            let stdout = '', stderr = '';
            // Pipe output to log file
            child.stdout.pipe(logDump, { end: false });
            child.stderr.pipe(logDump, { end: false });
            // Keep output around for reporting errors
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            // error emitted called when spawn itself fails, or process could not be killed
            child.on('error', err => {
                     debug('clearing job timer');
                     clearTimeout(timer);
                     reject(err);})
                 .on('exit', () => {
                    debug('clearing job timer');
                    clearTimeout(timer);})
                 .on('close', (code, signal) => {
                    const callback = (code === 0)? resolve : reject;
                    const proc = {
                       code: code,
                       signal: signal,
                       stdout: stdout,
                       stderr: stderr,
                       process: child
                    };
                    callback(proc);
                 });
            job.data.process = child;  // Assign the child process to the job
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
      const file = (errored instanceof Error)? errored.path : errored.process.spawnfile;
      delete job.data.process;  // Remove the process from the job data

      // Check if the error is a spawn error, this is thrown when spawn itself fails, i.e. due to
      // missing shell script
      if (errored instanceof Error) {
         if (errored.code === 'ENOENT') {
            // Note the missing file (not necessarily the task script that's missing)
            message = file? `File "${file}" not found` : 'No such file or directory';
         } else {
            message = `${errored.code} - Failed to spawn ${file}`;
         }
      // Check if the process was killed (we'll assume by the test timeout callback)
      } else if (errored.process.killed || errored.signal === 'SIGTERM') {
         message = `Tests stalled after ~${(config.timeout / 60000).toFixed(0)} min`;
      } else {  // Error raised by process; dig through stdout for reason
         debug('error from test function %s', file)
         // Isolate error from log
         // For MATLAB return the line that begins with 'Error'
         let fn = (str) => { return str.startsWith('Error in \'') };
         message = errored.stderr.split(/\r?\n/).filter(fn).join(';');
         // For Python, cat from the lost line that doesn't begin with whitespace
         if (!message && errored.stderr.includes('Traceback ')) {
            let errArr = errored.stderr.split(/\r?\n/);
            let idx = errArr.reverse().findIndex(v => {return v.match('^\\S')});
            message = errored.stderr.split(/\r?\n/).slice(-idx-1).join(';');
         }
         // Otherwise simply use the full stderr (will be truncated)
         if (!message) { message = errored.stderr; }
      }
      // Save error into records for future reference.
      let report = {
         'commit': sha,
         'results': message,
         'status': 'error',
         'description': 'Error running ' + (file || 'test routine')
      };
      lib.saveTestRecords(report).then(() => { debug('updated test records'); });
      job.done(new Error(message));  // Propagate
   }

    /**
    * Update the job and mark complete.  Called when job routine completes without error.
    * @param {Object} proc - The stdout, stderr, ChildProcess, exit code and signal
    */
   function updateJob(proc) {
      debug('Job routine complete');
      delete job.data.process;  // Remove process from job data
      // Attempt to update the job data from the JSON records, throw error if this fails
      if (!lib.updateJobFromRecord(job)) {
         job.done(new Error('Failed to return test result'));
      } else {
         job.done(); // All good
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
async function updateStatus(data, targetURL = '') {
   const debug = log.extend('updateStatus');
   // Validate inputs
   if (!lib.isSHA(data.sha)) { throw new ReferenceError('undefined or invalid sha'); }  // require sha
   let supportedStates = ['pending', 'error', 'success', 'failure'];
   if (supportedStates.indexOf(data.status) === -1) {
      throw new lib.APIError(`status must be one of "${supportedStates.join('", "')}"`)
   }
   debug('Updating status to "%s" for %s @ %g',
      data['status'], (data['context'] || '').split('/').pop(), data['sha']);
   await setAccessToken();
   if (targetURL && data['repo'] !== process.env['REPO_NAME']) {
      targetURL = lib.addParam(targetURL, 'module=' + data['repo']);
   }
   return request("POST /repos/:owner/:repo/statuses/:sha", {
      owner: data['owner'] || process.env['REPO_OWNER'],
      repo: data['repo'] || process.env['REPO_NAME'],
      headers: {
         authorization: `token ${token['token']}`,
         accept: "application/vnd.github.machine-man-preview+json"
      },
      sha: data['sha'],
      state: data['status'],
      target_url: targetURL,
      description: (data['description'] || '').substring(0, maxN),
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
     context: null, // The precise check name, keeps track of what check we're doing
     routine: null  // A list of scripts call call
  }

  // Double-check the event was intended for our app.  This is also done using the headers before
  // this stage.  None app specific webhooks could be set up and would make it this far.  Could add
  // some logic here to deal with generic webhook requests (i.e. skip check status update).
  if (event.payload['installation']['id'] !== token['installationId']) {
    throw new lib.APIError('Generic webhook events not supported (installation ID invalid)');
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

  // Determine what to do from settings
  if (!(eventType in config.events)) {
     // No events set; return
     debug('Event "%s" not set in config', eventType);
     return;
  }
  const todo = config.events[eventType] || {}  // List of events to process

  // Check if ref in ignore list or not in include list
  let incl = !todo.ref_ignore;  // ignore list takes precedence
  let ref_list = lib.ensureArray(todo.ref_ignore || todo.ref_include || []);
  if ((ref_list.indexOf(ref.split('/').pop()) === -1) === incl) {
     // Do nothing if in ignore list, or not in include list
     debug(`Ref ${ref} ${incl? 'not' : 'is'} in config ref_${incl? 'include' : 'ignore'} list`);
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
     data.routine = lib.context2routine(check);
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

     /**
     * Update the status and start job.
     * Posts a 'pending' status while we do our tests
     * We wait for the job to be added before we continue so the force flag can be set.
     * NB: If the tests and env prep are too quick our outcome may be updated before the pending
     * status.
     */
     updateStatus(data)
        .then(() => console.log(`Updated status to "pending" for ${data.context}`))
        .catch(err => {
           console.log(`Failed to update status to "pending" for ${data.context}`);
           console.log(err);
        });
     queue.add(data);
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
  let context = job.data.context || '';

  // Update target URL
  if (!job.data.skipPost && context.startsWith('coverage')) {
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

  updateStatus(job.data, target)
     .then(() => console.log(`Updated status to "${job.data.status}" for ${job.data.context}`))
     .catch(err => {
        console.log(`Failed to update status to "${job.data.status}" for ${job.data.context}`);
        console.log(err);
     });
});

module.exports = {
   updateStatus, srv, handler, setAccessToken, eventCallback, fetchCommit, buildRoutine
}
