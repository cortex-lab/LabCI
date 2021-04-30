/**
 * Tests for the main module.  These are full stack tests.
 * @author Miles Wells <miles.wells@ucl.ac.uk>
 * @requires ./queue.js
 * @requires module:mocha
 * @requires module:chai
 */
const fs = require('fs');
const cp = require('child_process');
const events = require('events');

const nock = require('nock');  // for mocking outbound requests
const supertest = require('supertest');  // for mocking inbound requests
const sinon = require('sinon');  // for mocking local modules
const expect = require('chai').expect;
const assert = require('chai').assert;

const lib = require('../lib');
const queue = lib.queue;
const {handler, eventCallback, srv, prepareEnv, runTests} = require('../serve');
const {token} = require('./fixtures/static');
const config = require('../config/config').settings;

// Create a constant JWT // TODO put in static
const SHA = 'cabe27e5c8b8cb7cdc4e152f1cf013a89adc7a71';


/**
 * The hooks setup in main.js.
 */
function main() {
    const run = (job) => { prepareEnv(job, runTests); };
    queue.process((job) => { lib.shortCircuit(job, run); });
    handler.on('*', evt => eventCallback(evt));
    queue.on('error', _ => {});
    handler.on('error', function (err) {
        console.error('Error:', err.message);
    });
    process.on('unhandledRejection', (reason, p) => {
        console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
        console.log(reason.stack);
    });
    lib.openTunnel()
        .then(() => {
            // Start the server on same port as tunnel
            var server = srv.listen(config.listen_port, function () {
                let host = server.address().address;
                let port = server.address().port;

                console.log('Handler listening at http://%s:%s', host, port);
            });
        })
        .catch(e => { throw e; });
}

/**
 * TODO Document.
 */
xdescribe('Full stack', () => {
    var scope;  // Our server mock
    var clock;  // Our clock mock for replicable JWT
    var evt;  // A payload event loaded from fixtures
    var sandbox;  // Sandbox for spying on queue

    before(function () {
        const APP_ID = process.env.GITHUB_APP_IDENTIFIER;
        const evt = JSON.parse(fs.readFileSync('./test/fixtures/pull_payload.json'));
        // https://runkit.com/gr2m/reproducable-jwt
        clock = sinon.useFakeTimers({
            now: 0,
            toFake: ['Date']
        });
        // For outgoing requests
        scope = nock('https://api.github.com', {
            reqheaders: {
                accept: 'application/vnd.github.machine-man-preview+json'
            }
        });
        scope.get(`/repos/${process.env.REPO_OWNER}/${process.env.REPO_NAME}/installation`)
            .matchHeader('authorization', `bearer ${token}`)
            .reply(201, {id: APP_ID});
        scope.post(`/app/installations/${APP_ID}/access_tokens`)
            .matchHeader('authorization', `bearer ${token}`)
            .reply(201, {
                token: '#t0k3N',
                permissions: {
                    checks: 'write',
                    metadata: 'read',
                    contents: 'read'
                }
            });
        let pr = evt.pull_request;
        let uri = `/repos/${pr.head.repo.owner.login}/${pr.head.repo.name}/statuses/${pr.head.sha}`;
        scope.post(uri, body => { return body.state === 'pending'; })
            .twice()
            .reply(201, {});
        scope.post(uri, body => { return body.state === 'success'; })
            .twice()
            .reply(201, {});

        sandbox = sinon.createSandbox();
        const stub = sandbox.stub(cp, 'execFile');
        sandbox.stub(fs, 'createWriteStream');
        sandbox.stub(lib, 'openTunnel').resolves(null);
        const execEvent = new events.EventEmitter();
        execEvent.stdout = new events.EventEmitter();
        execEvent.stdout.pipe = sandbox.spy();
        stub
            .returns(execEvent)
            .callsArgAsync(2, null, 'external script called', '');
    });

    it('full stack job request', done => {
        main();
        const server = supertest.agent(`http://localhost:${config.port}`);
        server
            .post(`/github`, evt)
            .expect('Content-Type', 'application/json')
            .expect(201)
            .end(function (err, res) {
                scope.isDone();
                if (err) return done(err);
                done();
            });

    });

    after(function () {
        clock.restore();
        queue.pile = [];
        sandbox.verifyAndRestore();
    });
});
