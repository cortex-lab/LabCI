import argparse
import unittest
import re
import json
import logging
from logging.handlers import RotatingFileHandler
from os import sep
from pathlib import Path
from typing import Iterable, List

from coverage import Coverage

import ibllib
from ibllib.misc.flatten import flatten
from ibllib.misc.version import ibllib as ver
from datetime import datetime

logger = logging.getLogger('ibllib')


def list_tests(suite: unittest.TestSuite) -> List[str]:
    """
    Returns a full list of the tests run in the format 'TestClassName/test_method'
    :param suite: A TestSuite instance, or list thereof
    :return:
    """
    if isinstance(suite, list):
        return flatten([list_tests(x) for x in suite])
    elif not unittest.suite._isnotsuite(suite):
        return list_tests(suite._tests)
    else:
        return f'{suite.__class__.__name__}/{suite._testMethodName}'


def run_tests(coverage_source: Iterable = None) -> (unittest.TestResult, Coverage):
    """
    Run integration tests
    :param coverage_source: An iterable of source directory path strings for recording code
    coverage
    :return: Test results and coverage objects
    """
    # Coverage recorded for all code within the source directory; otherwise just omit some
    # common pyCharm files
    # TODO Omit tests themselves
    options = {'omit': ['*pydevd_file_utils.py', 'test_*'], 'source': coverage_source}
    cov = Coverage(**options)
    cov.start()
    # cov = None
    # Gather tests
    # test_dir = str(Path(__file__).parent.absolute().joinpath('tests'))  # FIXME Called from wrong directory
    test_dir = str(Path(__file__).absolute().parents[1].joinpath('iblscripts', 'ci', 'tests'))
    # logger.info(test_dir)
    logger.info(test_dir)
    ci_tests = unittest.TestLoader().discover(test_dir, pattern='test_*')
    # _tests = unittest.TestLoader().discover(str(Path(ibllib.__file__).parent.parent),
    #                                         pattern='test_*')  # Fuck it we'll hard code it
    result = unittest.TextTestRunner(verbosity=2).run(ci_tests)

    cov.stop()
    cov.save()

    return result, cov


if __name__ == "__main__":
    """Run all the integration tests with coverage
    python runAllTests.py --logdir <log directory> --commit <commit sha> --repo <repo path>
    """
    # logfile = Path(__file__).parent.joinpath('tests.log')
    root = Path(__file__).parent.absolute()  # Default root folder
    repo_dir = Path(ibllib.__file__).parent  # Default repository source for coverage
    version = ver()
    if not version or version == 'unversioned':
        getattr(ibllib, '__version__', datetime.now().strftime('%Y-%m-%d_%H%M%S'))

    # Parse parameters
    parser = argparse.ArgumentParser(description='Integration tests for ibllib.')
    parser.add_argument('--commit', '-c', help='commit id', default=version)
    parser.add_argument('--logdir', '-l', help='the log path', default=root)
    parser.add_argument('--repo', '-r', help='repo directory', default=repo_dir)
    args = parser.parse_args()  # returns data from the options specified (echo)

    # Paths
    report_dir = Path(args.logdir).joinpath('reports', args.commit)
    # Create the reports tree if it doesn't already exist
    report_dir.mkdir(parents=True, exist_ok=True)
    logfile = report_dir / 'test_output.log'
    db_file = Path(args.logdir, '.db.json')

    fh = RotatingFileHandler(logfile, maxBytes=(1048576 * 5))  # FIXME no need to save log
    logger.addHandler(fh)
    logger.setLevel(logging.INFO)

    # Tests
    logger.info(args.repo.joinpath('*'))
    result, cov = run_tests(coverage_source=[str(args.repo)])

    # Generate report  TODO Reports directory from config file
    logger.info('Saving coverage report to %s', report_dir)
    total = cov.html_report(directory=str(report_dir))
    cov.xml_report(outfile=str(report_dir.joinpath('CoverageResults.xml')))
    assert report_dir.joinpath('CoverageResults.xml').exists(), 'failed to generate XML coverage'

    # Rename the HTML files; this is to obscure the server's directory structure when serving files
    pattern = re.sub(r'^[a-zA-Z]:[/\\]|[/\\]', '_', str(repo_dir.parent)) + '_'  # slash -> _
    for file in report_dir.glob('*.html'):  # Open each html report file
        with open(file, 'r') as f:
            data = f.read()
            data = data.replace(pattern, '')  # Remove long paths in filename links
            data = data.replace(str(repo_dir.parent) + sep, '')  # Remove from text
        with open(file, 'w') as f:
            f.write(data)  # Write back into file
        file.rename(str(file).replace(pattern, ''))  # Rename file

    if args.commit is parser.get_default('commit'):
        exit(0)

    # TODO Save test info
    # TODO JSON path from config file
    # Summarize the results of the tests and write results to the JSON file
    status = 'success' if result.wasSuccessful() else 'failure'
    n_failed = len(result.failures) + len(result.errors)
    fail_str = f'{n_failed}/{result.testsRun} tests failed'
    description = 'All passed' if result.wasSuccessful() else fail_str

    report = {
        'commit': args.commit,
        'results': [],  # result.failures + result.errors,  # TODO make serializable
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
