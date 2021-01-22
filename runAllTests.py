"""A module for running ibllib continuous integration tests with coverage
In order for this to work ibllib and iblscripts must be installed as python package from GitHub,
as well as the coverage package.
"""
import argparse
import unittest
import re
import json
import logging
from datetime import datetime
from logging.handlers import RotatingFileHandler
from os import sep
from pathlib import Path
from typing import Iterable, List, Union

from coverage import Coverage
from coverage.misc import CoverageException

from ibllib.misc.flatten import flatten
from ibllib.misc.version import ibllib as ver

logger = logging.getLogger('ibllib')

try:  # Import the test packages
    import brainbox.tests, ci.tests, ibllib.tests, alf.tests, oneibl.tests
except ModuleNotFoundError as ex:
    logger.warning(f'Failed to import test packages: {ex} encountered')


def list_tests(suite: Union[List, unittest.TestSuite, unittest.TestCase]) -> Union[List[str], str]:
    """
    Returns a full list of the tests run in the format 'TestClassName/test_method'
    :param suite: A TestCase or TestSuite instance, or list thereof
    :return: A list of tests
    """
    if isinstance(suite, list):
        return flatten([list_tests(x) for x in suite])
    elif not unittest.suite._isnotsuite(suite):
        return list_tests(suite._tests)
    elif isinstance(suite, (unittest.TestSuite, unittest.TestCase)):
        return f'{suite.__class__.__name__}/{suite._testMethodName}'


def generate_coverage_report(cov, save_path, strict=False, relative_to=None):
    """
    Generates HTML and XML reports of test coverage and returns the total coverage
    :param cov: A Coverage object
    :param save_path: Where to save the coverage files
    :param strict: If True, asserts that the coverage report was created
    :param relative_to: The root folder for the functions coverage
    :return:
    """
    try:
        total = cov.html_report(directory=str(save_path))
        cov.xml_report(outfile=str(save_path.joinpath('CoverageResults.xml')))
        success = save_path.joinpath('CoverageResults.xml').exists()
        assert not strict or success, 'failed to generate XML coverage'
    except (CoverageException, AssertionError) as ex:
        if strict:
            raise ex
        total = None
        logger.error('Failed to save coverage: %s', ex)

    if relative_to:
        # Rename the HTML files for readability and to obscure the server's directory structure
        pattern = re.sub(r'^[a-zA-Z]:[/\\]|[/\\]', '_', str(relative_to.parent)) + '_'  # / -> _
        for file in Path(save_path).glob('*.html'):  # Open each html report file
            with open(file, 'r') as f:
                data = f.read()
                data = data.replace(pattern, '')  # Remove long paths in filename links
                data = data.replace(str(relative_to.parent) + sep, '')  # Remove from text
            with open(file, 'w') as f:
                f.write(data)  # Write back into file
            file.rename(str(file).replace(pattern, ''))  # Rename file
    return total


def run_tests(complete: bool = True,
              strict: bool = True,
              dry_run: bool = False) -> (unittest.TestResult, Coverage, unittest.TestSuite):
    """
    Run integration tests
    :param complete: When true ibllib unit tests are run in addition to the integration tests.
    :param strict: When true asserts that all gathered tests were successfully imported.  This
    means that a module not found error in any test module will raise an exception.
    :param dry_run: When true the tests are gathered but not run.
    :return Test results and coverage objects, and test suite.
    """
    # Coverage recorded for all code within the source directory; otherwise just omit some
    # common pyCharm files
    options = {'omit': ['*pydevd_file_utils.py', 'test_*'], 'source': []}

    # Gather tests
    test_dir = str(Path(ci.tests.__file__).parent)
    logger.info(f'Loading integration tests from {test_dir}')
    ci_tests = unittest.TestLoader().discover(test_dir, pattern='test_*')
    if complete:  # include ibllib and brainbox unit tests
        root = Path(ibllib.__file__).parents[1]  # Search relative to our imported ibllib package
        test_dirs = [root.joinpath(x) for x in ('brainbox', 'oneibl', 'ibllib', 'alf')]
        for tdir in test_dirs:
            logger.info(f'Loading unit tests from folders: {tdir}')
            assert tdir.exists(), f'Failed to find unit test folders in {tdir}'
            unit_tests = unittest.TestLoader().discover(str(tdir), pattern='test_*', top_level_dir=root)
            logger.info(f"Found {unit_tests.countTestCases()}, appending to the test suite")
            ci_tests = unittest.TestSuite((ci_tests, *unit_tests))
            # for coverage, append the path of the test modules to the source key
            options['source'].append(str(tdir))
    logger.info(f'Complete suite contains {ci_tests.countTestCases()} tests')
    # Check all tests loaded successfully
    not_loaded = [x[12:] for x in list_tests(ci_tests) if x.startswith('_Failed')]
    if len(not_loaded) != 0:
        err_msg = 'Failed to import the following tests:\n\t' + '\n\t'.join(not_loaded)
        assert not strict, err_msg
        logger.warning(err_msg)

    if dry_run:
        return unittest.TestResult(), Coverage(**options), ci_tests

    # Run tests with coverage
    cov = Coverage(**options)
    cov.start()

    result = unittest.TextTestRunner(verbosity=2).run(ci_tests)

    cov.stop()
    cov.save()

    return result, cov, ci_tests


