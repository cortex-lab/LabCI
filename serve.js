/**
 * A module for configuring the reverse proxy, a local server to process and make requests and
 * middleware for authenticating Github requests and serving local test reports.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config/config').settings;
const queue = require('./lib').queue;  // shared Queue from lib
const { APIError, ensureArray } = require('./lib');
const express = require('express');
const srv = express();

const { App } = require('@octokit/app');
const { request } = require("@octokit/request");

// The installation token is a temporary token required for making changes to the Github Checks.
// The token will be set each time a new Github request is received.
var installationAccessToken;
// A hash of the secret is send in the X-Hub-Signature; the handler checks the hash to validate
// that the request comes from GitHub.
const secret = process.env.GITHUB_WEBHOOK_SECRET;
// Currently this app is only set up to process push and pull request events so we will have the
// handler reject any others.  We will also check that only these are set up in the config.
const supportedEvents = ['push', 'pull_request'];  // events the ci can handle
const maxN = 140;  // The maximum n chars of the status description

const app = new App({
    id: process.env.GITHUB_APP_IDENTIFIER,
    privateKey: fs.readFileSync(process.env.GITHUB_PRIVATE_KEY),
    webhooks: { secret }
});

// Check all config events are supported  // TODO Add test for this
const events = Object.keys(config.events);
if (events.some(evt => {return supportedEvents.indexOf(evt) === -1 })) {
  let errStr = 'One or more events in config not supported. ' +
               `The following events are supported: ${supportedEvents.join(', ')}`;
  throw ReferenceError(errStr)
}

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
      owner: process.env.REPO_OWNER,
      repo: process.env.REPO_NAME,
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

/**
 * Callback to deal with POST requests from /github endpoint, authenticates as app and passes on
 * request to handler.
 * @param {Object} req - Request object.
 * @param {Object} res - Response object.
 * @param {Function} next - Handle to next callback in stack.
 */
srv.post('/github', async (req, res, next) => {
   console.log('Post received')
   let id = req.header('x-github-hook-installation-target-id');
   if (id != process.env.GITHUB_APP_IDENTIFIER) { next() }  // Move on
   setAccessToken().then(
      handler(req, res, () => res.end('ok'))
   ).then(
      () => {},
      (err) => { next(err) }
   );
});


// Serve the test results for requested commit id
srv.get('/logs/:id', function (req, res) {
  console.log('Request for test log for commit ' + req.params.id.substring(0, 6))
  let log = path.join(config.dataPath, 'reports', req.params.id, 'tests.log');  // TODO Generalize
  console.log('Looking in ' + log)
  fs.readFile(log, 'utf8', (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.send(`Record for commit ${req.params.id} not found`);
    } else {
      res.statusCode = 200;
      // Wrap in HTML tags so that the formatting is a little nicer.
      let preText = '<!DOCTYPE html><html lang="en-GB"><body><pre>';
      let postText = '</pre></body></html>';
      res.send(preText + data + postText);
    }
  });
});


/**
 * Server the reports tree as a static resource; allows users to inspect the HTML coverage reports.
 * The root of reports should be forbidden. We will add a link to the reports in the check details.
 */
srv.use('/logs/coverage', express.static(path.join(config.dataPath, 'reports')))
srv.get('/logs/coverage', function (req, res) {
   res.statusCode = 403;
   res.send('Forbidden');
})


/**
 * Updates the status of a Github check, given an object of data from a Job.
 * @param {Object} data - A dictionary of data including the commit sha, status string and context.
 * @param {String} endpoint - The target URL string pointing to the check's details.
 * @returns {Function} - A Github request Promise.
 */
function updateStatus(data, endpoint = null) {
   // Validate inputs
   if (!data.sha) { throw new ReferenceError('SHA undefined') }  // require sha
   let supportedStates = ['pending', 'error', 'success', 'failure'];
   if (supportedStates.indexOf(data.status) === -1) {
      throw new APIError(`status must be one of "${supportedStates.join('", "')}"`)
   }
   return request("POST /repos/:owner/:repo/statuses/:sha", {
      owner: data['owner'] || process.env.REPO_OWNER,
      repo: data['repo'],
      headers: {
         authorization: `token ${installationAccessToken}`,
         accept: "application/vnd.github.machine-man-preview+json"
      },
      sha: data['sha'],
      state: data['status'],
      target_url: endpoint || `${process.env.WEBHOOK_PROXY_URL}/events/${data.sha}`,
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
 * @todo add support for ignore list for specific actions
 */
async function eventCallback (event) {
  var ref;  // ref (i.e. branch name) and head commit
  const eventType = event.event;  // 'push' or 'pull_request'
  var job_template = {  // the data structure containing information about our check
     sha: null,  // The head commit sha to test on
     base: null,  // The previous commit sha (for comparing changes in code coverage)
     force: false,  // Whether to run tests when results already cached
     owner: process.env.REPO_OWNER, // event.payload.repository.owner.login
     repo: event.payload.repository.name,  // The repository name
     status: 'pending',  // The check state to update our context with
     description: null,  // A brief description of what transpired
     context: null // The precise check name, keeps track of what check we're doing
  }

  // Double-check the event was intended for our app.  This is also done using the headers before
  // this stage.  None app specific webhooks could be set up and would make it this far.  Could add
  // some logic here to deal with generic webhook requests (i.e. skip check status update).
  if (event.payload.installation.id !== process.env.GITHUB_APP_IDENTIFIER) {
    throw AssertionError('Generic webhook events not supported')
  }

  // Harvest data payload depending on event type
  switch(eventType) {
  case 'pull_request':
    let pr = event.payload.pull_request;
    ref = pr.head.ref;
    job_template['sha'] = pr.head.sha;
    job_template['base'] = pr.base.sha;
    // Check for repo fork; throw error if forked // TODO What's the behaviour for forked PRs?
    let isFork = (pr.base.repo.owner.login !== pr.head.repo.owner.login)
                 || (pr.base.repo.owner.login !== process.env.REPO_OWNER)
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
  if (!(eventType in config.events)) { return; }  // No events set; return
  const todo = config.events[eventType] || {}  // List of events to process

  // Check if ref in ignore list  FIXME Support for regex here
  let ref_ignore = ensureArray(todo.ref_ignore || []);
  if (ref_ignore.indexOf(ref.split('/').pop()) > -1) { return; }  // Do nothing if in ignore list

  // Check if action in actions list, if applicable
  let actions = ensureArray(todo.actions || []);
  if (event.payload.action && actions && actions.indexOf(event.payload.action) === -1) { return; }

  // Validate checks to run
  const checks = ensureArray(todo.checks || []);
  if (!todo.checks) { return; }  // No checks to perform

  // For each check we update it's status and add a job to the queue
  let isString = x => { return (typeof x === 'string' || x instanceof String); }
  for (let check of checks) {
    // Invent a description for the initial status update
    if (!isString(check)) { throw TypeError('Check must be a string') }
    // Copy job data and update check specific fields
    let data = Object.assign({}, job_template);
    data.context = `${check}/${process.env.USERDOMAIN}`
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
    await updateStatus(data).then( // Log outcome
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

module.exports = {updateStatus, srv, handler, request, setAccessToken, eventCallback}
