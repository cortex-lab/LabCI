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
const { openTunnel, queue, partial, shortCircuit} = require('./lib');
const { srv, handler, eventCallback, runTestsPython} = require('./serve');
const config = require("./config/config").settings;


/**
 * When processing a job, run tests in Python.
 * @param {Function} - A function that takes a Job and Done callback.
 */
queue.process( partial(shortCircuit)(runTestsPython) );


/**
 * Callback triggered when job completes.  Called when all tests run to end.
 * @param {Object} job - Job object which has finished being processed.
 */
queue.on('complete', job => { });


// Let fail silently: we report error via status
queue.on('error', err => {});


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
