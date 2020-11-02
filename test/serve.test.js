const fs = require('fs');
const nock = require('nock');
const sinon = require('sinon');
const expect = require('chai').expect
const assert = require('chai').assert

const APIError = require('../lib').APIError
const { updateStatus, setAccessToken, eventCallback } = require('../serve');
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
        sha: '9f4f7948',
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
               body.target_url === `${process.env.WEBHOOK_PROXY_URL}/events/${data.sha}` &&
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
      let testable = () => updateStatus({status: 'working', sha: 'h67t8tg66g'});
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
