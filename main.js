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
const { openTunnel, loadTestRecords, compareCoverage, computeCoverage, queue} = require('./lib');
const { srv, handler, eventCallback } = require('./serve');
const config = require("./config/config").settings;

const timeout = config.timeout || 8*60000;


///////////////////// QUEUE EVENTS /////////////////////

/**
 * Called by queue process.  Here we checkout git and call MATLAB.
 * @param {Object} job - Job object which is being processed.
 * @param {Function} done - Callback on complete.
 */
function runTestsMATLAB(job, done) {
   // Go ahead and prepare to run tests
   sha = job.data['sha']; // Retrieve commit hash
   // If the repo is a submodule, modify path
   repo_path = process.env.REPO_PATH;  // FIXME generalize
   if (job.data['repo'] === 'alyx-matlab' || job.data['repo'] === 'signals') {
      repo_path = repo_path + path.sep + job.data['repo'];}
   // if (job.data['repo'] === 'alyx') { sha = 'dev' }  // For Alyx checkout master
   // Checkout commit  TODO Use shelljs here
   return checkout = cp.execFile('checkout_ibllib_test.bat ', [sha, repo_path], (error, stdout, stderr) => {
      if (error) { // Send error status
         console.error('Checkout failed: ', stderr);
         job.data['status'] = 'error';
         job.data['description'] = `Failed to checkout code: ${stderr}`;
         done(error); // Propagate error
         return;
      }
      console.log(stdout)
      let runTests  // the child process
      const timer = startJobTimer(job, runTests, done);

      // Go ahead with MATLAB tests
      // Run tests in MATLAB
      let logName = path.join(config.dataPath, 'reports', job.data['sha'], `matlab_tests-${job.data['sha']}.log`);
      let args = ['-r', `runAllTests (""${job.data.sha}"",""${job.data.repo}"")`,
                  '-wait', '-log', '-nosplash', '-logfile', logName];
      runTests = cp.execFile('matlab', args, (error, stdout, stderr) => {
         clearTimeout(timer);
         if (error) { // Send error status
            job.data['status'] = 'error';
            // Isolate error from log
            // For MATLAB return the line that begins with 'Error'
            let fn = (str) => { return str.startsWith('Error in \'') };
            job.data['description'] = stderr.split(/\r?\n/).filter(fn).join(';');
            done(error); // Propagate
         } else {
            const rec = loadTestRecords(job.data['sha']);  // Load test result from json log
            job.data['status'] = rec['status'];
            job.data['description'] = rec['description'];
            job.data['coverage'] = ('coverage' in rec)? rec['coverage'] : null;
            if (!job.data['coverage']) { computeCoverage(job); }  // Attempt to load from XML
            done();
         }
      });
      runTests.stdout.pipe(process.stdout);  // Pipe to display
   });
}


function startJobTimer(job, childProcess, done) {
   return setTimeout(() => {
      console.log('Max test time exceeded');
      job.data['status'] = 'error';
      job.data['description'] = `Tests stalled after ~${(timeout / 60000).toFixed(0)} min`;
      childProcess.kill();
      done(new Error('Job stalled'));
   }, timeout);
}

/**
 * Called by queue process.  Here we checkout git and call MATLAB.
 * @param {Object} job - Job object which is being processed.
 * @param {Function} done - Callback on complete.
 */
function runTestsPython(job, done) {
   let runTests  // the child process
   const timer = startJobTimer(job, runTests, done);
   let logName = path.join(config.dataPath, 'reports', job.data['sha'], `python_tests-${job.data['sha']}.log`);

   // Run tests in Python
   let testFunction = path.resolve(__dirname, 'runAllTests.py');
   if(!fs.existsSync(testFunction)) { done(new Error (`"${testFunction}" not found`)); }
   let args = [testFunction, '-c', job.data.sha, '-r', process.env.REPO_PATH, '--logdir', `${config.dataPath}`];
   runTests = cp.execFile('python', args, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error) { // Send error status
         job.data['status'] = 'error';
         // Isolate error from log
         // For Python, cat from the lost line that doesn't begin with whitespace
         let errArr = stderr.split(/\r?\n/);s
         let idx = errArr.reverse().findIndex(v => {return v.match('^\\S')});
         job.data['description'] = stderr.split(/\r?\n/).slice(-idx-1).join(';');
         done(error); // Propagate
      } else {
         const rec = loadTestRecords(job.data['sha']); // Load test result from json log
         job.data['status'] = rec['status'];
         job.data['description'] = rec['description'];
         job.data['coverage'] = ('coverage' in rec)? rec['coverage'] : null;
         if (!job.data['coverage']) { computeCoverage(job); }  // Attempt to load from XML
         done();
      }
   });

   // Write output to file
   runTests.stdout.pipe(process.stdout);  // Pipe to display
   let logDump = fs.createWriteStream(logName);
   runTests.stdout.pipe(logDump)
   runTests.on('exit', () => { logDump.close(); });
   // runTests.stdout.write = runTests.stderr.write = logDump.write.bind(access);
}


/**
 * Define how to process tests.  Here we checkout git and call MATLAB.
 * @param {Object} job - Job object which is being processed.
 * @param {Function} done - Callback on complete.
 */
function process(func, job, done) {
   // job.data contains the custom data passed when the job was created
   // job.id contains id of this job.

   // To avoid running our tests twice, set the force flag to false for any other jobs in pile that
   // have the same commit ID
   let sha = job.data.sha;
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
   return func(job, done);
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
 * When processing a job, run tests in Python.
 * @param {Function} - A function that takes a Job and Done callback.
 */
queue.process( partial(process)(runTestsPython) );


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
