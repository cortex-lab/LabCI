function runAllTests(id, repo, logDir)
%% Script for running all Rigbox tests
% To be called for code checks and the like
% TODO May add flags for levels of testing
% TODO Possible for repo commit sha conflict
% @body Technically two different repos can have the same commit hash, in
% which case the db.json file should be restructured
% v1.1.2
if nargin < 2; repo = 'rigbox'; end
if nargin < 1; id = []; end
try
  %% Initialize enviroment
  dbPath = fullfile(logDir, 'db.json'); % TODO Load from config file
  fprintf('Running tests\n')
  fprintf('Repo = %s, sha = %s\n', repo, id)
  origDir = pwd;
  cleanup = onCleanup(@() fun.applyForce({...
    @() cd(origDir), ...
    @() warning(origState)}));
  cd(fullfile(fileparts(which('addRigboxPaths')),'tests'))
  % Ideally we check code coverage and tests for all commits
  import matlab.unittest.TestRunner
  import matlab.unittest.plugins.CodeCoveragePlugin
  import matlab.unittest.plugins.codecoverage.CoberturaFormat
  % Suppress warnings about shadowed builtins in utilities folder
  warning('off','MATLAB:dispatcher:nameConflict')

  %% Gather Rigbox main tests
  main_tests = testsuite('IncludeSubfolders', true);

  %% Gather signals tests
  root = getOr(dat.paths,'rigbox');
  signals_tests = testsuite(fullfile(root, 'signals', 'tests'), ...
    'IncludeSubfolders', true);

  %% Gather alyx-matlab tests
  alyx_tests = testsuite(fullfile(root, 'alyx-matlab', 'tests'), ...
    'IncludeSubfolders', true);

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

  % Filter out performance tests
  % @todo Run performance tests
  % @body Currently the performance tests are entirely filtered out
  is_perf = @(t) contains(t.Name, 'perftest', 'IgnoreCase', true);
  [~, all_tests] = fun.filter(is_perf, all_tests);

  runner = TestRunner.withTextOutput;
  reportFile = fullfile(fileparts(dbPath), 'CoverageResults.xml');
  reportFormat = CoberturaFormat(reportFile);
  plugin = CodeCoveragePlugin.forFolder(root, 'Producing', reportFormat, ...
      'IncludingSubfolders', true);
  runner.addPlugin(plugin)

  results = runner.run(all_tests);
  assert(now - file.modDate(reportFile) < 0.001, ...
    'Coverage file may not have been updated')

  % If no commit id set, simply exit the function
  if isempty(id); return; end

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
  disp(getReport(ex)) % Display details for debugging
  if ~isempty(id), exit(1), end
end
