# Changelog

## [Latest](https://github.com/cortex-lab/matlab-ci/commits/master) [2.0.0]
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
 
   
## [1.2.0]
### Modified

- test log formatted in html
- coverage checks ignored for branches named 'documentation' 
- switch from Serveo to localtunnel
- increased timeout from 5 to 8 minutes

## [1.1.0]
### Added

- coverage increase check on pull request events

### Modified

- fix'd description field for pending status response
- all logs saved into seperate files, no longer overwritten
- suppress warnings about shadowing builtins in runAllTests
- run tests in subfolders
- filter out performance tests
- skip tests for commits to branches named 'documentation'

## [1.0.0]
### Added

- changelog
- status and coverage endpoints for shields

### Modified

- changed from using Smee client to Serveo for exposing ZTEST
- fixes for test reports endpoint
- tests now performed only on head commit
