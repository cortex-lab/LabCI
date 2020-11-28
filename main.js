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
const { openTunnel, queue, shortCircuit} = require('./lib');
const { srv, handler, eventCallback, runTests, prepareEnv} = require('./serve');
const config = require("./config/config").settings;


/**
 * Build queue processing pipeline.
 * @todo make into Promise chain
 */
// const applyAsync = (acc, val) => acc.then(val);
// const composeAsync = (...funcs) => x => funcs.reduce(applyAsync, Promise.resolve(x));
// const run = composeAsync(shortCircuit, prepareEnv, runTests);
const run = (job) => {
   let run = () => prepareEnv(job, runTests);
   return shortCircuit(job, run);
};
queue.process((job) => { shortCircuit(job, run); })


/**
 * Callback triggered when job completes.  Called when uncaught error is thrown in setup or test
 * functions.  Do nothing as we'll process the error with the 'finish' callback.
 * @param {Object} job - Job object which has finished being processed.
 */
queue.on('error', _ => {});


// Log handler errors
handler.on('error', function (err) {
  console.error('Error:', err.message);
})


///////////////////// GITHUB EVENTS /////////////////////

// NB: Only the supported events make it this far
handler.on('*', evt => eventCallback(evt));

// Start tunnel // TODO Add dry run flag for testing
openTunnel().then(
   () => {
      // Start the server on same port as tunnel
      var server = srv.listen(config.listen_port, function () {
      let host = server.address().address;
      let port = server.address().port;

      console.log("Handler listening at http://%s:%s", host, port);
      });
   },
   (e) => {
      throw e;
   }
)

// Log any unhandled errors
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  console.log(reason.stack)
});
