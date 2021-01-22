/**
 * Tests for the queue module
 * @author Miles Wells <miles.wells@ucl.ac.uk>
 * @requires ./queue.js
 * @requires module:mocha
 * @requires module:chai
 * @requires modules:chai-spies
 */
const {describe} = require('mocha');
// const assert = require('chai').assert;
const spies = require('chai-spies');
const chai = require('chai');
const should = chai.should();
const assert = require('assert');

chai.use(spies);

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
        this.spy = chai.spy(process);
        this.Q.process(async (job, done) => this.spy(job, done))
    });

    it('Check process callback', function () {
        // TODO Write async check
        this.Q.add({'outcome': 1})
        var spy = this.spy
        this.Q.on('finish', job => {
             spy.should.have.been.called.once;
        });
        // this.Q.on('complete', job => {
        //     assert.strictEqual(job.data['outcome'], 1, 'complete called with unexpected outcome')
        // });
        // this.Q.on('error', err => {
        //     assert.strictEqual(err.message, 'failed', 'failed to catch error')
        // });
        // this.Q.add({'outcome': 1})
        // this.Q.add({'outcome': 0})
    });
});
