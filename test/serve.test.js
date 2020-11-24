const fs = require('fs');
const path = require('path');
const nock = require('nock');  // for mocking outbound requests
const request = require('supertest')  // for mocking inbound requests
const sinon = require('sinon');  // for mocking local modules
const expect = require('chai').expect
const assert = require('chai').assert

const APIError = require('../lib').APIError
const { updateStatus, setAccessToken, eventCallback, srv } = require('../serve');
const queue = require('../lib').queue
const config = require('../config/config').settings

// Create a constant JWT
const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjAsImV4cCI6NTcwLCJpc3MiOiIxMjMifQ' +
              '.neOGz56XYH8Old443UkRFm_qrejJIRO2O6ruqWxPxaxLjXQhUajRdXRTxupB5n63hDtGssnXge6_64' +
              'GTCg_jx3RXfYSjbDz-43q2Bg7oczmQJzV8rq1TXrcmHJUULoZZS5-ChqGsWNnx5PsYJvHs84liZ8yWF' +
              'oe4V_2Noq8kVbRY2kP1eQV1ivZmm9nuiXMbqcoPpU-JdmHsOd78GdjcgqQNaWNwz9CAHGyU5vFoHVNf' +
              'oaRoL3QzjsZfdme5FWauujaAbeRVbWsmmWinynWlj2nYKTv3oW6L1w_TyRdwR5u_w4HoaCTvF7YcQD_' +
              'B1pFYE7nzLp6ZZ-yeotjMEB_8gw';
const APP_ID = process.env.GITHUB_APP_IDENTIFIER;
const ENDPOINT = 'logs';  // The URL endpoint for fetching status check details
const SHA = 'cabe27e5c8b8cb7cdc4e152f1cf013a89adc7a71'


/**
 * This tests 'setAccessToken', 'updateStatus' which handle the app authentication and updating
 * checks (the only time permissions are required).
 */
describe("Github handlers", () => {
   var scope;  // Our server mock
   var clock;  // Our clock mock for replicable JWT

   before(function() {
      // https://runkit.com/gr2m/reproducable-jwt
      clock = sinon.useFakeTimers({
         now: 0,
         toFake: ['Date']
      });
   })

   beforeEach(function() {
      // Mock for App.installationAccessToken
      scope = nock('https://api.github.com', {
         reqheaders: {
            accept: 'application/vnd.github.machine-man-preview+json',
         }
      });
   });

   it('test setAccessToken', (done) => {
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
           .matchHeader('authorization', `bearer ${token}`)
           .reply(201, {id: APP_ID});
      scope.post(`/app/installations/${APP_ID}/access_tokens`)
           .matchHeader('authorization', `bearer ${token}`)
           .reply(201, {token: '#t0k3N'});

      setAccessToken().then(function () {
         scope.isDone();
         done();
      });
   });

   it('updateStatus should post to given endpoint', (done) => {
     const data = {
        sha: SHA,
        owner: 'okonkwe',
        repo: 'borneo-function',
        status: 'success',
        description: ''
     };
     scope.post(`/repos/${data['owner']}/${data['repo']}/statuses/${data['sha']}`).reply(201);
     updateStatus(data).then(() => {
        scope.isDone();
        done();
     });

   });

   it('updateStatus should contain the correct data', (done) => {
     scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
          .matchHeader('authorization', `bearer ${token}`)
          .reply(201, {id: APP_ID})
          .post(`/app/installations/${APP_ID}/access_tokens`)
          .matchHeader('authorization', `bearer ${token}`)
          .reply(201, {token: '#t0k3N'});

     const data = {
        sha: '9f4f7948',
        base: 'dcb375f0',
        owner: 'okonkwe',
        repo: 'borneo-function',
        status: 'pending',
        description: 'Lorem ipsum '.repeat(13),  // Check max char
        context: 'ci/test'
     };
     const uri = `/repos/${data['owner']}/${data['repo']}/statuses/${data['sha']}`;
     const requestBodyMatcher = (body) => {
        return body.state === data.status &&
               body.target_url === `${process.env.WEBHOOK_PROXY_URL}/${ENDPOINT}/${data.sha}` &&
               body.description.length <= 140 &&
               body.context === data.context;
     };
     scope.post(uri, requestBodyMatcher)
          .matchHeader('authorization', 'token #t0k3N')
          .reply(201);

     // Run
     setAccessToken().then(() => {
        updateStatus(data).then(() => {
           scope.isDone();
           done();
        });
     });
   });

   it('updateStatus should validate data', (done) => {
      expect(() => updateStatus({sha: null})).to.throw(ReferenceError, 'SHA');
      let testable = () => updateStatus({status: 'working', sha: SHA});
      expect(testable).to.throw(APIError, 'status');
      scope.isDone();
      done();
   });

   after(function() {
      clock.restore();
   });
});


/**
 * This tests the main event callback, called when a check request comes in.  We expect the
 * callback to check whether the event is configured in the settings and if so, should update the
 * check status to pending for each context, and add each job to the queue.
 */
