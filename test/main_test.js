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
const should = chai.should()
const assert = require('assert')

const main = require('../main');

chai.use(spies);

