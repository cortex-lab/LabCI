const fs = require('fs');
const assert = require('assert');
const path = require('path');
const sinon = require('sinon');

const config = require('../config/config').settings;
const Coverage = require('../coverage');

const dummy_id = '1c33a6e2ac7d7fc098105b21a702e104e09767cf';


xdescribe('Test coverage parser:', function() {
    var testable;
      // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    before(function () {
        assert(process.env.NODE_ENV.startsWith('test'), 'Test run outside test env')
        testable = function(obj, done) {
            assert(obj.source_files);
            done();
        };
    })

    it('Check loading MATLAB', function (done) {
        let xmlPath = path.resolve('test', 'fixtures', 'CoverageResults.mat.xml')
        Coverage(xmlPath, 'rigbox', dummy_id, obj => testable(obj, done) );
    });

    it('Check loading Python', function (done) {
        let xmlPath = path.resolve('test', 'fixtures', 'CoverageResults.py.xml')
        Coverage(xmlPath, '', dummy_id, obj => testable(obj, done) );
    });
});


xdescribe('Test md5 file hash:', function() {
    // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    before(function () {
        assert(process.env.NODE_ENV.startsWith('test'), 'Test run outside test env');
    });

    it('MD5 should return correct hash', function (done) {
        let test_path = './path/to/file.mat';
        let stub = sinon.stub(fs, 'readFileSync')
            .withArgs(test_path)
            .returns('line1\nline2\n\rline3\n\rline4');
    });
});
