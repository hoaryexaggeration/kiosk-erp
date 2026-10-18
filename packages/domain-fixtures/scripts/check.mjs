#!/usr/bin/env node
/**
 * Conformance checker: runs the reference implementation against the language-neutral
 * JSON fixtures. The Kotlin (and later Swift) implementations must pass the exact same fixtures.
 * Exits non-zero on any mismatch so it can gate CI.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeLine, computeDocument, evaluateCredit, canTransition, parseMinorInput } from '../src/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

let passed = 0;
const failures = [];

function eqJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function check(name, actual, expected) {
  if (eqJson(actual, expected)) {
    passed++;
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

// --- pricing / tax -------------------------------------------------------
const pricing = JSON.parse(readFileSync(join(fixtures, 'pricing-tax.json'), 'utf8'));
for (const c of pricing.lines) {
  check(`pricing:${c.id}`, computeLine(c.input), c.expected);
}
for (const d of pricing.documents) {
  check(`pricing-doc:${d.id}`, computeDocument(d.lines), d.expected);
}

// --- money input parsing -------------------------------------------------
// A typed price must become integer minor units without ever touching binary floating point.
for (const c of pricing.parsing ?? []) {
  check(`parsing:${c.id}`, parseMinorInput(c.input), c.expected);
}

// --- credit exposure -----------------------------------------------------
const credit = JSON.parse(readFileSync(join(fixtures, 'credit-exposure.json'), 'utf8'));
for (const c of credit.cases) {
  check(`credit:${c.id}`, evaluateCredit(c.input), c.expected);
}

// --- sale state machine --------------------------------------------------
const sm = JSON.parse(readFileSync(join(fixtures, 'sale-state-machine.json'), 'utf8'));
const states = Object.keys(sm.transitions);
let reachable = new Set([sm.initialState]);
// structural: every transition target must be a known state
for (const [from, targets] of Object.entries(sm.transitions)) {
  check(`sm:known-from:${from}`, states.includes(from), true);
  for (const t of targets) {
    if (!states.includes(t)) failures.push(`sm: unknown target ${from} -> ${t}`);
    reachable.add(t);
  }
}
// no transition out of a terminal state
for (const [from, targets] of Object.entries(sm.transitions)) {
  if (targets.length === 0) check(`sm:terminal:${from}`, targets.length, 0);
}
// initial state must be a known state
check('sm:initial-known', states.includes(sm.initialState), true);
// explicit positive/negative transition checks
check('sm:allow draft->pending_sync', canTransition(sm.transitions, 'draft', 'pending_sync'), true);
check('sm:reject draft->accepted', canTransition(sm.transitions, 'draft', 'accepted'), false);
check('sm:allow accepted->refunded', canTransition(sm.transitions, 'accepted', 'refunded'), true);
check('sm:reject refunded->accepted', canTransition(sm.transitions, 'refunded', 'accepted'), false);
// push result mapping covers every documented state
for (const [k, v] of Object.entries(sm.pushResultToState)) {
  check(`sm:push-map-target-known:${k}`, states.includes(v), true);
}

// --- report --------------------------------------------------------------
const total = passed + failures.length;
if (failures.length) {
  console.error(`\n\u2716 domain fixtures: ${failures.length}/${total} failed`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`\u2714 domain fixtures: ${passed}/${total} checks passed`);
