//! The phone's calls as otacon tracks them.
//!
//! HFP gives us `+CLCC` snapshots whose call indices change after a merge, and
//! some phones don't list a ringing call at all. This table keeps a stable
//! otacon id per call across snapshots and turns each snapshot into events.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::at::ClccEntry;

/// How long an incoming call may ring without a known number before
/// `call.incoming` is sent with `number: null`.
pub const ANNOUNCE_WAIT_MS: i64 = 2000;
/// A call the phone stops listing (while its indicators say a call is still
/// up) ends only after it has been missing this long, across several
/// snapshots: replies on the shared RFCOMM channel are sometimes incomplete.
pub const MISSING_END_MS: i64 = 3000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum CallState {
    Dialing,
    Alerting,
    Incoming,
    Active,
    Held,
    Ended,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Outgoing,
    Incoming,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum NumberSource {
    Hfp,
    Kiosk,
}

/// A call as clients see it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    /// Assigned by otacon; stable for the life of the call
    pub id: String,
    /// E.164 if known
    pub number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_source: Option<NumberSource>,
    pub direction: Direction,
    pub state: CallState,
    /// True while the call is part of a merged call
    pub conference: bool,
    /// Epoch milliseconds
    pub started_at: i64,
    /// Epoch milliseconds when the call first became active
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Change {
    Incoming(Call),
    State(Call),
    Ended { call: Call, reason: &'static str },
}

struct Tracked {
    call: Call,
    hfp_idx: Option<u32>,
    /// Ever listed in +CLCC. A ringing call some phones never list is kept
    /// alive by the ringing hint instead.
    seen_in_clcc: bool,
    /// For incoming calls: whether `call.incoming` has been sent. Until then
    /// no other event is sent for the call.
    announced: bool,
    announce_deadline: i64,
    /// Consecutive snapshots that didn't list this call, and since when
    missing: u8,
    missing_since: Option<i64>,
}

#[derive(Default)]
pub struct CallTable {
    calls: Vec<Tracked>,
    /// Calls we ended ourselves, and how: id → reason
    local_end: HashMap<String, &'static str>,
}

fn state_from_stat(stat: u8) -> CallState {
    match stat {
        0 => CallState::Active,
        1 => CallState::Held,
        2 => CallState::Dialing,
        3 => CallState::Alerting,
        _ => CallState::Incoming, // 4 incoming, 5 waiting
    }
}

fn dir_from(dir: u8) -> Direction {
    if dir == 1 { Direction::Incoming } else { Direction::Outgoing }
}

/// Send the right event for a call that changed (or appeared).
fn emit(t: &mut Tracked, now: i64, changes: &mut Vec<Change>) {
    if t.announced {
        changes.push(Change::State(t.call.clone()));
        return;
    }
    if t.call.number.is_some() || t.call.state != CallState::Incoming || now >= t.announce_deadline {
        t.announced = true;
        changes.push(Change::Incoming(t.call.clone()));
    }
}

impl CallTable {
    pub fn calls(&self) -> Vec<Call> {
        self.calls.iter().map(|t| t.call.clone()).collect()
    }

    pub fn get(&self, id: &str) -> Option<&Call> {
        self.calls.iter().map(|t| &t.call).find(|c| c.id == id)
    }

    pub fn with_state(&self, state: CallState) -> Vec<&Call> {
        self.calls.iter().map(|t| &t.call).filter(|c| c.state == state).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    /// Whether any call is past ringing (dialing, alerting, active, held):
    /// the phone routes call audio over Bluetooth.
    pub fn audio_expected(&self) -> bool {
        self.calls.iter().any(|t| t.call.state != CallState::Incoming)
    }

    /// Remember that we ended this call, so its `call.ended` says so.
    pub fn mark_local_end(&mut self, id: &str, reason: &'static str) {
        self.local_end.insert(id.to_string(), reason);
    }

    pub fn unmark_local_end(&mut self, id: &str) {
        self.local_end.remove(id);
    }

    fn end_reason(&mut self, call: &Call) -> &'static str {
        if let Some(r) = self.local_end.remove(&call.id) {
            return r;
        }
        if call.answered_at.is_some() {
            "remote"
        } else if call.direction == Direction::Outgoing {
            "failed"
        } else {
            "remote"
        }
    }

    /// Apply a `+CLCC` snapshot. `ringing_hint` is true while HFP's callsetup
    /// indicator or the kiosk says the phone is ringing; it keeps ringing calls
    /// that the phone doesn't list. `idle` is true when the phone's
    /// indicators say no call is up: a call missing from the snapshot then
    /// ends at once. Otherwise an empty snapshot says nothing (it can be a
    /// reply that lost its lines), and a call missing from non-empty
    /// snapshots ends after MISSING_END_MS and at least 3 snapshots.
    pub fn reconcile(
        &mut self,
        entries: &[ClccEntry],
        ringing_hint: bool,
        idle: bool,
        now: i64,
        new_id: &mut dyn FnMut() -> String,
    ) -> Vec<Change> {
        let mut changes = Vec::new();
        // While merging, the Samsung lists the old legs and the merged legs
        // in the same snapshot (1, 2 and 3, 4 for the same two numbers); the
        // highest index is the current one.
        let mut entries: Vec<ClccEntry> = entries.to_vec();
        entries.sort_by_key(|e| std::cmp::Reverse(e.idx));
        let mut seen = std::collections::HashSet::new();
        entries.retain(|e| match &e.number {
            Some(n) => seen.insert((e.dir, n.clone())),
            None => true,
        });
        entries.sort_by_key(|e| e.idx);
        let entries = &entries[..];
        let n = self.calls.len();
        let mut taken = vec![false; n];
        let mut assign: Vec<Option<usize>> = vec![None; entries.len()];

        // Passes from strictest to loosest so a merge's renumbering doesn't
        // swap two calls' identities.
        for pass in 0..4 {
            for (ei, e) in entries.iter().enumerate() {
                if assign[ei].is_some() {
                    continue;
                }
                let dir = dir_from(e.dir);
                let found = (0..n).find(|&ti| {
                    if taken[ti] {
                        return false;
                    }
                    let t = &self.calls[ti];
                    if t.call.direction != dir {
                        return false;
                    }
                    match pass {
                        0 => t.hfp_idx == Some(e.idx) && t.call.number == e.number,
                        1 => e.number.is_some() && t.call.number == e.number,
                        2 => {
                            (t.call.number.is_none() || e.number.is_none())
                                && (t.hfp_idx.is_none() || t.hfp_idx == Some(e.idx))
                        }
                        // A ringing call first seen from the kiosk or the
                        // callsetup indicator, now listed by HFP.
                        _ => !t.seen_in_clcc,
                    }
                });
                if let Some(ti) = found {
                    taken[ti] = true;
                    assign[ei] = Some(ti);
                }
            }
        }

        for (ei, e) in entries.iter().enumerate() {
            let state = state_from_stat(e.stat);
            match assign[ei] {
                Some(ti) => {
                    let t = &mut self.calls[ti];
                    t.hfp_idx = Some(e.idx);
                    t.seen_in_clcc = true;
                    t.missing = 0;
                    t.missing_since = None;
                    let before = t.call.clone();
                    if e.number.is_some() && t.call.number != e.number {
                        t.call.number = e.number.clone();
                        t.call.number_source = Some(NumberSource::Hfp);
                    }
                    t.call.state = state;
                    t.call.conference = e.mpty;
                    if state == CallState::Active && t.call.answered_at.is_none() {
                        t.call.answered_at = Some(now);
                    }
                    if t.call != before {
                        emit(t, now, &mut changes);
                    }
                }
                None => {
                    let mut t = Tracked {
                        call: Call {
                            id: new_id(),
                            number: e.number.clone(),
                            number_source: e.number.as_ref().map(|_| NumberSource::Hfp),
                            direction: dir_from(e.dir),
                            state,
                            conference: e.mpty,
                            started_at: now,
                            answered_at: matches!(state, CallState::Active | CallState::Held)
                                .then_some(now),
                        },
                        hfp_idx: Some(e.idx),
                        seen_in_clcc: true,
                        announced: state != CallState::Incoming,
                        announce_deadline: now + ANNOUNCE_WAIT_MS,
                        missing: 0,
                    missing_since: None,
                    };
                    emit(&mut t, now, &mut changes);
                    self.calls.push(t);
                    taken.push(true);
                }
            }
        }

        // Calls no longer listed have ended, except a ringing call the phone
        // doesn't list while it is still ringing.
        let mut ti = 0;
        while ti < self.calls.len() {
            let t = &mut self.calls[ti];
            let unlisted_ringing = !t.seen_in_clcc && t.call.state == CallState::Incoming;
            let keep = if taken[ti] {
                true
            } else if unlisted_ringing {
                ringing_hint
            } else if idle {
                false
            } else if entries.is_empty() {
                true
            } else {
                t.missing += 1;
                let since = *t.missing_since.get_or_insert(now);
                t.missing < 3 || now - since < MISSING_END_MS
            };
            if keep {
                ti += 1;
                continue;
            }
            taken.remove(ti);
            let t = self.calls.remove(ti);
            self.finish(t, None, &mut changes);
        }
        changes
    }

    fn finish(&mut self, mut t: Tracked, reason: Option<&'static str>, changes: &mut Vec<Change>) {
        if !t.announced {
            t.announced = true;
            changes.push(Change::Incoming(t.call.clone()));
        }
        let reason = match reason {
            Some(r) => {
                self.local_end.remove(&t.call.id);
                r
            }
            None => self.end_reason(&t.call),
        };
        t.call.state = CallState::Ended;
        changes.push(Change::Ended { call: t.call, reason });
    }

    /// The phone is ringing (HFP callsetup, RING, or the kiosk), possibly with
    /// the caller's number. Fills in the number of the ringing call, or starts
    /// tracking one the phone hasn't listed yet.
    pub fn ringing(
        &mut self,
        number: Option<String>,
        source: NumberSource,
        now: i64,
        new_id: &mut dyn FnMut() -> String,
    ) -> Vec<Change> {
        let mut changes = Vec::new();
        let idx = self
            .calls
            .iter()
            .position(|t| t.call.state == CallState::Incoming && (t.call.number.is_none() || t.call.number == number))
            .or_else(|| self.calls.iter().position(|t| t.call.state == CallState::Incoming));
        match idx {
            Some(i) => {
                let t = &mut self.calls[i];
                if t.call.number.is_none() && number.is_some() {
                    t.call.number = number;
                    t.call.number_source = Some(source);
                    emit(t, now, &mut changes);
                }
            }
            None => {
                let mut t = Tracked {
                    call: Call {
                        id: new_id(),
                        number_source: number.as_ref().map(|_| source),
                        number,
                        direction: Direction::Incoming,
                        state: CallState::Incoming,
                        conference: false,
                        started_at: now,
                        answered_at: None,
                    },
                    hfp_idx: None,
                    seen_in_clcc: false,
                    announced: false,
                    announce_deadline: now + ANNOUNCE_WAIT_MS,
                    missing: 0,
                    missing_since: None,
                };
                emit(&mut t, now, &mut changes);
                self.calls.push(t);
            }
        }
        changes
    }

    /// Announce ringing calls whose number didn't arrive in time.
    pub fn tick(&mut self, now: i64) -> Vec<Change> {
        let mut changes = Vec::new();
        for t in self.calls.iter_mut() {
            if !t.announced && now >= t.announce_deadline {
                emit(t, now, &mut changes);
            }
        }
        changes
    }

    /// The earliest pending `call.incoming` deadline, if any.
    pub fn next_deadline(&self) -> Option<i64> {
        self.calls.iter().filter(|t| !t.announced).map(|t| t.announce_deadline).min()
    }

    /// End every call (the kiosk says the phone is idle while HFP is down).
    pub fn end_all(&mut self, reason: Option<&'static str>) -> Vec<Change> {
        let mut changes = Vec::new();
        for t in std::mem::take(&mut self.calls) {
            self.finish(t, reason, &mut changes);
        }
        changes
    }

    /// Kiosk says a call went off-hook while HFP is down: the ringing call was
    /// answered, or a call was placed from the phone (or by the ADB fallback).
    pub fn kiosk_offhook(
        &mut self,
        number: Option<String>,
        now: i64,
        new_id: &mut dyn FnMut() -> String,
    ) -> Vec<Change> {
        let mut changes = Vec::new();
        if let Some(t) = self.calls.iter_mut().find(|t| t.call.state != CallState::Held) {
            if t.call.state != CallState::Active {
                t.call.state = CallState::Active;
                t.call.answered_at.get_or_insert(now);
                emit(t, now, &mut changes);
            }
            return changes;
        }
        let mut t = Tracked {
            call: Call {
                id: new_id(),
                number_source: number.as_ref().map(|_| NumberSource::Kiosk),
                number,
                direction: Direction::Outgoing,
                // The kiosk can't tell dialing from answered for outgoing calls.
                state: CallState::Active,
                conference: false,
                started_at: now,
                answered_at: None,
            },
            hfp_idx: None,
            seen_in_clcc: false,
            announced: true,
            announce_deadline: now,
            missing: 0,
            missing_since: None,
        };
        emit(&mut t, now, &mut changes);
        self.calls.push(t);
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("call_{n}")
        }
    }

    fn e(idx: u32, dir: u8, stat: u8, mpty: bool, number: Option<&str>) -> ClccEntry {
        ClccEntry { idx, dir, stat, mpty, number: number.map(String::from) }
    }

    const A: &str = "+12135550100";
    const B: &str = "+12135550111";

    #[test]
    fn outgoing_lifecycle() {
        let mut t = CallTable::default();
        let mut id = ids();
        let c = t.reconcile(&[e(1, 0, 2, false, Some(A))], false, true, 1000, &mut id);
        assert!(matches!(&c[..], [Change::State(call)] if call.state == CallState::Dialing && call.id == "call_1"));
        let c = t.reconcile(&[e(1, 0, 3, false, Some(A))], false, true, 2000, &mut id);
        assert!(matches!(&c[..], [Change::State(call)] if call.state == CallState::Alerting));
        // Same snapshot again: no events.
        assert!(t.reconcile(&[e(1, 0, 3, false, Some(A))], false, true, 2500, &mut id).is_empty());
        let c = t.reconcile(&[e(1, 0, 0, false, Some(A))], false, true, 3000, &mut id);
        assert!(matches!(&c[..], [Change::State(call)] if call.state == CallState::Active && call.answered_at == Some(3000)));
        let c = t.reconcile(&[], false, true, 9000, &mut id);
        assert!(matches!(&c[..], [Change::Ended { call, reason: "remote" }] if call.id == "call_1"));
        assert!(t.is_empty());
    }

    #[test]
    fn unanswered_outgoing_failed_and_local_end() {
        let mut t = CallTable::default();
        let mut id = ids();
        t.reconcile(&[e(1, 0, 3, false, Some(A))], false, true, 0, &mut id);
        let c = t.reconcile(&[], false, true, 1, &mut id);
        assert!(matches!(&c[..], [Change::Ended { reason: "failed", .. }]));
        t.reconcile(&[e(1, 0, 0, false, Some(A))], false, true, 2, &mut id);
        t.mark_local_end("call_2", "local");
        let c = t.reconcile(&[], false, true, 3, &mut id);
        assert!(matches!(&c[..], [Change::Ended { reason: "local", .. }]));
    }

    #[test]
    fn merge_renumbering_keeps_ids() {
        let mut t = CallTable::default();
        let mut id = ids();
        t.reconcile(&[e(1, 0, 0, false, Some(A))], false, true, 0, &mut id);
        t.reconcile(&[e(1, 0, 1, false, Some(A)), e(2, 0, 0, false, Some(B))], false, true, 1, &mut id);
        let c = t.reconcile(&[e(3, 0, 0, true, Some(B)), e(4, 0, 0, true, Some(A))], false, true, 2, &mut id);
        assert_eq!(c.len(), 2);
        let calls = t.calls();
        let a = calls.iter().find(|c| c.number.as_deref() == Some(A)).unwrap();
        let b = calls.iter().find(|c| c.number.as_deref() == Some(B)).unwrap();
        assert_eq!((a.id.as_str(), b.id.as_str()), ("call_1", "call_2"));
        assert!(a.conference && b.conference);
        assert_eq!(a.state, CallState::Active);
    }

    #[test]
    fn merge_snapshot_listing_old_and_new_legs() {
        let mut t = CallTable::default();
        let mut id = ids();
        t.reconcile(&[e(1, 0, 0, false, Some(A)), e(2, 0, 1, false, Some(B))], false, false, 0, &mut id);
        let c = t.reconcile(
            &[e(1, 0, 0, false, Some(A)), e(2, 0, 1, false, Some(B)), e(3, 0, 0, true, Some(B)), e(4, 0, 0, true, Some(A))],
            false, false, 1, &mut id,
        );
        assert_eq!(c.len(), 2);
        assert!(t.calls().iter().all(|c| c.conference && c.state == CallState::Active));
        assert_eq!(t.calls().len(), 2);
        assert!(t.reconcile(&[e(3, 0, 0, true, Some(B)), e(4, 0, 0, true, Some(A))], false, false, 2, &mut id).is_empty());
        let ids: Vec<_> = t.calls().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, vec!["call_1", "call_2"]);
    }

    #[test]
    fn incoming_waits_for_number_then_announces() {
        let mut t = CallTable::default();
        let mut id = ids();
        // HFP callsetup=1, phone doesn't list the call (Samsung).
        let c = t.ringing(None, NumberSource::Hfp, 0, &mut id);
        assert!(c.is_empty());
        // A CLCC poll with nothing listed keeps it while ringing.
        assert!(t.reconcile(&[], true, true, 500, &mut id).is_empty());
        // Kiosk delivers the number.
        let c = t.ringing(Some(A.into()), NumberSource::Kiosk, 800, &mut id);
        assert!(matches!(&c[..], [Change::Incoming(call)] if call.number.as_deref() == Some(A) && call.number_source == Some(NumberSource::Kiosk)));
        // Answered: listed as an active incoming call without a number.
        let c = t.reconcile(&[e(1, 1, 0, false, None)], false, true, 3000, &mut id);
        assert!(matches!(&c[..], [Change::State(call)] if call.id == "call_1" && call.state == CallState::Active && call.number.as_deref() == Some(A)));
    }

    #[test]
    fn incoming_without_number_announced_after_deadline() {
        let mut t = CallTable::default();
        let mut id = ids();
        t.ringing(None, NumberSource::Hfp, 0, &mut id);
        assert!(t.tick(1999).is_empty());
        assert_eq!(t.next_deadline(), Some(ANNOUNCE_WAIT_MS));
        let c = t.tick(2000);
        assert!(matches!(&c[..], [Change::Incoming(call)] if call.number.is_none()));
        // A number that arrives later is a call.state update.
        let c = t.ringing(Some(A.into()), NumberSource::Kiosk, 2500, &mut id);
        assert!(matches!(&c[..], [Change::State(call)] if call.number.as_deref() == Some(A)));
    }

    #[test]
    fn listed_ringing_call_with_number_announces_at_once() {
        let mut t = CallTable::default();
        let mut id = ids();
        let c = t.reconcile(&[e(1, 1, 4, false, Some(A))], true, true, 0, &mut id);
        assert!(matches!(&c[..], [Change::Incoming(call)] if call.number_source == Some(NumberSource::Hfp)));
        // Kiosk reports the same call: no new call, no event.
        assert!(t.ringing(Some(A.into()), NumberSource::Kiosk, 100, &mut id).is_empty());
        assert_eq!(t.calls().len(), 1);
    }

    #[test]
    fn ringing_stops_unanswered() {
        let mut t = CallTable::default();
        let mut id = ids();
        t.ringing(Some(A.into()), NumberSource::Kiosk, 0, &mut id);
        let c = t.reconcile(&[], false, true, 5000, &mut id);
        assert!(matches!(&c[..], [Change::Ended { reason: "remote", .. }]));
    }

    #[test]
    fn unannounced_call_that_ends_is_announced_first() {
        let mut t = CallTable::default();
        let mut id = ids();
        t.ringing(None, NumberSource::Hfp, 0, &mut id);
        t.mark_local_end("call_1", "rejected");
        let c = t.reconcile(&[], false, true, 300, &mut id);
        assert!(matches!(&c[..], [Change::Incoming(_), Change::Ended { reason: "rejected", .. }]));
    }

    #[test]
    fn rediscovered_active_call_is_a_state_event() {
        let mut t = CallTable::default();
        let mut id = ids();
        let c = t.reconcile(&[e(1, 1, 0, false, Some(A))], false, true, 0, &mut id);
        assert!(matches!(&c[..], [Change::State(call)] if call.answered_at == Some(0)));
    }

    #[test]
    fn incomplete_snapshots_while_busy_are_not_an_end() {
        let mut t = CallTable::default();
        let mut id = ids();
        let both = [e(1, 0, 1, false, Some(A)), e(2, 0, 0, false, Some(B))];
        t.reconcile(&both, false, false, 0, &mut id);
        // Empty replies while the indicators say calls are up say nothing.
        for i in 1..10 {
            assert!(t.reconcile(&[], false, false, i * 500, &mut id).is_empty());
        }
        // Replies that lost one call's line, for less than 3 s: kept.
        for i in 0..5 {
            assert!(t.reconcile(&both[1..], false, false, 5000 + i * 500, &mut id).is_empty());
        }
        // Listed again resets it.
        assert!(t.reconcile(&both, false, false, 7600, &mut id).is_empty());
        // Missing for 3 s across 3+ snapshots: ended (one leg left a call).
        for i in 0..6 {
            let c = t.reconcile(&both[1..], false, false, 8000 + i * 600, &mut id);
            if i < 5 {
                assert!(c.is_empty(), "ended too early at step {i}");
            } else {
                assert!(matches!(&c[..], [Change::Ended { call, .. }] if call.id == "call_1"));
            }
        }
        // Indicators idle: an empty snapshot ends everything at once.
        let c = t.reconcile(&[], false, true, 20000, &mut id);
        assert!(matches!(&c[..], [Change::Ended { call, .. }] if call.id == "call_2"));
    }

    #[test]
    fn kiosk_only_mode() {
        let mut t = CallTable::default();
        let mut id = ids();
        t.ringing(Some(A.into()), NumberSource::Kiosk, 0, &mut id);
        let c = t.kiosk_offhook(Some(A.into()), 10, &mut id);
        assert!(matches!(&c[..], [Change::State(call)] if call.state == CallState::Active));
        let c = t.end_all(None);
        assert!(matches!(&c[..], [Change::Ended { reason: "remote", .. }]));
    }
}
