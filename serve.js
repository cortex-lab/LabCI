/**
 * A module for configuring the reverse proxy, a local server to process and make requests and
 * middleware for authenticating Github requests and serving local test reports.
 */
const fs = require('fs');
const cp = require('child_process');  // for collating logs
const path = require('path');

const express = require('express');
const srv = express();
const app = require('@octokit/auth-app');
const { request } = require('@octokit/request');

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
const ENDPOINT = 'logs';  // The URL endpoint for fetching status check details
// An optional static directory for serving css files
const STATIC = 'public';

// Check all config events are supported
const events = Object.keys(config.events);
if (events.some(evt => {
    return !supportedEvents.includes(evt);
})) {
    let errStr = 'One or more events in config not supported. ' +
        `The following events are supported: ${supportedEvents.join(', ')}`;
    throw new ReferenceError(errStr);
}

// Create handler to verify posts signed with webhook secret.  Content type must be application/json
const createHandler = require('github-webhook-handler');
const handler = createHandler({path: '/github', secret: secret, events: supportedEvents});


/**
 * Fetch and assign the installation access token.  Should be called each time a POST is made to
 * our app's endpoint.
 * @returns {Promise} - A promise resolved when the installationAccessToken var has been set.
 */
async function setAccessToken() {
    let debug = log.extend('auth');
    // Return if token still valid
    if (new Date(token.expiresAt) > new Date()) return;
    // Create app instance for authenticating our GitHub app
    const auth = app.createAppAuth({
        appId: process.env['GITHUB_APP_IDENTIFIER'],
        privateKey: fs.readFileSync(process.env['GITHUB_PRIVATE_KEY']),
        webhooks: {secret}
    });

    if (token.tokenType !== 'installation') {
        debug('Fetching install ID');
        // Retrieve JSON Web Token (JWT) to authenticate as app
        token = await auth({type: 'app'});
        // Get installation ID
        const {data: {id}} = await request('GET /repos/:owner/:repo/installation', {
            owner: process.env['REPO_OWNER'],
            repo: process.env['REPO_NAME'],
            headers: {
                authorization: `bearer ${token.token}`,
                accept: 'application/vnd.github.machine-man-preview+json'
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
    console.log('Post received');
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
function fetchCommit(id, isBranch = null, module) {
    isBranch = isBranch === null ? !lib.isSHA(id) : isBranch;
    const data = {
        owner: process.env['REPO_OWNER'],
        repo: module || process.env.REPO_NAME,
        id: id
    };
    let endpoint = `GET /repos/:owner/:repo/${isBranch ? 'branches' : 'commits'}/:id`;
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
    console.log('Request for test coverage for ' + (isSHA ? `commit ${id}` : `branch ${req.params.id}`));
    fetchCommit(req.params.id, !isSHA, req.query.module)
        .then(id => {
            log('Commit ID found: %s', id);
            res.redirect(301, `/${ENDPOINT}/coverage/${id}`);
        })
        .catch(err => {
            log('%s', err.message);
            res.statusCode = 404;
            res.send(`Coverage for ${isSHA ? 'commit' : 'branch'} ${req.params.id} not found`);
        });
});

/**
 * Serve the reports tree as a static resource; allows users to inspect the HTML coverage reports.
 * We will add a link to the reports in the check details.
 */
srv.use(`/${ENDPOINT}/coverage`, express.static(path.join(config.dataPath, 'reports')));

/**
 * Serve the css and javascript for the log Webpage.
 */
srv.use(`/static`, express.static(STATIC));

/**
 * Serve the test records for requested commit id.  Returns JSON data for the commit.
 * If no record exists and a job is queued the job data is sent, otherwise a 404.
 */
srv.get(`/${ENDPOINT}/records/:id`, function (req, res) {
    let id = lib.shortID(req.params.id);
    let isSHA = (req.query.branch || !lib.isSHA(req.params.id)) === false;
    console.log('Request for test records for ' + (isSHA ? `commit ${id}` : `branch ${req.params.id}`));
    fetchCommit(req.params.id, !isSHA, req.query.module)
        .then(id => {
            log('Commit ID found: %s', id);
            let record = lib.loadTestRecords(id);
            if (record.length !== 0) {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(record));
            } else {
                // Check if on pile
                for (let job of queue.pile) {
                    if (job.data.sha === id) {
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(job.data));
                        return;
                    }
                }
                // Not on pile, return 404
                res.statusCode = 404;
                res.send(`Record for ${isSHA ? 'commit' : 'branch'} ${id} not found.`);
            }
        })
        .catch(err => {
            if (err.status === 404) {
                res.statusCode = 404;
                res.send(`${isSHA ? 'Commit' : 'Branch'} ${req.params.id} not found.`);
            } else {
                log('%s', err.message || err.name);
                res.statusCode = 500;
                res.send('Failed to read test records JSON');
            }
        });
});

/**
 * Serve the test results for requested commit id.  This endpoint parses and validates the id.
 * If it corresponds to a valid commit SHA, the user is redirected to the log endpoint.
 */
srv.get(`/${ENDPOINT}/:id`, function (req, res) {
    let id = lib.shortID(req.params.id);
    let log_only = (req.query.type || '').startsWith('log');
    let isSHA = (req.query.branch || !lib.isSHA(req.params.id)) === false;
    console.log(
        `Request for test ${log_only ? 'log' : 'stdout'} for ` +
        (isSHA ? `commit ${id}` : `branch ${req.params.id}`)
    );
    fetchCommit(req.params.id, !isSHA, req.query.module)
        .then(id => res.redirect(301, '/log/' + id))
        .catch(err => {
            log('%s', err.message);
            res.statusCode = 404;
            res.send(`Record for ${isSHA ? 'commit' : 'branch'} ${req.params.id} not found`);
        });
});


/**
 * Serve the test results for requested commit id.  This will be the result of a user clicking on
 * the 'details' link next to the continuous integration check.  The result should be an HTML
 * formatted copy of the stdout for the job's process.
 */
srv.get(`/log/:id`, function (req, res) {
    try {  // Send static HTML page template
        res.sendFile(path.join(__dirname, STATIC, 'log.html'));
    } catch (err) {
        log('%s', err.message);
        res.statusCode = 404;
        res.send(`Record for commit ${req.params.id} not found`);
    }
});


/**
 * Serve the log file for requested commit id.  This endpoint is fetched by the format.js script
 * client side.  Returns the raw text log along with a header to indicate whether the job is
 * active.  If the log hasn't changed since the last request, a 304 is returned instead.
 */
srv.get(`/${ENDPOINT}/raw/:id`, function (req, res) {
    let id = lib.shortID(req.params.id);
    let log_only = (req.query.type || '').startsWith('log');
    let checkName = req.query.context? '_' + req.query.context : '';
    let filename = log_only ? `test_output.log` : `std_output-${id}${checkName}.log`;

    let jobStatus = 'finished';
    for (let job of queue.pile) {
        if (job.data.sha === req.params.id) {
            jobStatus = job.running === true ? 'running' : 'queued';
            break;
        }
    }

    if (jobStatus === 'queued') {
        res.statusCode = 200;
        res.header('X-CI-JobStatus', jobStatus);
        res.send('Job waiting to start...');
        return;
    }

    const options = {
        root: path.join(config.dataPath, 'reports', req.params.id),
        headers: {
            'X-CI-JobStatus': jobStatus
        }
    };

    const noLogFile = !(fs.existsSync(path.join(options.root, filename)));
    if (!(req.query.context) && fs.existsSync(options.root) && noLogFile) {
        // Collate logs into one file with filename as separator
        log('Collating logs...');
        let cmd;
        let logPattern = (log_only ? 'test' : 'std') + '*.log';
        switch (process.platform) {
            case 'win32': {
                let sep = ':'.repeat(14);
                cmd = `for %f in (${logPattern}) do `;
                cmd += `(echo ${sep} & echo %f & echo ${sep} & echo. & type "%f" & echo.)`;
            } break;
            case 'linux':
                cmd = `more ${logPattern} | cat`;
                break;
            default:  // *nix command
                cmd = 'head -n 99999 ' + logPattern;
        }

        cp.execSync(cmd + ` >> ${filename}`, {cwd: options.root});
    }

    res.sendFile(filename, options, function (err) {
        if (err) {
            console.error('Failed to send log: ', err);
            res.statusCode = 404;
            res.send(`${req.params.id} not found`);
        } else {
            log('Sent:', filename);
        }
    });

});


/**
 * Serve a list of currently cued jobs.
 */
srv.get('/jobs', function (req, res) {
    const data = {total: queue.pile.length, pile: queue.pile};
    const replacer = (key, value) => {
        return (key[0] === '_') ? undefined : value;
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data, replacer));
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
    const isSHA = lib.isSHA(req.params.id);
    // Find head commit of branch
    return fetchCommit(req.params.id, !isSHA, req.params.repo)
        .then(id => {
            data['context'] = context;
            data['sha'] = id;
            data['force'] = req.query.force === '' || lib.strToBool(req.query.force);
            if (!isSHA) data['branch'] = req.params.id;  // add branch name for coveralls
            console.log(`Request for ${req.params.id} ${data.context}`);
            const report = lib.getBadgeData(data);
            // Send report
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(report));
        })
        .catch(err => {  // Specified repo or branch not found
            console.error(`${data.owner}/${data.repo}/${req.params.id} not found`);
            res.sendStatus((err.status === 404) ? 404 : 500);
        });
});


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
    if (!lib.isSHA(data.sha)) throw new ReferenceError('undefined or invalid sha');  // require sha
    let supportedStates = ['pending', 'error', 'success', 'failure'];
    if (supportedStates.indexOf(data.status) === -1) {
        throw new lib.APIError(`status must be one of "${supportedStates.join('", "')}"`);
    }
    debug('Updating status to "%s" for %s @ %g',
        data['status'], (data['context'] || '').split('/').pop(), data['sha']);
    await setAccessToken();
    if (targetURL && data['repo'] !== process.env['REPO_NAME']) {
        targetURL = lib.addParam(targetURL, 'module=' + data['repo']);
    }
    return request('POST /repos/:owner/:repo/statuses/:sha', {
        owner: data['owner'] || process.env['REPO_OWNER'],
        repo: data['repo'] || process.env['REPO_NAME'],
        headers: {
            authorization: `token ${token['token']}`,
            accept: 'application/vnd.github.machine-man-preview+json'
        },
        sha: data['sha'],
        state: data['status'],
        target_url: targetURL,
        description: (data['description'] || '').substring(0, config.max_description_len),
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
async function eventCallback(event) {
    const debug = log.extend('event');
    debug('eventCallback called');
    var ref;  // ref (i.e. branch name) and head commit
    const eventType = event.event;  // 'push' or 'pull_request'
    const job_template = {  // the data structure containing information about our check
        sha: null,  // The head commit sha to test on
        base: null,  // The previous commit sha (for comparing changes in code coverage)
        force: false,  // Whether to run tests when results already cached
        owner: process.env['REPO_OWNER'], // event.payload.repository.owner.login
        repo: event.payload.repository.name,  // The repository name
        status: 'pending',  // The check state to update our context with
        description: null,  // A brief description of what transpired
        context: null, // The precise check name, keeps track of what check we're doing
        routine: null  // A list of scripts to call
    };

    // Double-check the event was intended for our app.  This is also done using the headers before
    // this stage.  None app specific webhooks could be set up and would make it this far.  Could add
    // some logic here to deal with generic webhook requests (i.e. skip check status update).
    if (event.payload['installation']['id'] !== token['installationId']) {
        throw new lib.APIError('Generic webhook events not supported (installation ID invalid)');
    }

    let filesGET = {  // Data for querying changes files
        owner: process.env['REPO_OWNER'], // event.payload.repository.owner.login
        repo: event.payload.repository.name,  // The repository name
        headers: {
            accept: 'application/vnd.github.machine-man-preview+json'
        }
    };

    // Harvest data payload depending on event type
    switch (eventType) {
        case 'pull_request':
            let pr = event.payload.pull_request;
            job_template['sha'] = pr.head.sha;
            job_template['base'] = pr.base.sha;
            job_template['pull_number'] = pr.number;  // For coveralls.io
            job_template['branch'] = pr.head.ref;  // For coveralls.io
            // Check for repo fork; throw error if forked  // TODO Add full stack test for this behaviour
            let isFork = (pr.base.repo.owner.login !== pr.head.repo.owner.login)
                || (pr.base.repo.owner.login !== process.env['REPO_OWNER'])
                || (pr.head.repo.name !== pr.base.repo.name);
            if (isFork) throw ReferenceError('Forked PRs not supported; check config file');
            if (event.payload.action === 'synchronize') {
                filesGET['base'] = event.payload.before;
                filesGET['head'] = event.payload.after;
            } else {
                filesGET['pull_number'] = pr.number;
            }
            break;
        case 'push':
            job_template['sha'] = event.payload.head_commit.id || event.payload.after;  // Run tests for head commit only
            job_template['base'] = event.payload.before;
            job_template['branch'] = event.payload.ref;  // For coveralls.io
            filesGET['base'] = event.payload.before;
            filesGET['head'] = event.payload.head_commit.id || event.payload.after;
            break;
        default: // Shouldn't get this far
            throw new TypeError(`event "${event.event}" not supported`);
    }
    ref = job_template['branch'];

    // Log the event
    console.log('Received a %s event for %s to %s',
        eventType.replace('_', ' '), job_template['repo'], ref);

    // Determine what to do from settings
    if (!(eventType in config.events)) {
        // No events set; return
        debug('Event "%s" not set in config', eventType);
        return;
    }
    const todo = config.events[eventType] || {};  // List of events to process

    // Check if pull request is a draft and skip if ignore_drafts (default false)
    if (eventType === 'pull_request' &&
        todo.ignore_drafts === true &&
        event.payload.pull_request.draft === true) {
        debug('Ignoring draft pull_requests');
        return;
    }

    // Check if ref in ignore list or not in include list
    let incl = !todo.ref_ignore;  // ignore list takes precedence
    let ref_list = lib.ensureArray(todo.ref_ignore || todo.ref_include || []);
    if ((ref_list.indexOf(ref.split('/').pop()) === -1) === incl) {
        // Do nothing if in ignore list, or not in include list
        debug(`Ref ${ref} ${incl ? 'not' : 'is'} in config ref_${incl ? 'include' : 'ignore'} list`);
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

    // If some files changes ignored, check if we can skip
    if (todo.files_ignore) {
        debug('Checking for changed files');
        let pattern = lib.ensureArray(todo.files_ignore).join('|');
        try {
            let fileURI = (eventType === 'push' || event.payload.action === 'synchronize') ?
                'GET /repos/:owner/:repo/compare/:base...:head' :
                'GET /repos/:owner/:repo/pulls/:pull_number/files';
            let {data} = await request(fileURI, filesGET);
            let files = data.files || data;
            if (files.every(x => x.filename.match(pattern))) {
                return;
            }
        } catch (err) {
            console.log('Failed to query changed files');
            console.error(err);
        }
    }

    // For each check we update it's status and add a job to the queue
    let isString = x => {
        return (typeof x === 'string' || x instanceof String);
    };
    for (let check of checks) {
        // Invent a description for the initial status update
        if (!isString(check)) throw new TypeError('Check must be a string');
        // Copy job data and update check specific fields
        let data = Object.assign({}, job_template);
        data.context = `${check}/${process.env['USERDOMAIN'] || process.env['NAME']}`;
        data.routine = lib.context2routine(check);
        let targetURL = `${process.env['WEBHOOK_PROXY_URL']}/log/${data.sha}?refresh=1`;
        switch (check) {
            case 'coverage':
                data.description = 'Checking coverage';
                targetURL = '';  // Must wait until end for coverage
                break;
            case 'continuous-integration':
                data.description = 'Tests running';
                break;
            default:  // generic description
                data.description = 'Check in progress';
        }

        // If we have two checks to perform and one already on the pile, set force to false
        let qLen = queue.pile.length;
        data.force = !(checks.length > 1 && qLen > 0 && queue.pile[qLen - 1].data.sha === data.sha);

        /**
         * Update the status and start job.
         * Posts a 'pending' status while we do our tests
         * We wait for the job to be added before we continue so the force flag can be set.
         * NB: If the tests and env prep are too quick our outcome may be updated before the pending
         * status.
         */
        updateStatus(data, targetURL)
            .then(() => console.log(`Updated status to "pending" for ${data.context}`))
            .catch(err => {
                console.log(`Failed to update status to "pending" for ${data.context}`);
                console.error(err);
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
    if (job.data.skipPost === true) return;
    let context = job.data.context || '';

    // Update target URL
    if (!job.data.skipPost && context.startsWith('coverage')) {
        // No URL for coverage if errored
        target = err ? '' : `${process.env['WEBHOOK_PROXY_URL']}/${ENDPOINT}/coverage/${job.data.sha}`;
    } else {
        let context = job.data.context.split('/')[0];
        target = `${process.env['WEBHOOK_PROXY_URL']}/${ENDPOINT}/${job.data.sha}?context=${context}`;
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

module.exports = {updateStatus, srv, handler, setAccessToken, eventCallback, fetchCommit};
