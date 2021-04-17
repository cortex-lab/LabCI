const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const expect = require('chai').expect;

const Coverage = require('../coverage');

const dummy_id = '1c33a6e2ac7d7fc098105b21a702e104e09767cf';


describe('Test coverage parser:', function() {
    var testable;
    var sandbox;
      // Check NODE_ENV is correctly set, meaning our imported settings will be test ones
    beforeEach(function () {
        let md5 = '385a5d56850127317c317b0f66e91078';
        let code = 'line1\nline2\n\rline3\n\rline4';
        testable = function(obj, done) {
            expect([496, 63]).to.include(obj.source_files.length);
            let file = obj.source_files[0];
            expect(file).to.have.all.keys('name', 'source_digest', 'coverage');
            expect(file['source_digest']).to.eq(md5);
            done();
        };
        sandbox = sinon.createSandbox();
        sandbox
            .stub(fs, 'readFileSync')
            .withArgs(sinon.match((x) => x.replace('\\', '/').startsWith('C:/Hello-World')))
            .returns(code);
        fs.readFileSync.callThrough();
    })

    it('Check loading MATLAB', function (done) {
        let xmlPath = path.resolve('test', 'fixtures', 'CoverageResults.mat.xml')
        Coverage(xmlPath, 'Hello-World', dummy_id, [], obj => testable(obj, done) );
    });

    it('Check loading Python', function (done) {
        let xmlPath = path.resolve('test', 'fixtures', 'CoverageResults.py.xml')
        Coverage(xmlPath, 'Hello-World', dummy_id, [], obj => testable(obj, done) );
    });

    afterEach(function () { sandbox.restore(); });
});
