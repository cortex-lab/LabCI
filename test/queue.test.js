/**
 * Tests for the queue module
 * @author Miles Wells <miles.wells@ucl.ac.uk>
 * @requires ./queue.js
 * @requires module:mocha
 * @requires module:chai
 * @requires modules:chai-spies
 */
const {describe} = require('mocha');
const sinon = require('sinon');
const assert = require('assert');
const expect = require('chai').expect;

const Queue = require('../queue.js');

// TODO Check only one job is running at any one time
// TODO Check console behaviour
describe('Test Queue constructor:', function() {
    beforeEach(function() {
        this.Q = new Queue()
        this.Q.process(async (_job, _done) => {}) // nop
    });

    it('Pile should be empty on construct', function() {
        assert.strictEqual(this.Q.pile.length, 0, 'pile null or not empty')
    });

    it('Pile should grow as jobs added', function() {
        this.Q.add({pi: 3.14})
        assert.strictEqual(this.Q.pile.length, 1, 'failed to add job to pile')
        assert.strictEqual(this.Q.pile[0].data.pi, 3.14, 'failed to fetch job data from pile')

        // Add another to the pile
        this.Q.add({})
        assert.strictEqual(this.Q.pile.length, 2, 'failed to add more than one job')
        let id = this.Q.pile[0].id
        let isInt16 = Number.isInteger(id) && id.toString().length === 16
        assert(isInt16, `unexpected id ${id}`)

        // Check the set is unique
        var ids = this.Q.pile.map((job) => { return job.id; })
        assert.strictEqual(ids.length, new Set(ids).size)

        // Add and remove jobs
        this.Q.pile.pop()
        this.Q.add({})
        this.Q.pile.pop()
        this.Q.add({})
        this.Q.add({})
        this.Q.pile.shift()
        this.Q.add({})
        this.Q.add({})

        // Check ids still unique
        ids = this.Q.pile.map((job) => { return job.id; })
        assert.strictEqual(ids.length, new Set(ids).size, 'ids not unique')
    });

    it('One job should be set to running', function() {
        this.Q.add({})
        this.Q.add({})

        let running = this.Q.pile.map((job) => { return job.running; })
        assert.deepStrictEqual(running, [true, false], 'first object must be running')
    });

});

describe('Test Queue callbacks:', function() {
    var spy;

    beforeEach(function () {
        this.Q = new Queue();
        function process(job, done) {
            // if outcome set for test, call done with code, otherwise do nothing
            if (job.data && 'outcome' in job.data) {
                job.data['processed'] = true
                if (job.data['outcome'] === 1) {
                    done()
                } else {
                    done({'message': 'failed'})
                }
            }
        }
        spy = sinon.spy(process);
        this.Q.process(async (job, done) => spy(job, done))
    });

    it('Check finish callback', function (done) {
        var calls = 0;
        this.Q.on('error', () => { assert(false); });
        this.Q.on('finish', (err) => {
            calls += 1;
            expect(spy.calledOnce).true;
            expect(err).undefined
            if (calls === 2) { done(); }
        });
        this.Q.on('complete', (job) => {
            calls += 1;
            expect(spy.calledOnce).true;
            expect(job.data.outcome).eq(1);
            if (calls === 2) { done(); }
        });
        this.Q.add({'outcome': 1});
    });

    it('Check finish err callback', function (done) {
        var calls = 0;
        this.Q.on('finish', (err) => {
            calls += 1;
            expect(spy.calledOnce).true;
            expect(err).not.null
            if (calls === 2) { done(); }
        });
        this.Q.on('complete', () => { assert(false); });
        this.Q.on('error', (err) => {
            calls += 1;
            expect(spy.calledOnce).true;
            expect(err).not.null
            if (calls === 2) { done(); }
        });
        this.Q.add({'outcome': 0});
    });

});
