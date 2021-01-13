/**
 * Coverage module loads a Cobertura Format XML file containing code coverage information and reformats it into an
 * object for POSTing to the Coveralls API.
 * @module ./coverage
 * @example
 * // create queue
 * const queue = new require(./queue.js).Queue()
 * queue.process((job, done) => {
 *   console.log('Job with id ' + job.id + ' is being processed');
 *   setTimeout(done, 3000);
 * });
 * var data = {key: 'value'};
 * queue.add(data);
 * @requires module:dotenv For loading in API token
 * @requires module:xml2js For converting XML to object
 * @version 0.9.0
 * @author Miles Wells [<k1o0@3tk.co>]
 * @license Apache-2.0
 */

var fs = require('fs'),
    xml2js = require('xml2js'),
    crypto = require('crypto'),
    assert = require('assert').strict,
    parser = new xml2js.Parser(),
    timestamp, md5, cb;
var timestamp;
var token = process.env.COVERALLS_TOKEN;

/**
 * Formats list of classes from XML file and return object formatted for the Coveralls API.
 * @see {@link https://docs.coveralls.io/api-reference|Coveralls API docs}
 * @param {Array} classList - An array of class objects from the loaded XML file.
 * @param {String} path - The root path of the code repository.
 * @param {String} sha - The commit SHA for this coverage test.
 * @param {function} callback - The callback function to run when complete.  Takes object containing array of source
 * code files and their code coverage
 * @returns {Object}
 * @todo Generalize path default
 */
const formatCoverage = function(classList, path, sha) {
  var job = {};
  var sourceFiles = [];
  path = typeof path != "undefined" ? process.env.HOMEPATH : path; // default to home dir
  // For each class, create file object containing array of lines covered and add to sourceFile array
  classList.forEach( async c => {
    let file = {}; // Initialize file object
    var digest = md5(path + c.$.filename); // Create digest and line count for file
    let lines = new Array(digest.count).fill(null); // Initialize line array the size of source code file
    c.lines[0].line.forEach(ln => {
      let n = Number(ln.$.number);
      if (n <= digest.count) {lines[n] = Number(ln.$.hits) }
    });
    // create source file object
    file.name = c.$.filename;
    file.source_digest = digest.hash;
    file.coverage = lines; // file.coverage[0] == line 1
    sourceFiles.push(file);
  });

  job.repo_token = token; // env secret token?
  job.service_name = `continuous-integration/${process.env.USERDOMAIN}`;
  // The associated pull request ID of the build. Used for updating the status and/or commenting.
  job.service_pull_request = '';
  job.source_files = sourceFiles;
  job.commit_sha = sha;
  job.run_at = timestamp; // "2013-02-18 00:52:48 -0800"
  cb(job);
}

/**
 * Loads a code coverage XML file in Cobertura Format and returns payload object for Coveralls API
 * @see {@link https://docs.coveralls.io/api-reference|Coveralls API docs}
 * @param {String} path - Path to the XML file containing coverage information.
 * @param {String} sha - The commit SHA for this coverage test
 * @param {String} repo - The repo to which the commit belongs
 * @param {function} callback - The callback function to run when complete
 * @todo Remove assert
 * @todo Generalize ignoring of submodules
 * @see {@link https://github.com/cobertura/cobertura/wiki|Cobertura Wiki}
 */
const coverage = function(path, repo, sha, callback) {
  cb = callback; // @fixme Making callback global feels hacky
  fs.readFile(path, function(err, data) { // Read in XML file
     parser.parseString(data, function (err, result) { // Parse XML
        const rigboxPath = result.coverage.sources[0].source[0]; // Extract root code path
        assert(rigboxPath.endsWith('Rigbox\\'), 'Incorrect source code repository')
        timestamp = new Date(result.coverage.$.timestamp*1000); // Convert UNIX timestamp to Date object
        let classes = []; // Initialize classes array

        const packages = result.coverage.packages[0].package;
        packages.forEach(package => { classes.push(package.classes[0].class) }); // Get all classes
        classes = classes.reduce((acc, val) => acc.concat(val), []); // Flatten

        // The submodules
        var modules = {'rigbox' : [], 'alyx-matlab' : [], 'signals' : [], 'npy-matlab' : [], 'wheelAnalysis' : []};
        // Sort into piles
        modules['rigbox'] = classes.filter(function (e) {
            if (e.$.filename.search(/(tests\\|_.*test|docs\\)/i) != -1) {return false;} // Filter out tests and docs
            if (!Array.isArray(e.lines[0].line)) {return false;} // Filter out files with no functional lines
            if (e.$.filename.startsWith('alyx-matlab\\')) {modules['alyx-matlab'].push(e); return false;}
            if (e.$.filename.startsWith('signals\\')) {modules.signals.push(e); return false;}
            if (e.$.filename.startsWith('npy-matlab\\')) {modules['npy-matlab'].push(e); return false;}
            if (e.$.filename.startsWith('wheelAnalysis\\')) {modules.wheelAnalysis.push(e); return false;}
            else {return true}
        });
        formatCoverage(modules[repo.toLowerCase()], rigboxPath, callback);
     });
  });
};

/**
 * Loads file containing source code, returns a hash and line count
 * @param {String} path - Path to the source code file.
 * @returns {Object} key `Hash` contains MD5 digest string of file; `count` contains number of lines in source file
 */
md5 = function(path) {
  var hash = crypto.createHash('md5'); // Creating hash object
  var buf = fs.readFileSync(path, 'utf-8'); // Read in file
  var count = buf.split(/\r\n|\r|\n/).length; // Count the number of lines
  hash.update(buf, 'utf-8'); // Update hash
  return {hash: hash.digest('hex'), count: count};
};

// Export Coverage
module.exports = coverage;
