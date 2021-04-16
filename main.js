/**
 * @author Miles Wells <miles.wells@ucl.ac.uk>
 * @requires ./queue.js, ./coverage.js, ./serve.js, ./lib.js
 * @todo save auxiliary configuration into a separate config file
 * @todo add abort option for when new commits added
 * @todo rename context to description and use context to track posts
 */
const { openTunnel, queue, shortCircuit, buildRoutine} = require('./lib');
const { srv, handler, eventCallback} = require('./serve');
const config = require("./config/config").settings;


/**
 * Build queue processing pipeline.  The shortCircuit call checks whether the results may be loaded from file,
 * bypassing the test function.
 */
queue.process((job) => { shortCircuit(job, buildRoutine); });

// NB: Only the supported events make it this far (i.e. push and pull requests)
handler.on('*', evt => eventCallback(evt));


///////////////////// ERROR HANDLING /////////////////////

/**
 * Callback triggered when job completes.  Called when uncaught error is thrown in setup or test
 * functions.  Do nothing as we'll process the error with the 'finish' callback.
 * @param {Object} job - Job object which has finished being processed.
 */
queue.on('error', _ => {});


// Log any unhandled errors
process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  console.log(reason.stack)
});


///////////////////// START TUNNEL /////////////////////

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

