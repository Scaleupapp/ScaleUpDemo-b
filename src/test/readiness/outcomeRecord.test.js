'use strict';
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

test('recordOutcome: SUCCESS marks objective + stamps proof; isDue respects targetDate/resolved/snooze', async () => {
  const UserObjective = require('../../models/UserObjective');
  const ObjectiveOutcome = require('../../models/ObjectiveOutcome');
  const ReadinessProof = require('../../models/ReadinessProof');
  const outcomeService = require('../../services/readiness/outcomeService');

  const userId = new mongoose.Types.ObjectId();
  const objId = new mongoose.Types.ObjectId();
  const obj = { _id: objId, userId, objectiveType: 'interview_preparation', targetDate: new Date('2020-01-01'),
    status: 'active', readyState: { isReady: true }, createdAt: new Date('2025-01-01'),
    save: async function () { return this; } };
  const o1 = UserObjective.findOne; UserObjective.findOne = () => ({ lean: async () => obj });
  // also non-lean fetch used to mutate+save:
  const o1b = UserObjective.findById; UserObjective.findById = () => obj;
  outcomeService.buildContext = async () => ({ readinessAtCapture: 84 });
  const created = []; const oc = ObjectiveOutcome.create; ObjectiveOutcome.create = async (d) => { created.push(d); return d; };
  const stamped = []; const rp = ReadinessProof.updateMany; ReadinessProof.updateMany = async (q, u) => { stamped.push({ q, u }); return { matchedCount: 1 }; };
  try {
    const out = await outcomeService.recordOutcome(userId, { objectiveId: objId, rawChoice: 'got_role', source: 'i_got_it' });
    assert.equal(out.label, 'SUCCESS');
    assert.equal(out.celebrate, true);
    assert.equal(created[0].label, 'SUCCESS');
    assert.equal(stamped[0].u.$set.achieved, true); // proof stamped
    assert.equal(obj.status, 'completed');           // objective marked

    // isDue: targetDate in the past (2020) + no resolved outcome + not snoozed => due
    assert.equal(outcomeService.isDue({ targetDate: new Date('2020-01-01'), outcomePrompt: {} }, false), true);
    assert.equal(outcomeService.isDue({ targetDate: new Date('2099-01-01'), outcomePrompt: {} }, false), false); // future
    assert.equal(outcomeService.isDue({ targetDate: new Date('2020-01-01'), outcomePrompt: {} }, true), false);  // already resolved
  } finally {
    UserObjective.findOne = o1; UserObjective.findById = o1b; ObjectiveOutcome.create = oc; ReadinessProof.updateMany = rp;
  }
});
