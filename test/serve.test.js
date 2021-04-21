const fs = require('fs');
const path = require('path');
const nock = require('nock');  // for mocking outbound requests
const request = require('supertest');  // for mocking inbound requests
const sinon = require('sinon');  // for mocking local modules
const expect = require('chai').expect;
const assert = require('chai').assert;
const appAuth = require("@octokit/auth-app");

const APIError = require('../lib').APIError;
const { updateStatus, setAccessToken, eventCallback, srv, fetchCommit} = require('../serve');
const queue = require('../lib').queue;
const config = require('../config/config').settings;
const { token } = require('./fixtures/static');

const APP_ID = process.env.GITHUB_APP_IDENTIFIER;
const ENDPOINT = 'logs';  // The URL endpoint for fetching status check details
const SHA = 'cabe27e5c8b8cb7cdc4e152f1cf013a89adc7a71'

/**
 * This fixture ensures the `token` variable is not null.
 * Must be called before any other nock fixtures or else they will be reset.
 */
async function setToken() {
   const scope = nock('https://api.github.com');
   scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
        .reply(201, {id: APP_ID});
   scope.post(`/app/installations/${APP_ID}/access_tokens`)
        .reply(201, {
           token: '#t0k3N',
           permissions: {
              checks: "write",
              metadata: "read",
              contents: "read"
           },
        });
   await setAccessToken();
   nock.cleanAll()
}

/**
* This fixture injects the default null token via setAccessToken.
*/
async function resetToken() {
   const token_default = {'tokenType': null};
   const sandbox = sinon.createSandbox({
      useFakeTimers: {
        now: new Date(3000, 1, 1, 0, 0)
    }})
   sandbox.stub(appAuth, 'createAppAuth').returns(async () => token_default);
   try { await setAccessToken(); } catch (_) {}
   sandbox.restore();
}

/**
* This fixture injects the default null token via setAccessToken.
*/
async function mockToken(sandbox) {
   await setToken();  // Ensure App id set
   const token = {token: '#t0k3N'};
   return (sandbox || sinon).stub(appAuth, 'createAppAuth').returns(async () => token);
}


/**
 * This tests 'setAccessToken' which handles the app authentication.
 */
describe('setAccessToken', () => {
   var scope;  // Our server mock
   var clock;  // Our clock mock for replicable JWT
   const expiry = new Date(); // Date of token expiry

   before(async function () {
      expiry.setTime(expiry.getTime() + 60e3);  // 60s in the future
      // https://runkit.com/gr2m/reproducable-jwt
      clock = sinon.useFakeTimers({
         now: 0,
         toFake: ['Date']
      });
   });

   beforeEach(async function() {
      await resetToken();
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
         scope.done();
         done();
      });
   });

   it('test install ID cached', (done) => {
      // In this test we check that once the install ID is retrieved the app authentication is
      // skipped (only to re-auth as installation).
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
           .matchHeader('authorization', `bearer ${token}`)
           .reply(201, {id: APP_ID})
      scope.post(`/app/installations/${APP_ID}/access_tokens`)
           .once()  // Should be called once
           .matchHeader('authorization', `bearer ${token}`)
           .reply(201, {
              token: '#t0k3N',
              expires_at: expiry.toISOString(),  // expires in 60s
              permissions: {
                 checks: "write",
                 metadata: "read",
                 contents: "read"
              },
           });

      setAccessToken().then(async function () {
         await setAccessToken();
         scope.done();
         done();
      });
   });

   it('test token cached', (done) => {
      // In this test we restore the clocks and ignore the JWT token, instead we test that a new
      // token is not requested so long as the token hasn't expired
      clock.restore();
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
           .reply(201, {id: APP_ID});
      scope.post(`/app/installations/${APP_ID}/access_tokens`)
           .reply(201, {
              token: '#t0k3N',
              expires_at: expiry.toISOString(),
              permissions: {
                 checks: "write",
                 metadata: "read",
                 contents: "read"
              },
           });

      setAccessToken().then(async function () {
         await setAccessToken();
         scope.done();
         done();
      });
   });

   afterEach(() => {
      nock.cleanAll();
   });

   after(function(done) {
      clock.restore();
      resetToken().then(done);
   })
});


/**
 * This tests 'updateStatus' which handles updating the GitHub statues.
 */
