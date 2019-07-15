function runAllTests(id, repo)
%% Script for running all Rigbox tests
% To be called for code checks and the like
% TODO May add flags for levels of testing
% TODO Method setup in dat_test may become global fixture
% TODO Delete sinusoidLayer_test from this folder
if nargin == 1; repo = 'rigbox'; end
try
  %% Initialize enviroment
  dbPath = 'C:\Users\Experiment\db.json';
  fprintf('Running tests\n')
  fprintf('Repo = %s\n', repo)
  origDir = pwd;
  cleanup = onCleanup(@() cd(origDir));
  cd(fullfile(fileparts(which('addRigboxPaths')),'tests'))
  % Ideally we check code coverage and tests for all commits
  import matlab.unittest.TestRunner
  import matlab.unittest.plugins.CodeCoveragePlugin
  import matlab.unittest.plugins.codecoverage.CoberturaFormat
  
  %% Gather Rigbox main tests
  main_tests = testsuite;
  
  %% Gather signals tests
  root = getOr(dat.paths,'rigbox');
  signals_tests = testsuite(fullfile(root, 'signals', 'tests'));
  
  %% Gather alyx-matlab tests
  alyx_tests = testsuite(fullfile(root, 'alyx-matlab', 'tests'));
  
  %% Filter & run
  % the suite is automatically sorted based on shared fixtures. However, if
  % you add, remove, or reorder elements after initial suite creation, call
  % the sortByFixtures method to sort the suite.
  all_tests = [main_tests signals_tests alyx_tests];
  % If the repo under test is alyx, filter out irrelevent tests
  if strcmp(repo, 'alyx')
    all_tests = all_tests(startsWith({all_tests.Name}, 'Alyx', 'IgnoreCase', true));
  end
  
  runner = TestRunner.withTextOutput;
  reportFile = fullfile(fileparts(dbPath), 'CoverageResults.xml');
  reportFormat = CoberturaFormat(reportFile);
  plugin = CodeCoveragePlugin.forFolder(root, 'Producing', reportFormat, ...
      'IncludingSubfolders', true);
  runner.addPlugin(plugin)
  
  results = runner.run(all_tests);
  assert(now - file.modDate(reportFile) < 0.001, ...
    'Coverage file may not have been updated')
  
  %% Diagnostics
  % failed = {all_tests([results.Failed]).Name}';
  % [info,filePaths] = checkcode(...);
  % Load benchmarks and compare for performance tests?
  status = iff(all([results.Passed]), 'success', 'failure');
  failStr = sprintf('%i/%i tests failed', sum([results.Failed]), length(results));
  context = iff(all([results.Passed]), 'All passed', failStr);
  report = struct(...
    'commit', id, ...
    'results', results, ...
    'status', status, ...
    'description', context);
  if file.exists(dbPath)
    data = jsondecode(fileread(dbPath));
    report = [report; data];
  end
  fid = fopen(dbPath, 'w+');
  fprintf(fid, '%s', jsonencode(report));
  exit(fclose(fid))
catch ex
  fprintf('Error in ''%s'' line %i: %s: %s\n', ...
    ex.stack(1).name, ex.stack(1).line, ex.identifier, ex.message)
  exit(1)
end