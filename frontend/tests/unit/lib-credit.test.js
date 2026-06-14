// Pure-function helpers — no I/O, no mocks, no carve-out clause needed.
// Pins the decision-β credit-badge contract (lib/credit.js): a paper-detail
// author slot is CREDITED (single badge, only display distinction) iff the union
// of the two backend-authoritative signals holds — `author.consented === true`
// (Routes 1/2, hive-keyed) OR an accepted `authorship_claims[]` entry for the
// slot (Route 3). A pending claim is NOT credited; a hive-less bridge credit with
// neither signal is NOT credited. See ARCHITECTURE.md § 2 "Consented vs claimed
// authorship".
import { describe, it, expect } from 'vitest';
import {
  isSlotCredited,
  acceptedClaimerForSlot,
  creditProfileForSlot,
} from '../../src/lib/credit.js';

const accepted = (idx, claimer) => ({ author_index: idx, claimer, status: 'accepted' });
const pending = (idx, claimer) => ({ author_index: idx, claimer, status: 'pending' });

describe('isSlotCredited', () => {
  it('credits a Route-1/2 consented hive author (consented === true)', () => {
    expect(isSlotCredited({ hive: 'alice', consented: true }, [], 0)).toBe(true);
  });

  it('credits a Route-3 name-only slot with an accepted claim', () => {
    const author = { name: 'J. Doe' }; // name-only, no hive, no consented flag
    expect(isSlotCredited(author, [accepted(1, 'bob')], 1)).toBe(true);
  });

  it('does NOT credit a pending Route-3 claim (no badge, plain text)', () => {
    const author = { name: 'J. Doe' };
    expect(isSlotCredited(author, [pending(1, 'bob')], 1)).toBe(false);
  });

  it('does NOT credit a hive-less bridge credit with neither signal', () => {
    // consented absent (any non-paper-detail-resolvable slot) and no claim.
    expect(isSlotCredited({ name: 'Bridge Author' }, [], 2)).toBe(false);
  });

  it('does NOT credit a consented:false slot (the ORCID-anchored hive-less edge)', () => {
    // A hive-less anchored slot reads consented:false even when cycle-credited;
    // the SPA must render it plain-text, not synthesize a badge.
    expect(isSlotCredited({ orcid: '0000-0001-2345-6789', consented: false }, [], 0)).toBe(false);
  });

  it('consented:true wins even when a pending claim also exists for the slot', () => {
    expect(isSlotCredited({ hive: 'alice', consented: true }, [pending(0, 'mallory')], 0)).toBe(true);
  });

  it('ignores an accepted claim bound to a DIFFERENT slot index', () => {
    expect(isSlotCredited({ name: 'J. Doe' }, [accepted(3, 'bob')], 1)).toBe(false);
  });

  it('handles a null author defensively (credits only via an accepted claim)', () => {
    expect(isSlotCredited(null, [accepted(0, 'bob')], 0)).toBe(true);
    expect(isSlotCredited(null, [], 0)).toBe(false);
  });

  it('credits a name-only slot-0 accepted claim (0 is a real index, not "absent")', () => {
    // Slot 0 is the first author slot, not a falsy "no slot" value: a
    // `0`-treated-as-absent bug in slot matching would wrongly drop the badge
    // and the profile link for a first-author Route-3 claim.
    const author = { name: 'First Author' };
    expect(isSlotCredited(author, [accepted(0, 'bob')], 0)).toBe(true);
    expect(creditProfileForSlot(author, [accepted(0, 'bob')], 0)).toBe('bob');
  });
});

describe('acceptedClaimerForSlot', () => {
  it('returns the claimer for an accepted claim at the slot', () => {
    expect(acceptedClaimerForSlot([accepted(2, 'carol')], 2)).toBe('carol');
  });

  it('returns null for a pending claim at the slot', () => {
    expect(acceptedClaimerForSlot([pending(2, 'carol')], 2)).toBe(null);
  });

  it('returns null when no claim matches the slot', () => {
    expect(acceptedClaimerForSlot([accepted(0, 'carol')], 2)).toBe(null);
  });

  it('tolerates null/undefined/empty claim arrays', () => {
    expect(acceptedClaimerForSlot(null, 0)).toBe(null);
    expect(acceptedClaimerForSlot(undefined, 0)).toBe(null);
    expect(acceptedClaimerForSlot([], 0)).toBe(null);
  });
});

describe('creditProfileForSlot', () => {
  it('links to the slot hive for a Route-1/2 author', () => {
    expect(creditProfileForSlot({ hive: 'alice', consented: true }, [], 0)).toBe('alice');
  });

  it('links to the accepted claimer for a Route-3 name-only slot', () => {
    expect(creditProfileForSlot({ name: 'J. Doe' }, [accepted(1, 'bob')], 1)).toBe('bob');
  });

  it('returns null for an uncredited slot (no hive, no accepted claim)', () => {
    expect(creditProfileForSlot({ name: 'J. Doe' }, [pending(1, 'bob')], 1)).toBe(null);
  });

  it('prefers the slot hive over a claim when both somehow exist', () => {
    expect(creditProfileForSlot({ hive: 'alice' }, [accepted(0, 'bob')], 0)).toBe('alice');
  });
});