describe('updateStatus', () => {
   var scope;  // Our server mock
   var spy;  // A spy for authentication
   var data;  // Some job data to update the status with

   beforeEach(async function() {
      // Mock for App.installationAccessToken
      scope = nock('https://api.github.com', {
         reqheaders: {
            accept: 'application/vnd.github.machine-man-preview+json',
         }
      });
      spy = await mockToken();
      data = {
         sha: SHA,
         owner: 'okonkwe',
         repo: 'borneo-function',
         status: 'success',
         description: ''
      };
   });

   afterEach(() => {
      nock.cleanAll();
   });

   it('updateStatus should post to given endpoint', (done) => {
      scope.post(`/repos/${data['owner']}/${data['repo']}/statuses/${data['sha']}`).reply(201);
      updateStatus(data).then(() => {
         expect(spy.calledOnce).true;
         scope.done();
         done();
      });
   });

   it('updateStatus should contain the correct data', (done) => {
      data.base = 'dcb375f0';
      data.description = 'Lorem ipsum '.repeat(13);  // Check max char
      data.context = 'ci/test';
      const uri = `/repos/${data['owner']}/${data['repo']}/statuses/${data['sha']}`;
      const url = `${process.env.WEBHOOK_PROXY_URL}/${ENDPOINT}/${data.sha}`;
      const requestBodyMatcher = (body) => {
         return body.state === data.status &&
                body.target_url === url + `/?module=${data['repo']}` &&
                body.description.length <= 140 &&
                body.context === data.context;
      };
      scope.post(uri, requestBodyMatcher)
           .matchHeader('authorization', 'token #t0k3N')
           .reply(201);

     // Run
      updateStatus(data, url).then(() => {
         expect(spy.calledOnce).true;
         scope.done();
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
describe('Github event handler callback', () => {
   var scope;  // Our server mock
   var evt;  // A payload event loaded from fixtures
   var sandbox;  // Sandbox for spying on queue
   const _events = JSON.parse(JSON.stringify(config['events']));  // Deep clone events

   before(function () {
      scope = nock('https://api.github.com', {
         reqheaders: {
            accept: 'application/vnd.github.machine-man-preview+json',
         }
      });
   });

   beforeEach(async function () {
      queue.process(async (_job, _done) => {})  // nop
      sandbox = sinon.createSandbox()
      await mockToken(sandbox);
      evt = JSON.parse(fs.readFileSync('./test/fixtures/pull_payload.json'));
   });

   it('test callback adds pending jobs', (done) => {
      let nCalls = 0;
      let pr = evt.pull_request;
      let post_uri = `/repos/${pr.head.repo.owner.login}/${pr.head.repo.name}/statuses/${pr.head.sha}`;
      let testable = body => {
         nCalls += 1;
         if (nCalls === 2) { done(); }
         return body.state === 'pending';
      };
      scope.post(post_uri, testable)
           .twice()
           .reply(201, {});

      // Ignore files check
      config.events['pull_request']['files_ignore'] = 'file1.txt';

      const get_uri = `/repos/${pr.head.repo.owner.login}/${pr.head.repo.name}/pulls/${pr.number}/files`;
      const payload = {
         files: [
            { filename: 'README.md' },
            { filename: 'file1.txt' }
         ]
      }
      scope.get(get_uri)
           .reply(200, payload);

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
         expect(data.routine).eq(config['routines']['*']);  // Check routine

         expect(data.context.startsWith(context.pop())).true;
         sandbox.assert.calledTwice(queue.add);
         expect(queue.pile.pop().data.force).true;

         scope.isDone();
      });
   });

   it('test event type error', (done) => {
      sandbox.spy(queue);
      eventCallback({payload: evt, event: 'page_build'}).then(() => {
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

   it('test push event', (done) => {
      let pr = {
         ref: config.events.push.ref_ignore,  // Should ignore this ref
         head_commit: { id: SHA },
         before: evt.pull_request.base.sha,
         repository: evt.repository,
         installation: evt.installation
      };
      sandbox.spy(queue);
      eventCallback({payload: pr, event: 'push'}).then(function() {
         sandbox.assert.notCalled(queue.add);  // Should have been skipped
         done();
      });
   });

   it('test files ignore', async () => {
      // Tests push event
      let p = {
         ref: 'foo',
         head_commit: { id: SHA },
         before: evt.pull_request.base.sha,
         repository: evt.repository,
         installation: evt.installation
      };
      config.events['push']['files_ignore'] = [
         '.*.md',
         'file1.txt'
      ];

      // Tests pull request synchronize
      evt.action = 'synchronize';
      evt.before = p.before;
      evt.after = SHA;
      config.events['pull_request']['files_ignore'] = config.events['push']['files_ignore'];

      // Tests pull request synchronize
      const uri = `/repos/${p.repository.owner.login}/${p.repository.name}/compare/${p.before}...${SHA}`;
      const payload = {
         files: [
            { filename: 'README.md' },
            { filename: 'file1.txt' }
         ]
      }
      scope.get(uri)
           .twice()
           .reply(200, payload);

      sandbox.spy(queue);
      await eventCallback({payload: p, event: 'push'});
      sandbox.assert.notCalled(queue.add);

      await eventCallback({payload: evt, event: 'pull_request'});
      sandbox.assert.notCalled(queue.add);
      scope.isDone();
   });

   it('expect catches error on get files', (done) => {
      var nCalls = 0;
      let pr = evt.pull_request;
      let post_uri = `/repos/${pr.head.repo.owner.login}/${pr.head.repo.name}/statuses/${pr.head.sha}`;
      let testable = body => {
         nCalls += 1;
         if (nCalls === 2) { done(); }
         return body.state === 'pending';
      };
      scope.post(post_uri, testable)
           .twice()
           .reply(201, {});

      // Ignore files check
      const get_uri = `/repos/${pr.head.repo.owner.login}/${pr.head.repo.name}/pulls/${pr.number}/files`;
      scope.get(get_uri)
           .reply(404, {});

      sandbox.spy(queue);
      eventCallback({payload: evt, event: 'pull_request'}).then(function() {
         expect(queue.pile.length).eq(2);  // Two jobs should have been added
         sandbox.assert.calledTwice(queue.add);
         scope.isDone();
      });
   });

   afterEach(function () {
      queue.pile = [];
      config.events = _events;
      sandbox.restore();
   });

   after(() => { nock.cleanAll(); });
});


/**
 * This tests the shields.io badge data request callback.  The badge data itself is tested by the
 * lib tests.  This tests the endpoint.
 */
describe('shields callback', () => {
   var scope;  // Our server mock
   var info;  // URI parameters
   var _routines = JSON.parse(JSON.stringify(config.routines));

   before(function () {
      scope = nock('https://api.github.com');
      queue.process(async (_job, _done) => {});  // nop
      queue.pile = [];  // ensure queue is empty
      info = {
         repo: 'Hello-World',
         owner: 'Codertocat',
         branch: 'develop'
      };
   });

   after(function () {
      delete queue.process;
      nock.cleanAll();
      queue.pile = [];  // ensure queue is empty
   });

   afterEach(function () {
      config.routines = _routines;
   });

   it('expect coverage response', (done) => {
      // Set up response to GitHub API query
      // GET /repos/:owner/:repo/branches/:branch
      scope.get(`/repos/${info.owner}/${info.repo}/branches/${info.branch}`)
           .reply(200, {
              ref: `ref/heads/${info.branch}`,
              commit: {
                 sha: SHA
              }
           });

      request(srv)
         .get(`/coverage/${info.repo}/${info.branch}`)
         .expect('Content-Type', 'application/json')
         .expect(200)
         .end(function (err, res) {
            scope.done();
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
      scope.get(`/repos/${info.owner}/${info.repo}/branches/${info.branch}`).reply(404);

      request(srv)
         .get(`/coverage/${info.repo}/${info.branch}`)
         .expect(404)
         .end(function (err) {
            scope.done();
            if (err) return done(err);
            done();
         });
   });

   // In order for this to work we need to clear the routine defaults from the settings
   it('expect context not found', done => {
      delete config.routines;
      request(srv)
         .get(`/unknown/${info.repo}/${info.branch}`)
         .expect(404)
         .end(function (err) {
            scope.isDone();
            done(err);
         });
   });

   it('expect job forced', done => {
      // Set up response to GitHub API query
      // GET /repos/:owner/:repo/git/refs/heads/:branch
      scope.get(`/repos/${info.owner}/${info.repo}/commits/${SHA}`)
           .reply(200, {
              ref: `ref/heads/${SHA}`,
              sha: SHA
           });

      request(srv)
         .get(`/coverage/${info.repo}/${SHA}?force=1`)
         .expect('Content-Type', 'application/json')
         .expect(201)
         .end(function (err, res) {
            scope.done();
            if (err) return done(err);
            expect(res.body).deep.keys([
               'schemaVersion',
               'label',
               'message',
               'color'
            ]);
            expect(queue.pile.length).eq(1);
            done();
         });
   });

});


/**
 * This tests the logs endpoint.  When provided a SHA it should read a log file and return
 * it as HTML.
 */
describe('logs endpoint', () => {
   var logData;  // The text in our log
   var scope;  // Our server mock
   var HTMLlog;  // Our HTML log page

   before(function () {
      queue.process(() => {});  // nop
      const log_path = path.join(config.dataPath, 'reports', SHA);
      logData = ['hello world', 'foobar'];
      scope = nock('https://api.github.com');
      let file = path.join(log_path, `std_output-${SHA.substr(0,7)}.log`);
      fs.mkdirSync(log_path, { recursive: true });
      fs.writeFileSync(file, logData[0]);
      fs.writeFileSync(path.join(log_path, 'test_output.log'), logData[1]);
      HTMLlog = fs.readFileSync('./public/log.html', 'utf8');
   });

   beforeEach(function () {
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/commits/${SHA}`)
           .reply(200, { sha: SHA });
      queue.pile = [];
   })

   it('expect HTML log', done => {
      request(srv)
         .get(`/log/${SHA}`)
         .expect(200)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).eq(HTMLlog);
            done();
         });
   });

   it('expect redirect to log', done => {
      request(srv)
         .get(`/${ENDPOINT}/${SHA}`)
         .expect(301)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains('Moved');
            expect(res.header.location).eq('/log/' + SHA);
            done();
         });
   });

   it('expect raw log', done => {
      request(srv)
         .get(`/${ENDPOINT}/raw/${SHA}`)
         .expect(200)
         .expect('X-CI-JobStatus', 'finished')
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains(logData[0]);
            done();
         });
   });

   it('expect running status', done => {
      queue.add({sha: SHA});
      request(srv)
         .get(`/${ENDPOINT}/raw/${SHA}`)
         .expect(200)
         .expect('X-CI-JobStatus', 'running')
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains(logData[0]);
            done();
         });
   });

   it('expect queued status', done => {
      queue.add({sha: SHA});
      queue.pile[0].running = false;
      request(srv)
         .get(`/${ENDPOINT}/raw/${SHA}`)
         .expect(200)
         .expect('X-CI-JobStatus', 'queued')
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains('waiting');
            done();
         });
   });

   it('expect type param', (done) => {
      request(srv)
         .get(`/${ENDPOINT}/raw/${SHA}?type=logger`)
         .expect(200)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains(logData[1]);
            done();
         });
   });

   it('expect not found', done => {
      let id = '1c33a6e2ac7d7fc098105b21a702e104e09767cf';
      request(srv)
         .get(`/${ENDPOINT}/raw/${id}`)
         .expect(404)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains(`${id} not found`)
            done();
         });
   });

   afterEach(() => {
      nock.cleanAll();
   });

   after(done => {
      sinon.restore();
      queue.pile = [];
      delete queue.process;
      const logDir = path.join(config.dataPath, 'reports');
      fs.rmdir(logDir, {recursive: true}, err => {
         if (err) throw err;
         done()
      });
   });

});


/**
 * This tests the fetchCommit function.  When provided an incomplete SHA or branch name, it should
 * return the full commit hash.
 */
describe('fetchCommit', () => {
   var scope;  // Our server mock

   before(function () {
      scope = nock('https://api.github.com');
   });

   after(function () {
      nock.cleanAll();
   });

   it('expect full SHA from short id', (done) => {
      const id = SHA.slice(0, 7);
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/commits/${id}`)
         .reply(200, {sha: SHA});
      // Check full ID returned
      fetchCommit(id)
         .then(id => {
            expect(id).eq(SHA);
            scope.done();
            done();
         });
   });

   it('expect full SHA from branch and module', (done) => {
      const branch = 'develop';
      const repo = 'foobar';
      scope.get(`/repos/${process.env.REPO_OWNER}/${repo}/branches/${branch}`)
           .reply(200, {
              commit: {
                 sha: SHA
              }
           });
      // Check full ID returned
      fetchCommit(branch, true, repo)
         .then(id => {
            expect(id).eq(SHA);
            scope.done();
            done();
         });
   });

});


/**
 * This tests the logs/records endpoint.  When provided a SHA it should return the corresponding
 * JSON record.
 */
describe('records endpoint', () => {
   var scope;  // Our server mock

   before(function () {
      scope = nock('https://api.github.com');
      queue.process(async (_job, _done) => {})  // nop
   });

   after(function () {
      queue.pile = [];
      delete queue.process;
   });

   after(function () {
      nock.cleanAll();
   });


   it('expect JSON log', (done) => {
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/commits/${SHA}`)
           .reply(200, { sha: SHA });
      // Check JSON record returned
      request(srv)
         .get(`/${ENDPOINT}/records/${SHA}`)
         .expect(200)
         .expect('Content-Type', 'application/json')
         .end(function (err, res) {
            if (err) return done(err);
            const record = JSON.parse(res.text);
            expect(record.commit).eq(SHA);
            scope.done();
            done();
         });
   });

   it('expect works with short id', (done) => {
      const id = SHA.slice(0, 7);
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/commits/${id}`)
           .reply(200, { sha: SHA } );
      // Check JSON record returned
      request(srv)
         .get(`/${ENDPOINT}/records/${id}`)
         .expect(200)
         .expect('Content-Type', 'application/json')
         .end(function (err, res) {
            if (err) return done(err);
            const record = JSON.parse(res.text);
            expect(record.commit).eq(SHA);
            scope.done();
            done();
         });
   });

   it('expect 404 on missing', (done) => {
      const id = SHA.replace('2', '3');
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/commits/${id}`)
           .reply(404);
      // Check JSON record returned
      request(srv)
         .get(`/${ENDPOINT}/records/${id}`)
         .expect(404)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains('not found');
            scope.done();
            done();
         });
   });

   it('expect 500 on error', (done) => {
      const id = SHA.replace('2', '3');
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/commits/${id}`)
           .reply(500);
      // Check JSON record returned
      request(srv)
         .get(`/${ENDPOINT}/records/${id}`)
         .expect(500)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains('Failed');
            done();
         });
   });

   it('expect queued job data', (done) => {
      const id = SHA.replace('2', '3');
      scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/commits/${id}`)
           .reply(200, { sha: id } );
      queue.add( {sha: id, status: 'pending'} );
      // Check JSON record returned
      request(srv)
         .get(`/${ENDPOINT}/records/${id}`)
         .expect(200)
         .end(function (err, res) {
            if (err) return done(err);
            expect(res.text).contains('pending');
            done();
         });
   });

   it('expect works with branch and module', (done) => {
      const branch = 'develop';
      const repo = 'foobar';
      scope.get(`/repos/${process.env.REPO_OWNER}/${repo}/branches/${branch}`)
           .reply(200, {
              commit: {
                 sha: SHA
              }
           });
      // Check JSON record returned
      request(srv)
         .get(`/${ENDPOINT}/records/${branch}?module=${repo}`)
         .expect(200)
         .expect('Content-Type', 'application/json')
         .end(function (err, res) {
            if (err) return done(err);
            const record = JSON.parse(res.text);
            expect(record.commit).eq(SHA);
            scope.done();
            done();
         });
   });

});


/**
 * This tests the jobs endpoint.  This endpoint should return the jobs pile.
 */
describe('jobs endpoint', () => {

   before(function () {
      queue.process(async (_job, _done) => {})  // nop
   });

   after(function () {
      queue.pile = [];
      delete queue.process;
   });

   it('expect queue JSON', (done) => {
      queue.add({sha: SHA, status: 'pending', context: 'continuous-integration'});
      queue.add({sha: SHA, status: 'pending', context: 'coverage'});
      // Check JSON record returned
      request(srv)
         .get('/jobs')
         .expect(200)
         .expect('Content-Type', 'application/json')
         .end(function (err, res) {
            if (err) return done(err);
            const payload = JSON.parse(res.text);
            expect(payload.total).eq(2);
            expect(payload.pile[0].running).true;
            expect(payload.pile[1].running).false;
            expect(payload.pile[0]._child).undefined;
            done();
         });
   });
});


/**
 * This tests the coverage endpoint.  Directly accessing endpoint should return 403.
 */
describe('coverage endpoint', () => {

   before(function(done) {
      let reportsDir = path.join(config.dataPath, 'reports', SHA);
      fs.mkdir(reportsDir, { recursive: true }, async (err) => {
         if (err) throw err;
         await fs.writeFile(path.join(reportsDir, 'foobar.log'), '', (err) => { if (err) throw err; })
         await fs.writeFile(path.join(reportsDir, 'index.html'), '', (err) => { if (err) throw err; })
         done()
      });
   })

   it('expect root not found', (done) => {
      request(srv)
         .get(`/${ENDPOINT}/coverage/`)  // trailing slash essential
         .expect(404)
         .end(err => {
            err? done(err) : done();
         });
   });

   it('expect dir to be served', (done) => {
      request(srv)
         .get(`/${ENDPOINT}/coverage/${SHA}/`)  // trailing slash essential
         .expect(200)
         .end(function (err) {
            err? done(err) : done();
         });
   });

   after(done => {
      fs.rmdir(path.join(config.dataPath, 'reports'), {recursive: true}, err => {
         if (err) throw err;
         done()
      })

   })
});


/**
 * This tests the srv github endpoint.
 * @todo Check for log close on exit
 */
describe('srv github/', () => {
   var scope;  // Our server mock
   var spy;  // Token AppAuth spy

   beforeEach(async function() {
      // Mock for App.installationAccessToken
      spy = await mockToken();
      scope = nock('https://api.github.com', {
         reqheaders: {
            accept: 'application/vnd.github.machine-man-preview+json',
         }
      });
   });

   it('expect skipped', (done) => {
      request(srv)
         .post(`/github`)  // trailing slash essential
         .set({'X-GitHub-Event': 'issues'})
         .end(function (err) {
            expect(spy.called).false;
            err ? done(err) : done();
         });
   });

   it('expect error caught', (done) => {
      request(srv)
         .post(`/github`)  // trailing slash essential
         .set({
            'X-GitHub-Event': 'check_suite',
            'x-github-hook-installation-target-id': process.env.GITHUB_APP_IDENTIFIER,
            'X-Hub-Signature': {'sha': null},
            'X-GitHub-Delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958'
         })
         .end(function (err) {
            expect(err).is.null;  // Should have caught error
            done()
         });
   });

   /**
    * This is already covered by the setAccessToken test...
    */
   it('expect token set', (done) => {
      // Although the blob signature won't match, we can at least test that setAccessToken was called
      request(srv)
         .post(`/github`)  // trailing slash essential
         .set({
            'X-GitHub-Event': 'push',
            'x-github-hook-installation-target-id': process.env.GITHUB_APP_IDENTIFIER,
            'X-Hub-Signature': {'sha': SHA},
            'X-GitHub-Delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958'
         })
         .end(function (err) {
            expect(scope.pendingMocks().length).lt(2);  // setAccessToken was called
            err ? done(err) : done();
         });
   });

   afterEach(function () {
      nock.cleanAll()
   });

   afterEach(function () {
      spy.restore();
      nock.cleanAll();
   });

});


/**
 * This tests the callback for the job finish event.  Here the status should be updated depending
 * on the job data.  If the done callback resolves with an error, the state should be error,
 * regardless of job data.
 */
describe('queue finish callback', () => {
   var scope;  // Our server mock
   var spy;  // A spy for authentication

   before(async function() {
      scope = nock('https://api.github.com');
      spy = await mockToken();
   });

   it('test error handling', (done) => {
      queue.process(async (job) => { job.done(new Error('foobar')); })  // Raise error
      queue.on('error', _ => {});  // Error to be handles in finish callback
      const data = {
         sha: SHA,
         skipPost: false,
         context: 'coverage',
         status: 'success',
      };
      const uri = `/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/statuses/${data['sha']}`;
      const requestBodyMatcher = (body) => {
         expect(body.state).eq('error');
         expect(body.description).eq('foobar');
         expect(body.context).eq(data['context']);
         expect(body.target_url).empty;  // URL empty on errors
         done();
         return queue.pile.length === 0;
      };
      scope.post(uri, requestBodyMatcher).reply(201);
      queue.add(data);  // Create new job to process
   });

   after(function() {
      delete queue.process;
      nock.cleanAll();
      spy.restore();
   });
});