describe("Github event handler callback", () => {
   var scope;  // Our server mock
   var evt;  // A payload event loaded from fixtures
   var sandbox;  // Sandbox for spying on queue

   before(function () {
      scope = nock('https://api.github.com', {
         reqheaders: {
            accept: 'application/vnd.github.machine-man-preview+json',
         }
      });
   });

   beforeEach(function () {
      queue.process(async (_job, _done) => {})  // nop
      sandbox = sinon.createSandbox()
      evt = JSON.parse(fs.readFileSync('./test/fixtures/pull_payload.json'));
   });

   it('test callback adds pending jobs', (done) => {
      let pr = evt.pull_request;
      let uri = `/repos/${pr.head.repo.owner.login}/${pr.head.repo.name}/statuses/${pr.head.sha}`;
      scope.post(uri, body => { return body.state === 'pending'})
           .twice()
           .reply(201, {});
      sandbox.spy(queue);
      eventCallback({payload: evt, event: 'pull_request'}).then(function() {
         expect(queue.pile.length).eq(2);  // Two jobs should have been added
         let data = queue.pile.pop().data;  // Last added
         let context = config.events.pull_request.checks;
         expect(data.sha).eq(pr.head.sha);  // Check head commit set
         expect(data.base).eq(pr.base.sha);  // Check base commit set
         expect(data.force).not.true;  // Check force is false (the previous job will save its results)
         expect(data.owner).eq(pr.head.repo.owner.login);  // Check repo owner set
         expect(data.repo).eq(pr.head.repo.name);  // Check repo name set

         expect(data.context.startsWith(context.pop())).true;
         sandbox.assert.calledTwice(queue.add);
         expect(queue.pile.pop().data.force).true;

         scope.isDone();
         done();
      });
   });

   it('test event type error', (done) => {
      sandbox.spy(queue);
      eventCallback({payload: evt, event: 'issue'}).then(() => {
        done(new Error('Expected method to reject.'));
      })
      .catch((err) => {
         sandbox.assert.notCalled(queue.add);
         assert.instanceOf(err, TypeError);
         done();
      });
   });

   it('test fork', (done) => {
      sandbox.spy(queue);
      evt.pull_request.head.repo.owner.login = 'k1o0';
      let eventData = {payload: evt, event: 'pull_request'};
      eventCallback(eventData).then(() => {
        done(new Error('Expected method to reject.'));
      })
      .catch((err) => {
         sandbox.assert.notCalled(queue.add);
         assert.instanceOf(err, ReferenceError);
         done();
      });
   });

   afterEach(function () {
      queue.pile = [];
      sandbox.restore();
   });
});


/**
 * This tests the shields.io badge data request callback.  The badge data itself is tested by the
 * lib tests.  This tests the endpoint.
 */
describe('shields callback', () => {
   var scope;  // Our server mock
   var info;  // URI parameters

   before(function () {
      scope = nock('https://api.github.com');
      queue.process(async (_job, _done) => {});  // nop
      info = {
         repo: 'Hello-World',
         owner: 'Codertocat',
         branch: 'develop'
      };
   });

   it('expect coverage response', (done) => {
      // Set up response to GitHub API query
      // GET /repos/:owner/:repo/git/refs/heads/:branch
      scope.get(`/repos/${info.owner}/${info.repo}/git/refs/heads/${info.branch}`)
           .reply(200, {
              ref: `ref/heads/${info.branch}`,
              object: {
                 sha: SHA
              }
           });

      request(srv)
         .get(`/coverage/${info.repo}/${info.branch}`)
         .expect('Content-Type', 'application/json')
         .expect(200)
         .end(function (err, res) {
            scope.isDone();
            if (err) return done(err);
            expect(res.body).deep.keys([
               'schemaVersion',
               'label',
               'message',
               'color'
            ]);
            done();
         });
   });

   it('expect errors', (done) => {
      // Set up response to GitHub API query
      scope.get(`/repos/${info.owner}/${info.repo}/git/refs/heads/${info.branch}`).reply(404);

      request(srv)
         .get(`/coverage/${info.repo}/${info.branch}`)
         .expect(404)
         .end(function (err) {
            scope.isDone();
            if (err) return done(err);
            done();
         });
   });

});


/**
 * This tests the logs endpoint endpoint.  When provided a SHA it should read a log file and return
 * it as HTML.
 */
describe('logs endpoint', () => {
   var stub;  // Our fs stub
   var logData;  // The text in our log

   before(function () {
      const logFile = path.join(config.dataPath, 'reports', SHA, `std_output-${SHA.substr(0,7)}.log`);
      logData = 'hello world';
      stub = sinon
         .stub(fs, 'readFile')
         .withArgs(logFile, 'utf8')
         .yieldsAsync(null, logData);
   });

   it('expect HTML log', (done) => {
      request(srv)
         .get(`/${ENDPOINT}/${SHA}`)
         .expect(200)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains(logData)
            expect(res.text).to.match(/^<html.*>.+<\/html>$/)
            done();
         });
   });

   it('expect not found', (done) => {
      sinon.restore();
      request(srv)
         .get(`/${ENDPOINT}/${SHA}`)
         .expect(404)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains(`${SHA} not found`)
            done();
         });
   });
});


/**
 * This tests the coverage endpoint endpoint.  Directly accessing endpoint should return 403.
 */
xdescribe('coverage endpoint', () => {

   before(function() {
      let reportsDir = path.join(config.dataPath, 'reports');
      fs.mkdir(reportsDir, (err) => {
         if (err) throw err;
         fs.writeFile(path.join(reportsDir, 'foobar.log'), '', (err) => { if (err) throw err; })
      });
   })

   it('expect forbidden', (done) => {
      request(srv)
         .get(`/${ENDPOINT}/coverage`)
         .expect(403)
         .end(function (err) {
            err? done(err) : done();
         });
   });

   after(function() {
      fs.rmdir(path.join(config.dataPath, 'reports'), {recursive: true}, err => {
         if (err) throw err;
      })

   })
});
