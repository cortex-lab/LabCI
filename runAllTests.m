function runAllTests(id, repo)
%% Script for running all Rigbox tests
% To be called for code checks and the like
% TODO May add flags for levels of testing
% TODO Possible for repo commit sha conflict
% @body Technically two different repos can have the same commit hash, in
% which case the db.json file should be restructured
if nargin == 1; repo = 'rigbox'; end
try
  %% Initialize enviroment
  dbPath = 'C:\Users\Experiment\db.json';
  fprintf('Running tests\n')
  fprintf('Repo = %s, sha = %s\n', repo, id)
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
  elseif strcmp(repo, 'alyx-matlab')
    all_tests = alyx_tests;
  elseif strcmp(repo, 'signals')
    all_tests = signals_tests;
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
  % Summarize the results of the tests and write results to the JSON file
  % located at dbPath
  status = iff(all([results.Passed]), 'success', 'failure');
  failStr = sprintf('%i/%i tests failed', sum([results.Failed]), length(results));
  context = iff(all([results.Passed]), 'All passed', failStr);
  report = struct(...
    'commit', id, ...
    'results', results, ...
    'status', status, ...
    'description', context, ...
    'coverage', []); % Coverage updated by Node.js script
  if file.exists(dbPath)
    data = jsondecode(fileread(dbPath));
    idx = strcmp(id, {data.commit}); % Check record exists for this commit
    if any(idx) % If so update record
      data(idx) = report;
      report = data;
    else % ...or append record
      report = [report; data];
    end
  end
  fid = fopen(dbPath, 'w+');
  fprintf(fid, '%s', obj2json(report));
  exit(fclose(fid))
catch ex
  fprintf('Error in ''%s'' line %i: %s: %s\n', ...
    ex.stack(1).name, ex.stack(1).line, ex.identifier, ex.message)
  exit(1)
end