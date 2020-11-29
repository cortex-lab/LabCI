const fs = require('fs');
const cp = require('child_process');
const events = require('events');
const path = require('path');
const nock = require('nock');  // for mocking outbound requests
const request = require('supertest')  // for mocking inbound requests
const sinon = require('sinon');  // for mocking local modules
const expect = require('chai').expect
const assert = require('chai').assert
const appAuth = require("@octokit/auth-app");

const APIError = require('../lib').APIError
const { updateStatus, setAccessToken, eventCallback, srv, prepareEnv, runTests } = require('../serve');
const queue = require('../lib').queue
const config = require('../config/config').settings

// Create a constant JWT
const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOi0zMCwiZXhwIjo1NzAsImlzcyI6MTIzfQ' +
              '.Amivfieh9COk-89jINMvQh-LZtjLVT44aeulGNNZnFtHhFpNAg9gZGuf-LCjykHqQvibYPfPxD7L_d' +
              'J1t49LwhErHPRpRrs-vs3HoEVQpZMmdA1oLmCJkCC0PVP0c7nalx5wvLWHIx5hQCZ3aJfAwrH2xIaWJ' +
              'YhBKVIsR0J25O0_ouCD3JsoBu87xaTRH1yyv7COBFauBsFytkV4L0fFIVAarqPmQCWMRkEmQJn9lZZC' +
              'VLM8o9EEQibLmmeF2CF_rLeolHfLjZkYBMd9MGLPTnEbNbQiRpqqeVft0Hg2SJuKcpsKEilTVs20JdN' +
              'lY9eIUUDECsU6Mxoa-s_5ffWSHg';
const APP_ID = process.env.GITHUB_APP_IDENTIFIER;
const ENDPOINT = 'logs';  // The URL endpoint for fetching status check details
const SHA = 'cabe27e5c8b8cb7cdc4e152f1cf013a89adc7a71'


/**
 * This tests 'setAccessToken' which handles the app authentication.
 */
describe('setAccessToken', () => {
   var scope;  // Our server mock
   var clock;  // Our clock mock for replicable JWT

   beforeEach(function() {
      // https://runkit.com/gr2m/reproducable-jwt
      clock = sinon.useFakeTimers({
         now: 0,
         toFake: ['Date']
      });
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
           .reply(201, {
              token: '#t0k3N',
              permissions: {
                 checks: "write",
                 metadata: "read",
                 contents: "read"
              },
           });

      setAccessToken().then(function () {
         scope.isDone();
         done();
      });
   });

   it('test install ID cached', (done) => {
      // In this test we check that once the install ID is retrieved the app authentification is
      // skipped (only to re-auth as installation).
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
           .matchHeader('authorization', `bearer ${token}`)
           .reply(201, {id: APP_ID})
      scope.post(`/app/installations/${APP_ID}/access_tokens`)
           .twice()  // Should be called twice in a row
           .matchHeader('authorization', `bearer ${token}`)
           .reply(201, {
              token: '#t0k3N',
              expires_at: new Date('3000-12-30').toISOString(),
              permissions: {
                 checks: "write",
                 metadata: "read",
                 contents: "read"
              },
           });

      setAccessToken().then(async function () {
         await setAccessToken();
         scope.isDone();
         done();
      });
   });

   it('test token cached', (done) => {
      // In this test we restore the clocks and ignore the JWT token, instead we test that a new
      // token is not requested so long as the token hasn't expired
      clock.restore();
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
           .reply(201, {id: APP_ID})
      scope.post(`/app/installations/${APP_ID}/access_tokens`)
           .reply(201, {
              token: '#t0k3N',
              expires_at: new Date('3000-12-30').toISOString(),
              permissions: {
                 checks: "write",
                 metadata: "read",
                 contents: "read"
              },
           });

      setAccessToken().then(async function () {
         await setAccessToken();
         scope.isDone();
         done();
      });
   });

   after(function() {
      clock.restore();
   });
});


/**
 * This tests 'updateStatus' which handles updating the GitHub statues.
 */
