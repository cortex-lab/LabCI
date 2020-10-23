const userSettings = require('./settings.json') || {}  // User settings
const path = require('path')
env = process.env.NODE_ENV || 'production'
const appdata = process.env.APPDATA || process.env.HOMEPATH;
const dataPath = (process.env.APPDATA)? path.join(appdata, 'CI') : path.join(appdata, '.ci')
const dbFilename = '.db.json'
let settings;

// Defaults for when there's no user file; will almost certainly fail
defaults = {
    listen_port: 3000,
    timeout: 8*60000,
    program: "python",
    events: {
        push: {
            checks: null,
            actions: null,
            ref_ignore: ["documentation", "gh-pages"]
        },
        pull_request: {
            checks: ["continuous-integration", "coverage"],
            actions: ["opened", "synchronize"],
            ref_ignore: ["documentation", "gh-pages"]
        }
    },
    dataPath: dataPath,
    dbFile: path.join(dataPath, dbFilename)
}

// Settings for the tests
testing = {
    listen_port: 3000,
    timeout: 60000,
    program: "python",
    events: {
        push: {
            checks: "continuous-integration",
            actions: null,
            ref_ignore: "documentation"
        },
        pull_request: {
            checks: ["coverage"],
            actions: ["opened", "synchronize"],
            ref_ignore: ["documentation", "gh-pages"]
        }
    },
    dbFile: path.resolve(__dirname, '..', 'test', 'fixtures', dbFilename)  // cache of test results
}

// Pick the settings to return
if (env.startsWith('test')) {
  settings = testing;
} else if (userSettings) {
  settings = userSettings;
  if (!('dbFile' in settings)) {
    settings.dbFile = path.join(dataPath, dbFilename)
  }
  if (!('dataPath' in settings)) {
      settings.dataPath = dataPath;
  }
} else {
  settings = defaults;
}


module.exports = { settings }
