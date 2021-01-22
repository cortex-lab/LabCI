const stdErr = `Traceback (most recent call last):\n
  File \"runAllTests.py\", line 65, in <module>\n
    result, cov = run_tests()\n
  File \"runAllTests.py\", line 37, in run_tests\n
    tests = unittest.TestLoader().discover(test_dir, pattern='test_testing*')\n
  File \"C:\\Users\\User\\Anaconda3\\envs\\iblenv\\lib\\unittest\\loader.py\", line 349, in discover\n
    tests = list(self._find_tests(start_dir, pattern))\n
  File \"C:\\Users\\User\\Anaconda3\\envs\\iblenv\\lib\\unittest\\loader.py\", line 406, in _find_tests\n
    full_path, pattern, namespace)\n
  File \"C:\\Users\\User\\Anaconda3\\envs\\iblenv\\lib\\unittest\\loader.py\", line 460, in _find_test_path\n
    return self.loadTestsFromModule(module, pattern=pattern), False\n
  File \"C:\\Users\\User\\Anaconda3\\envs\\iblenv\\lib\\unittest\\loader.py\", line 124, in loadTestsFromModule\n
    tests.append(self.loadTestsFromTestCase(obj))\n
  File \"C:\\Users\\User\\Anaconda3\\envs\\iblenv\\lib\\unittest\\loader.py\", line 93, in loadTestsFromTestCase\n
    loaded_suite = self.suiteClass(map(testCaseClass, testCaseNames))\n
  File \"C:\\Users\\User\\Anaconda3\\envs\\iblenv\\lib\\unittest\\suite.py\", line 24, in __init__\n
    self.addTests(tests)\n
  File \"C:\\Users\\User\\Anaconda3\\envs\\iblenv\\lib\\unittest\\suite.py\", line 57, in addTests\n
    for test in tests:\n
  File \"C:\\Users\\User\\Documents\\Python Scripts\\iblscripts-repo\\iblscripts\\tests\\base.py\", line 25, in __init__\n
    raise FileNotFoundError(f'Invalid data root folder {self.data_path.absolute()}\\n\\t'\n
FileNotFoundError: Invalid data root folder E:\\FlatIron\\integration\n
        must contain a \"Subjects_init\" folder\n`;

// Create a constant JWT
const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOi0zMCwiZXhwIjo1NzAsImlzcyI6MTIzfQ' +
              '.Amivfieh9COk-89jINMvQh-LZtjLVT44aeulGNNZnFtHhFpNAg9gZGuf-LCjykHqQvibYPfPxD7L_d' +
              'J1t49LwhErHPRpRrs-vs3HoEVQpZMmdA1oLmCJkCC0PVP0c7nalx5wvLWHIx5hQCZ3aJfAwrH2xIaWJ' +
              'YhBKVIsR0J25O0_ouCD3JsoBu87xaTRH1yyv7COBFauBsFytkV4L0fFIVAarqPmQCWMRkEmQJn9lZZC' +
              'VLM8o9EEQibLmmeF2CF_rLeolHfLjZkYBMd9MGLPTnEbNbQiRpqqeVft0Hg2SJuKcpsKEilTVs20JdN' +
              'lY9eIUUDECsU6Mxoa-s_5ffWSHg';

module.exports = { stdErr, token };