describe("updateStatus", () => {
   var scope;  // Our server mock
   var spy;  // A spy for authentication
   var data;  // Some job data to update the status with

   beforeEach(function() {
      // Mock for App.installationAccessToken
      scope = nock('https://api.github.com', {
         reqheaders: {
            accept: 'application/vnd.github.machine-man-preview+json',
         }
      });
      const token = {token: '#t0k3N'};
      spy = sinon.stub(appAuth, 'createAppAuth').returns(async () => token);
      data = {
         sha: SHA,
         owner: 'okonkwe',
         repo: 'borneo-function',
         status: 'success',
         description: ''
      };
   });

   it('updateStatus should post to given endpoint', (done) => {
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
           .reply(201, {id: APP_ID});
      scope.post(`/repos/${data['owner']}/${data['repo']}/statuses/${data['sha']}`).reply(201);
      updateStatus(data).then(() => {
         expect(spy.calledOnce).true;
         scope.isDone();
         done();
      });
   });

   it('updateStatus should contain the correct data', (done) => {
      data.base = 'dcb375f0';
      data.description = 'Lorem ipsum '.repeat(13);  // Check max char
      data.context = 'ci/test';
      const uri = `/repos/${data['owner']}/${data['repo']}/statuses/${data['sha']}`;
      const url = `${process.env.WEBHOOK_PROXY_URL}/${ENDPOINT}/${data.sha}`;  // target URL
      const requestBodyMatcher = (body) => {
         return body.state === data.status &&
                body.target_url === url &&
                body.description.length <= 140 &&
                body.context === data.context;
      };
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
           .reply(201, {id: APP_ID});
      scope.post(uri, requestBodyMatcher)
           .matchHeader('authorization', 'token #t0k3N')
           .reply(201);

     // Run
      updateStatus(data, url).then(() => {
         expect(spy.calledOnce).true;
         scope.isDone();
         done();
      });
   });

   it('updateStatus should validate SHA', () => {
      return updateStatus({sha: null}).catch(err => {
         expect(err).to.be.instanceOf(ReferenceError);
         expect(err).to.have.property('message', 'undefined or invalid sha');
         expect(spy.called).false;
      });
   });

   it('updateStatus should validate status', () => {
      return updateStatus({status: 'working', sha: SHA}).catch(err => {
         expect(err).to.be.instanceOf(APIError);
         expect(err.message).to.contain('status');
         expect(spy.called).false;
      });
   });

   afterEach(function() {
      spy.restore();
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
 * This tests the coverage endpoint.  Directly accessing endpoint should return 403.
 */
describe('coverage endpoint', () => {

   before(function() {
      let reportsDir = path.join(config.dataPath, 'reports', SHA);
      fs.mkdir(reportsDir, { recursive: true }, (err) => {
         if (err) throw err;
         fs.writeFile(path.join(reportsDir, 'foobar.log'), '', (err) => { if (err) throw err; })
         fs.writeFile(path.join(reportsDir, 'index.html'), '', (err) => { if (err) throw err; })
      });
   })

   it('expect root not found', (done) => {
      request(srv)
         .get(`/${ENDPOINT}/coverage/`)  // trailing slash essential
         .expect(404)
         .end(function (err, res) {
            err? done(err) : done();
         });
   });

   it('expect dir served found', (done) => {
      request(srv)
         .get(`/${ENDPOINT}/coverage/${SHA}/`)  // trailing slash essential
         .expect(200)
         .end(function (err, res) {
            err? done(err) : done();
         });
   });

   after(function() {
      fs.rmdir(path.join(config.dataPath, 'reports'), {recursive: true}, err => {
         if (err) throw err;
      })

   })
});


/**
 * This tests the runtests and prepareEnv functions.
 */
describe('running tests', () => {
   var sandbox;  // Sandbox for spying on queue
   var stub;  // Main fileExec stub

   beforeEach(function () {
      queue.process(async (_job, _done) => {})  // nop
      sandbox = sinon.createSandbox()
      stub = sandbox.stub(cp, 'execFile');
      sandbox.stub(fs, 'createWriteStream');
      execEvent = new events.EventEmitter();
      execEvent.stdout = new events.EventEmitter();
      execEvent.stdout.pipe = sandbox.spy();
      stub.returns(execEvent);
   });

   it('test prepareEnv', async () => {
      const callback = sandbox.spy();
      stub.callsArgAsync(2, null, 'preparing', '');
      const job = {data: {sha: SHA}};
      await prepareEnv(job, callback);
      let log = path.join(config.dataPath, 'reports', SHA, 'std_output-cabe27e.log');
      let fn = path.resolve(path.join(__dirname, '..', 'prep_env.BAT'));
      stub.calledWith(fn, [SHA, config.repo, config.dataPath]);
      sandbox.assert.calledWith(fs.createWriteStream, log);
      expect(callback.calledOnce).true;
      expect(callback.calledOnceWithExactly(job)).true;
   });

   it('test prepareEnv with error', async (done) => {
      stub.callsArgWith(2, {code: 'ENOENT'}, 'preparing', '');
      const job = {
         data: {sha: SHA},
         done: (err) => {
            expect(err).instanceOf(Error);
            expect(err.message).to.have.string('not found');
            done();
         }
      };
      prepareEnv(job);
   });


   xit('test runtests', async (done) => {
      stub.callsArgWith(2, {code: 1}, 'running tests', 'Error in MATLAB_function line 23');
      const job = {
         data: {sha: SHA},
         done: (err) => {
            expect(err).instanceOf(Error);
            // expect(err.message.startswith('Error')).star   (Error);
            done();
         }
      };
      runTests(job);
   });

   it('test runtests with error', async (done) => {
      const errmsg = 'Error in MATLAB_function line 23';
      stub.callsArgWith(2, {code: 1}, 'running tests', errmsg);
      const job = {
         data: {sha: SHA},
         done: (err) => {
            expect(err).instanceOf(Error);
            expect(err.message).to.have.string(errmsg);
            done();
         }
      };
      prepareEnv(job);
   });

   afterEach(function () {
      queue.pile = [];
      sandbox.verifyAndRestore();
   });
});
