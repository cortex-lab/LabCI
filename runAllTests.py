import sys; print('Python %s on %s' % (sys.version, sys.platform))
sys.path.extend(['C:\\Users\\User\\Documents\\Python Scripts\\iblscripts-repo', 'C:/Users/User/Documents/Python Scripts/iblscripts-repo'])

import argparse
import unittest
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

import coverage

import ibllib
from ibllib.misc.flatten import flatten
from datetime import datetime

logger = logging.getLogger('ibllib')


def list_tests(s):
    if isinstance(s, list):
        return flatten([list_tests(x) for x in s])
    elif not unittest.suite._isnotsuite(s):
        return list_tests(s._tests)
    else:
        return f'{s.__class__.__name__}/{s._testMethodName}'


def run_tests(coverage_source=None):
    # Coverage recorded for all code within the source directory; otherwise just omit some
    # common pyCharm files
    options = {'source': coverage_source} if coverage_source else {'omit': '*pydevd_file_utils.py'}
    cov = coverage.Coverage(**options)
    # if coverage_source:
    #     cov = coverage.Coverage()
    #     # Coverage recorded for all code within the source directory
    #     cov.set_option('run:source', coverage_source)
    # else:
    #     # Omit some common pyCharm files
    #     cov = coverage.Coverage(omit='*pydevd_file_utils.py')
    cov.start()
    # cov = None
    # Gather tests
    test_dir = str(Path(__file__).parent.absolute().joinpath('tests'))  # FIXME Called from wrong directory
    test_dir = r'C:\Users\User\Documents\Python Scripts\iblscripts-repo\iblscripts\tests'
    tests = unittest.TestLoader().discover(test_dir, pattern='test_testing*')
    result = unittest.TextTestRunner(verbosity=2).run(tests)

    cov.stop()
    cov.save()

    return result, cov


if __name__ == "__main__":
    """Run all the integration tests with coverage
    python runAllTests.py --logfile 
    """
    # logfile = Path(__file__).parent.joinpath('tests.log')
    root = Path(__file__).parent.absolute()  # Default root folder
    repo_dir = Path(ibllib.__file__).parent  # Default repository source for coverage
    version = getattr(ibllib, '__version__', datetime.now().strftime('%Y-%m-%d_%H%M%S'))

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
    result, cov = run_tests(coverage_source=args.repo)

    # Generate report  TODO Reports directory from config file

    logger.info('Saving coverage report to %s', report_dir)
    total = cov.html_report(directory=str(report_dir))
    cov.xml_report(outfile=str(report_dir.joinpath('CoverageResults.xml')))
    assert report_dir.joinpath('CoverageResults.xml').exists(), 'failed to generate XML coverage'

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
        'results': [], # result.failures + result.errors,  # TODO make serializable
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
