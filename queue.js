var EventEmitter = require('events').EventEmitter

/**
 * Queue module allows one to add tasks to a queue which are processed sequentially as FILO.
 * @module ./queue
 * @example
 * // create queue
 * const queue = new require(./queue.js).Queue()
 * queue.process((job, done) => {
 *   console.log('Job with id ' + job.id + ' is being processed');
 *   setTimeout(done, 3000);
 * });
 * var data = {key: 'value'};
 * queue.add(data);
 * @version 0.9.0
 * @author Miles Wells [<k1o0@3tk.co>]
 * @license Apache-2.0
 */

/** Class representing a Queue API. */
class Queue extends EventEmitter {

  /**
   * Create queue to add jobs to.
   * @param {string} path - Path to saved queue object (TODO).
   * @property {Array} pile - Array of queued job objects.
   * @property (Function) _process - Handle to job process function.
   * @event module:Queue~finish
   * @event module:Queue~error
   * @event module:Queue~complete
   * @listens module:Queue~event:finish
   * @see {@link Job}
   */
  constructor(timeout, path) {
    super();
    // Initialize properties
    this.pile = [];
    this.path = typeof path == 'undefined' ? './queue.json' : path;  //TODO Implement
    this.on('finish', function () { // Each time a job finishes...
      this.pile.shift(); // take off pile
      this.next()}); // start next job
  }

  /**
   * Create new job and add to queue.
   * @param {Object} data - Data object to be stored in {@link Job}.
   */
  add(data) {
    // generate 16 digit job id
    let d = Date.now().toString()
    let r = Math.floor(Math.random() * 1000).toString()
    let id = Number(r.padStart(3, '0').concat(d))
    this.pile.push(new Job(id, data)); // add to bottom of pile
    console.log('Job added (' + this.pile.length + ' on pile)')
    this.next(); // Start next job if idle
  }

  /**
   * Process next job if any are on pile.
   */
  next() {
    if (this.pile.length > 0 && this.pile[0].running === false) {
      console.log('Starting next job')
      this._process(this.pile[0])
    }
  }

  /**
   * Create callback to be triggered when process function completes.
   * @param {Object} job - {@link Job} object.
   * @todo Change 'incomplete' => 'error'
   * @returns {function} 'done' callback to be called by process function
   */
  createDoneCallback(job) {
    const obj = this;
    return function( err ) {
      job.isRunning = false; // set false (will emit 'end')
      if( err ) { obj.emit('error', err, job); }
      else {obj.emit('complete', job)}
      obj.emit('finish', job);
      }

  }

  /**
   * Create callback to be triggered when process function completes.
   * @param {Function} func - Function to call with job and done callback when.
   */
  process(func) {
    this._process = async (job) => {
      var done = this.createDoneCallback(job);
      job.isRunning = true;
      setImmediate(func, job, done);
      console.log('Job running')
    };
  }
}

/** Class representing a job in the Queue. */
class Job extends EventEmitter {

  /**
   * Create a job object with associated data.
   * @param {number} id - Job ID (unique in current Queue pile).
   * @param {Object} data - Data to hold in object, may be used by Queue process function.
   * @property {boolean} running - Indicates whether job is currently being processed.
   * @event module:Job~end
   */
  constructor(id, data) {
    super();
    //console.log('Job ' + id + ' constructor called')
    // Initialize properties
    this.id = id;
    this.data = data;
    this.running = false;
  }

  /**
   * Set running attribute.  If setting to false from true, emit 'end' event.
   * @param {boolean} bool - Value to set running.
   * @todo rename to be consistent with property
   */
  set isRunning(bool) {
    if (bool === false && this.running === true) {
      this.running = false;
      this.emit('end');
    } else {
      if (bool === true) {
        this.running = true;
      }
    }
  }

}

module.exports = Queue; // Export Queue