if __name__ == "__main__":
    r"""Run all the integration tests with coverage
    The commit id is used to identify the test report.  If none is provided no test record is saved
 
    python runAllTests.py --logdir <log directory> --commit <commit sha> --repo <repo path>
    
    Examples:
      python runAllTests.py -l C:\Users\User\AppData\Roaming\CI
      python runAllTests.py -l ~/.ci
    """
    # Defaults
    root = Path(__file__).parent.absolute()  # Default root folder
    repo_dir = Path(ibllib.__file__).parent  # Default repository source for coverage
    version = ver()
    if not version or version == 'unversioned':
        getattr(ibllib, '__version__', datetime.now().strftime('%Y-%m-%d_%H%M%S'))

    # Parse parameters
    parser = argparse.ArgumentParser(description='Integration tests for ibllib.')
    parser.add_argument('--commit', '-c', default=version,
                        help='commit id.  If none provided record isn''t saved')
    parser.add_argument('--logdir', '-l', help='the log path', default=root)
    parser.add_argument('--repo', '-r', help='repo directory', default=repo_dir)
    parser.add_argument('--dry-run', help='gather tests without running', action='store_true')
    args = parser.parse_args()  # returns data from the options specified (echo)

    # Paths
    report_dir = Path(args.logdir).joinpath('reports', args.commit)
    # Create the reports tree if it doesn't already exist
    report_dir.mkdir(parents=True, exist_ok=True)
    db_file = Path(args.logdir, '.db.json')

    # Setup backup log (NB: the system output is also saved by the ci)
    logfile = report_dir / 'test_output.log'
    fh = RotatingFileHandler(logfile, maxBytes=(1048576 * 5))
    logger.addHandler(fh)
    logger.setLevel(logging.INFO)

    # Tests
    logger.info(Path(args.repo).joinpath('*'))
    result, cov, test_list = run_tests(dry_run=args.dry_run)

    # Generate report
    logger.info('Saving coverage report to %s', report_dir)

    total = generate_coverage_report(cov, report_dir, relative_to=Path(ibllib.__file__).parent,
                                     strict=not args.dry_run)

    # When running tests without a specific commit, exit without saving the result
    if args.commit is parser.get_default('commit'):
        exit(0)

    # Summarize the results of the tests and write results to the JSON file
    logger.info('Saving outcome to %s', db_file)
    status = 'success' if result.wasSuccessful() else 'failure'
    n_failed = len(result.failures) + len(result.errors)
    fail_str = f'{n_failed}/{result.testsRun} tests failed'
    description = 'All passed' if result.wasSuccessful() else fail_str
    # Save all test names if all passed, otherwise save those that failed and their error stack
    if n_failed > 0:
        details = [(list_tests(c), err) for c, err in result.failures + result.errors]
        logger.warning(description)
    else:
        details = list_tests(test_list)
        logger.info(description)
    print(*details, sep='\n')  # Print all tests for the log

    report = {
        'commit': args.commit + ('_dry-run' if args.dry_run else ''),
        'results': details,
        'status': status,
        'description': description,
        'coverage': total  # coverage usually updated by Node.js script
    }

    if db_file.exists():
        with open(db_file, 'r') as json_file:
            records = json.load(json_file)
        try:  # update existing
            idx = next(i for i, r in enumerate(records) if r['commit'] == args.commit)
            records[idx] = report
        except StopIteration:  # ...or append record
            records.append(report)
    else:
        records = [report]

    # Save record to file
    with open(db_file, 'w') as json_file:
        json.dump(records, json_file)
