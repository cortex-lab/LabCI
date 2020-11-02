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
 * @requires module:shelljs
 * @todo save auxiliary configuration into a separate config file
 * @todo add abort option for when new commits added
 * @todo rename context to description and use context to track posts
 * @todo fix intentions
 */
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const Coverage = require('./coverage');
const shell = require('shelljs');
const { openTunnel, ensureArray, loadTestRecords, compareCoverage, queue } = require('./lib');
const { updateStatus, srv, handler, request, eventCallback } = require('./serve');
const config = require("./config/config").settings;

const timeout = config.timeout || 8*60000;


// Serve installation token
// TODO Maybe only occurs when apps are public?  Otherwise post used
// github?code=...&installation_id=...&setup_action=install
srv.get('/github/code=:code&installation_id=:id&setup_action=:action', async (req, res, next) => {
  console.log(req);
});


/**
 * Checkout git.
 * @param {string} repo - Path to the repository.
 * @param {string} id - Commit ID or branch name.
 * TODO WIP
 */
function checkout_commit(repo, id) {
  if (!shell.which('git')) {
    shell.echo('Sorry, this script requires git');
    shell.exit(1);
  }
  shell.pushd(repo);
  if (shell.exec('git reset --hard HEAD').code !== 0) {
    shell.echo('Error: resetting failed');
    shell.popd();
    shell.exit(1);
  }
  shell.popd();
}

/**
 * Load MATLAB test results from .db.json file asynchronously
 * @param {string, array} id - Function to call with job and done callback when.
 * @todo WIP async file reads
 */
function loadTestRecordsAsync(id) {
  cb = fs.readFile(config.dbFile, 'utf8', function (err, data) {
  if (err && err.code === 'ENOENT') {
    console.log('Records file not found');
    return []
  } else {
    try {
      let obj = JSON.parse(data)
    } catch(e) {
      console.error('Failed to decode JSON file records');
    }

  }
  console.log(data);
});
  let obj = JSON.parse(data);
  if (!Array.isArray(obj)) obj = [obj]; // Ensure array
  let records = obj.filter(o => id.includes(o.commit));
  // If single arg return as object, otherwise keep as array
  return (!Array.isArray(id) && records.length === 1 ? records[0] : records)
}

/**
 * Function to update the coverage of a job by parsing the XML file.
 * @param {Object} job - Job object which has finished being processed.
 * @todo Save full coverage object for future inspection
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

///////////////////// GET EVENTS /////////////////////

// Serve the test results for requested commit id
srv.get('/github/:id', function (req, res) {
  console.log('Request for test log for commit ' + req.params.id.substring(0,6))
  let log = `.\\src\\matlab_tests-${req.params.id}.log`;  // TODO Generalize
  fs.readFile(log, 'utf8', (err, data) => {
    if (err) {
    	res.statusCode = 404;
    	res.send(`Record for commit ${req.params.id} not found`);
    } else {
    	res.statusCode = 200;
    	let preText = '<html lang="en-GB"><body><pre>';
    	let postText = '</pre></body></html>';
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
        let record = await loadTestRecords(id);
        if (typeof record == 'undefined' || !record['coverage']) {throw 404} // Test not found for commit
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
        var record = await loadTestRecords(id);
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

///////////////////// QUEUE EVENTS /////////////////////

/**
 * Define how to process tests.  Here we checkout git and call MATLAB.
 * @param {Object} job - Job object which is being processed.
 * @param {Function} done - Callback on complete.
 */
