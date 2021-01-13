# Changelog

## [Latest](https://github.com/cortex-lab/matlab-ci/commits/master) [2.2.0]

### Modified

- test log formatted in html
- coverage checks ignored for branches named 'documentation' 
- switch from Serveo to localtunnel
- increased timeout from 5 to 8 minutes
- generalized some variables such as repo owner, ci context
- updated documentation

## [2.1.0]
### Added

- coverage increase check on pull request events

### Modified

- fix'd description field for pending status response
- all logs saved into seperate files, no longer overwritten
- suppress warnings about shadowing builtins in runAllTests
- run tests in subfolders
- filter out performance tests
<<<<<<< HEAD
- skip tests for commits to branches named 'documentation'
=======
- skip checks for commits to branches named 'documentation'
>>>>>>> master

## [2.0.0]
### Added

- changelog
- status and coverage endpoints for shields

### Modified

- changed from using Smee client to Serveo for exposing ZTEST
- fixes for test reports endpoint
- tests now performed only on head commit
