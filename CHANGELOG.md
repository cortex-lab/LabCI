# Changelog

## [Latest](https://github.com/cortex-lab/matlab-ci/commits/master) [3.2.0]

## Added

 - git workflow
 - set coveralls env vars

## [3.1.0]

## Modified

 - dependency vulnerability fixes

## Added

 - separate logs and context log URL parameter

## [3.0.1]

## Modified

 - dependency vulnerability hotfix
 - npm name changed to 'lab-ci' to conform with package rules
 - fix build shield in readme
 
## [3.0.0]
 
## Added

 - any number of tasks may be added for a job, which are then executed in series 
 - now serves a Webpage that shows the log in realtime
 - added a jobs endpoint to see which jobs are on the pile
 - stderr is piped to log file
 - flake8 errors are neatly captured in GitHub status description
 - param to skip checks when only ignored files changed
 - param to skip draft PR event checks 
 
## Modified
 
 - renamed MATLAB-CI to labCI
 - records endpoint can return pending jobs
 - tests badge endpoint returns 'error' on errored tests instead of 'unknown'
 - job waits for coverage calculation and updating of records before finishing
 - On successful completion of tests the duration is appended to the description
 
## [2.2.1]

## Modified

 - fix error where github event incorrectly rejected
 - fix bug incorrect log name when endpoint called with branch name
 
## [2.2.0]

## Added
 - nyc dependency for manual coverage of matlab-ci

## Modified

 - removed old dependencies
 - support for short ids and branch names for all endpoints
 
## [2.1.0]

### Modified
 - More generic handling of submodules
 - Fix for computing coverage properly
 - Fix to issue #43 
 - Fix for issue where jobs added when already on pile
 - New tests added for listSubmodules
 - listSubmodules and gerRepoPath now exposed in lib
 - Removed chai-spies dependency 


## [2.0.0]

### Added

 - there are now three major modules: lib, serve and main
 - lots and lots of new tests
 - support for running any tests: now CI calls a custom shell script
 - new settings file and config module to validate settings
 - branch pass list option in settings
 - force flag for badge API
 - function for converting string to bool in robust way
 - function for saving test records

 
### Modified
 
 - complete rewrite of code
 - index.js renamed to main.js
 - preparing the environment may be optional
 - errors during test function are now saved into test record db
 - new config options (see readme)
 - kill child processes in job timer
 
   
## [1.2.0]
### Modified

- test log formatted in html
- coverage checks ignored for branches named 'documentation' 
- switch from Serveo to localtunnel
- increased timeout from 5 to 8 minutes
- generalized some variables such as repo owner, ci context
- updated documentation

## [1.1.0]
### Added

- coverage increase check on pull request events

### Modified

- fix'd description field for pending status response
- all logs saved into seperate files, no longer overwritten
- suppress warnings about shadowing builtins in runAllTests
- run tests in subfolders
- filter out performance tests
- skip checks for commits to branches named 'documentation'

## [1.0.0]
### Added

- changelog
- status and coverage endpoints for shields

### Modified

- changed from using Smee client to Serveo for exposing ZTEST
- fixes for test reports endpoint
- tests now performed only on head commit
