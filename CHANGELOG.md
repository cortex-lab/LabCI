# Changelog

## [Latest](https://github.com/cortex-lab/matlab-ci/commits/master) [2.1.0]

### Added

- coverage increase check on pull request events

### Modified

- fix'd description field for pending status response
- all logs saved into seperate files, no longer overwritten
- suppress warnings about shadowing builtins in runAllTests
- run tests in subfolders
- filter out performance tests
- skip checks for commits to branches named 'documentation'

## [2.0.0]
### Added

- changelog
- status and coverage endpoints for shields

### Modified

- changed from using Smee client to Serveo for exposing ZTEST
- fixes for test reports endpoint
- tests now performed only on head commit