queue.process(async (job, done) => {
  // job.data contains the custom data passed when the job was created
  // job.id contains id of this job.

  // To avoid running our tests twice, set the force flag to false for any other jobs in pile that
  // have the same commit ID
  var repo_path;
  var sha = job.data.sha;
  let others = queue.pile.filter(o => (o.data.sha === sha) && (o.id !== job.id));
  for (let other of others) { other.data.force = false }
  // If lazy, load records to check whether we already have the results saved
  if (job.data.force === false) {  // NB: Strict equality; force by default
    var rec = loadTestRecords(job.data['sha']);  // Load test result from json log
    if (rec) {
      rec = Array.isArray(rec) ? rec.pop() : rec;  // in case of duplicates, take last
      job.data['status'] = rec['status'];
      job.data['description'] = rec['description'];
      job.data['coverage'] = ('coverage' in rec) ? rec['coverage'] : null;
      // If this is a coverage job...
      if ((job.data['context'] || '').startsWith('coverage')) {
        // Either compute coverage from XML if required, otherwise compare coverage
        if (job.data['coverage']) {
          computeCoverage(job);
        } else {
          compareCoverage(job);
        }
      }
      done();  // No need to run tests; skip to complete routine
      return;
    }
  }

  // Go ahead and prepare to run tests
  sha = job.data['sha']; // Retrieve commit hash
  // If the repo is a submodule, modify path
  repo_path = process.env.REPO_PATH;  // FIXME generalize
  if (job.data['repo'] === 'alyx-matlab' || job.data['repo'] === 'signals') {
    repo_path = repo_path + path.sep + job.data['repo'];}
  if (job.data['repo'] === 'alyx') { sha = 'dev' } // For Alyx checkout master
  // Checkout commit  TODO Use shelljs here
  var checkout = cp.execFile('checkout_ibllib_test.bat ', [sha, repo_path], (error, stdout, stderr) => {
     if (error) { // Send error status
       console.error('Checkout failed: ', stderr);
       job.data['status'] = 'error';
       job.data['description'] = `Failed to checkout code: ${stderr}`;
       done(error); // Propagate error
       return;
     }
     console.log(stdout)
    // Go ahead with MATLAB tests
    var runTests;
    const timer = setTimeout(function() {
      console.log('Max test time exceeded');
      job.data['status'] = 'error';
      job.data['description'] = `Tests stalled after ~${(timeout / 60000).toFixed(0)} min`;
      runTests.kill();
      done(new Error('Job stalled'));
    }, timeout);
    let program = config.program || 'matlab';
    let logName = path.join(config.dataPath, 'reports', job.data['sha'], `${program}_tests-${job.data['sha']}.log`)
    // MATLAB
     // let args = ['-r', `runAllTests (""${job.data.sha}"",""${job.data.repo}"")`,
     //   '-wait', '-log', '-nosplash', '-logfile', logName];  // TODO Generalize
    // Python // FIXME Fails silently if runAllTests doesn't exist
    // FIXME Node would need to be called with iblenv
    let testFunction = path.resolve(__dirname, 'runAllTests.' + ((program === 'matlab')? 'm':'py'))
    if(!fs.existsSync(testFunction)) { done(Error (`"${testFunction}" not found`)) }
    let args = [testFunction, '-c', job.data.sha, '-r', process.env.REPO_PATH, '--logdir', `${config.dataPath}`];  // TODO
    // Generalize
    runTests = cp.execFile(program, args, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) { // Send error status
        job.data['status'] = 'error';
        // Isolate error from log
        if (program === 'python') {
          // For Python, cat from the lost line that doesn't begin with whitespace
          let errArr = stderr.split(/\r?\n/);s
          let idx = errArr.reverse().findIndex(v => {return v.match('^\\S')});
          job.data['description'] = stderr.split(/\r?\n/).slice(-idx-1).join(';');
        } else {
          // For MATLAB return the line that begins with 'Error'
          let fn = (str) => { return str.startsWith('Error in \'') };
          job.data['description'] = stderr.split(/\r?\n/).filter(fn).join(';');
        }
          done(error); // Propagate
      } else {
        const rec = loadTestRecords(job.data['sha']); // Load test result from json log
        // FIXME check status valid, i.e. error, passed or failed
        job.data['status'] = rec['status'];
        job.data['description'] = rec['description'];
        job.data['coverage'] = ('coverage' in rec)? rec['coverage'] : null;
        if (!job.data['coverage']) { computeCoverage(job); }  // Attempt to load from XML
        done();
      }
    });
    runTests.stdout.pipe(process.stdout);  // Pipe to display TODO work on serving live, dumping to file
    if (program.startsWith('py')) {
      let logDump = fs.createWriteStream(logName);
      runTests.stdout.pipe(logDump)
      runTests.on('exit', () => { logDump.close(); });
      // runTests.stdout.write = runTests.stderr.write = logDump.write.bind(access);
    }
  });
});

/**
 * Callback triggered when job finishes.  Called both on complete and error.
 * @param {Object} job - Job object which has finished being processed.
 */
queue.on('finish', job => { // On job end post result to API
  console.log(`Job ${job.id} complete`)
  if (job.data.skipPost === true) { return; }
  updateStatus(job.data).then(  // Log outcome
      () => { console.log(`Updated status to "${job.data.status}" for ${job.data.context}`); },
      (err) => {
          console.log(`Failed to update status to "${job.data.status}" for ${job.data.context}`);
          console.log(err);
      }
  );

});

/**
 * Callback triggered when job completes.  Called when all tests run to end.
 * @param {Object} job - Job object which has finished being processed.
 * @todo Save full coverage object for future inspection
 */
queue.on('complete', job => { // On job end post result to API
  // if (config.program === 'python') {
  //   compareCoverage(job.data);  // Coverage already set; compare and return
  //   return
  // }
});

// Let fail silently: we report error via status
queue.on('error', err => {});
// Log handler errors
handler.on('error', function (err) {
  console.error('Error:', err.message)
})

///////////////////// GITHUB EVENTS /////////////////////

// NB: Only the supported events make it this far
handler.on('*', evt => eventCallback(evt))

// Start the server in the port 3000 // TODO Add to config
var server = srv.listen(config.listen_port, function () {
   let host = server.address().address
   let port = server.address().port

   console.log("Handler listening at http://%s:%s", host, port)
});

// Start tunnel // TODO Add dry run flag for testing
openTunnel();

// Log any unhandled errors
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  console.log(reason.stack)
});
