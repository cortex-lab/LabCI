const userSettings = require('./settings.json') || {};  // User settings
const path = require('path');
env = process.env.NODE_ENV || 'production';
const appdata = process.env.APPDATA || process.env.HOME;
const dataPath = process.env.APPDATA ? path.join(appdata, 'CI') : path.join(appdata, '.ci');
const fixtureDir = path.resolve(__dirname, '..', 'test', 'fixtures');
const dbFilename = '.db.json';
let settings;

// Defaults for when there's no user file; will almost certainly fail
const defaults = {
    max_description_len: 140,  // GitHub status API has a description char limit
    listen_port: 3000,
    timeout: 8 * 60000,
    strict_coverage: false,
    events: {
        push: {
            checks: null,
            ref_ignore: ['documentation', 'gh-pages']
        },
        pull_request: {
            checks: ['continuous-integration', 'coverage'],
            actions: ['opened', 'synchronize', 'reopen'],
            ref_ignore: ['documentation', 'gh-pages']
        }
    },
    dataPath: dataPath,
    dbFile: path.join(dataPath, dbFilename)
};

// Settings for the tests
const testing = {
    listen_port: 3000,
    timeout: 60000,
    events: {
        push: {
            checks: 'continuous-integration',
            ref_ignore: 'documentation'
        },
        pull_request: {
            checks: ['coverage', 'continuous-integration'],
            actions: ['opened', 'synchronize'],
            ref_ignore: ['documentation', 'gh-pages']
        }
    },
    routines: {
        '*': ['prep_env.BAT', 'run_tests.BAT']
    },
    dataPath: fixtureDir,
    dbFile: path.join(fixtureDir, dbFilename)  // cache of test results
};

// Pick the settings to return
if (env.startsWith('test')) {
    settings = testing;
} else if (userSettings) {
    settings = userSettings;
} else {
    settings = defaults;
}

// Ensure defaults for absent fields
for (let field in defaults) {
    if (!(field in settings)) settings[field] = defaults[field];
}

// Check ENV set up correctly
required = ['GITHUB_PRIVATE_KEY', 'GITHUB_APP_IDENTIFIER', 'GITHUB_WEBHOOK_SECRET',
    'WEBHOOK_PROXY_URL', 'REPO_PATH', 'REPO_NAME', 'REPO_OWNER', 'TUNNEL_HOST',
    'TUNNEL_SUBDOMAIN'];
missing = required.filter(o => {
    return !process.env[o];
});
if (missing.length > 0) {
    errMsg = `Env not set correctly; the following variables not found: \n${missing.join(', ')}`;
    throw ReferenceError(errMsg);
}

module.exports = { settings };
