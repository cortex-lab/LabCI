# LabCI
[![Build Status](https://travis-ci.com/cortex-lab/matlab-ci.svg?branch=master)](https://travis-ci.com/cortex-lab/matlab-ci)
[![Coverage](https://img.shields.io/badge/coverage-92.13-brightgreen)](https://img.shields.io/badge/coverage-72.35-yellowgreen)

A small set of modules written in Node.js for running automated tests of MATLAB and Python code in response to GitHub events.  Also submits code coverage to the Coveralls API.

Currently unsupported:
* Running tests on forked repositories
* Testing multiple repos (unless they are submodules)

## Getting Started

Run the install script to install all dependencies, then create your .env file containing your App's tokens, secrets, etc.

### Prerequisites

Requires Git Bash, npm v6.14 or later and Node.js v12.19.0 or later.  For MATLAB tests use MATLAB 2017a or later.

```
npm install ./matlab-ci
```

### Installing

Create a shell/batch script for preparing your environment, and one for running the tests (i.e. calling Python or MATLAB).
Add these to the settings.json file in config:
```
{
  "listen_port": 3000,
  "timeout": 480000,
  "strict_coverage": false,
  "events": {
    "push": {
      "checks": null,
      "ref_ignore": ["documentation", "gh-pages"]
    },
    "pull_request": {
      "checks": ["continuous-integration", "coverage"],
      "actions": ["opened", "synchronize", "reopened"],
      "ref_ignore": ["documentation", "gh-pages"],
      "files_ignore": [".*\\.yml", ".*\\.md", "LICEN[SC]E"]
    }
  }
  "routines": {
    "*": ["prep_env.BAT", "run_tests.BAT"]
  }
}
``` 
Some extra optional settings:

- `shell` - optional shell to use when calling scripts (see `child_process.execFile` options).
- `events:event:ref_include` - same as `ref_ignore`, but a pass list instead of block list.
- `events:event:files_ignore` - list of files whose changes can be ignored.  If only ignored files
are changed checks are skipped.
- `events:pull_request:ignore_drafts` - if true draft pull request actions are skipped (NB: Be
sure to add 'ready_for_review' to the actions list when ignoring drafts).
- `kill_children` - if present and true, `tree-kill` is used to kill the child processes, required 
if shell/batch script forks test process (e.g. a batch script calls python).
- `repos` - an array of submodules or map of modules to their corresponding paths.

Finally, ensure these scripts are executable by node:
```
chmod u+x ./run_tests.BAT
chmod u+x ./prep_env.BAT
```

## Running the tests
Before running the tests ensure the dev dependencies are installed.
On Windows:
```
set "DOTENV_CONFIG_PATH=./test/fixtures/.env.test" & npm test
```
On Linux:
```
DOTENV_CONFIG_PATH=./test/fixtures/.env.test & npm test
```
Coverage:
```
DOTENV_CONFIG_PATH=./test/fixtures/.env.test & npm run coverage
```

## Deployment

To work properly you need to create install a 
[Github app](https://docs.github.com/en/free-pro-team@latest/developers/apps/creating-a-github-app)
on your target repository and download the private key.  Update your .env file like so:

```
GITHUB_PRIVATE_KEY=path\to\private-key.pem
GITHUB_APP_IDENTIFIER=1234
GITHUB_WEBHOOK_SECRET=
WEBHOOK_PROXY_URL=
REPO_PATH=C:\Path\To\Code\Repo
REPO_NAME=
REPO_OWNER=
TUNNEL_HOST=
TUNNEL_SUBDOMAIN=
```

To run at startup create a batch file with the following command:

```batch
cmd /k node -r dotenv/config dotenv_config_path=/Path/To/Env/Vars ./Path/To/main.js 
```

Create a shortcut in your startup folder ([Windows-logo] + [R] in Windows-10 and enter the command `shell:startup`)

## Test script
Your test script must do the following:
1. Accept a commit ID as an input arg
2. Save the results into the JSON cache file without duplication
3. For code coverage the script must either save the coverage directly, or export a Cobertura formatted XML file.

## Built With

* [LocalTunnel](https://localtunnel.me) - A secure tunneling service
* [Shields.io](shields.io) - Display shields

## Contributing

Please read [CONTRIBUTING.md](https://gist.github.com/PurpleBooth/b24679402957c63ec426) for details on our code of conduct, and the process for submitting pull requests to us.

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/your/project/tags). 

## Authors

* **Miles Wells**

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details
