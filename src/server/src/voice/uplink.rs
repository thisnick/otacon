//! The uplink queue: audio the controlling client sends for the other party,
//! with marks between the audio. Played in fixed frames at real time.

use std::collections::VecDeque;

enum Item {
    Audio(Vec<u8>),
    Mark(String),
}

pub struct Uplink {
    items: VecDeque<Item>,
    /// Bytes of audio queued (not counting marks)
    queued: usize,
    /// Partially played front audio chunk offset
    front_offset: usize,
    cap_bytes: usize,
}

/// One frame taken from the queue for playback.
pub struct Frame {
    pub pcm: Vec<u8>,
    /// Marks reached by the end of this frame
    pub marks: Vec<String>,
}

impl Uplink {
    pub fn new(cap_bytes: usize) -> Self {
        Self { items: VecDeque::new(), queued: 0, front_offset: 0, cap_bytes }
    }

    #[cfg(test)]
    pub fn queued_bytes(&self) -> usize {
        self.queued
    }

    /// Queue audio. Returns how many bytes were dropped because the queue is
    /// full (the newest audio is the part dropped).
    pub fn push_audio(&mut self, data: &[u8]) -> usize {
        let room = self.cap_bytes.saturating_sub(self.queued);
        let take = data.len().min(room) & !1; // whole samples only
        if take > 0 {
            self.items.push_back(Item::Audio(data[..take].to_vec()));
            self.queued += take;
        }
        data.len() - take
    }

    pub fn push_mark(&mut self, name: String) {
        self.items.push_back(Item::Mark(name));
    }

    /// Drop everything queued. Returns the audio bytes dropped and the marks
    /// that were never reached.
    pub fn clear(&mut self) -> (usize, Vec<String>) {
        let dropped = self.queued;
        let marks = self
            .items
            .drain(..)
            .filter_map(|i| match i {
                Item::Mark(m) => Some(m),
                Item::Audio(_) => None,
            })
            .collect();
        self.queued = 0;
        self.front_offset = 0;
        (dropped, marks)
    }

    /// Take the next frame of `frame_bytes`, padded with silence. Marks at the
    /// front before, inside or right at the end of the frame are reported.
    pub fn next_frame(&mut self, frame_bytes: usize) -> Frame {
        let mut pcm = Vec::with_capacity(frame_bytes);
        let mut marks = Vec::new();
        loop {
            match self.items.front() {
                Some(Item::Mark(_)) => {
                    if let Some(Item::Mark(m)) = self.items.pop_front() {
                        marks.push(m);
                    }
                }
                Some(Item::Audio(chunk)) => {
                    if pcm.len() == frame_bytes {
                        break;
                    }
                    let want = frame_bytes - pcm.len();
                    let avail = chunk.len() - self.front_offset;
                    let n = want.min(avail);
                    pcm.extend_from_slice(&chunk[self.front_offset..self.front_offset + n]);
                    self.front_offset += n;
                    self.queued -= n;
                    if self.front_offset == chunk.len() {
                        self.items.pop_front();
                        self.front_offset = 0;
                    }
                }
                None => break,
            }
        }
        pcm.resize(frame_bytes, 0);
        Frame { pcm, marks }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_marks_and_padding() {
        let mut u = Uplink::new(1000);
        u.push_audio(&[1; 6]);
        u.push_mark("a".into());
        u.push_audio(&[2; 2]);
        let f = u.next_frame(4);
        assert_eq!(f.pcm, vec![1, 1, 1, 1]);
        assert!(f.marks.is_empty());
        // Mark "a" sits inside this frame, so it fires with it.
        let f = u.next_frame(4);
        assert_eq!(f.pcm, vec![1, 1, 2, 2]);
        assert_eq!(f.marks, vec!["a"]);
        let f = u.next_frame(4);
        assert_eq!(f.pcm, vec![0, 0, 0, 0]);
        assert_eq!(u.queued_bytes(), 0);
    }

    #[test]
    fn mark_at_frame_boundary_fires_with_that_frame() {
        let mut u = Uplink::new(1000);
        u.push_audio(&[1; 4]);
        u.push_mark("end".into());
        let f = u.next_frame(4);
        assert_eq!(f.marks, vec!["end"]);
    }

    #[test]
    fn mark_on_empty_queue_fires_next_frame() {
        let mut u = Uplink::new(1000);
        u.push_mark("m".into());
        assert_eq!(u.next_frame(4).marks, vec!["m"]);
    }

    #[test]
    fn clear_reports_dropped_and_marks() {
        let mut u = Uplink::new(1000);
        u.push_audio(&[1; 10]);
        u.next_frame(4);
        u.push_mark("x".into());
        u.push_audio(&[1; 8]);
        let (dropped, marks) = u.clear();
        assert_eq!(dropped, 14);
        assert_eq!(marks, vec!["x"]);
        assert_eq!(u.next_frame(4).pcm, vec![0; 4]);
    }

    #[test]
    fn cap_drops_newest() {
        let mut u = Uplink::new(10);
        assert_eq!(u.push_audio(&[1; 8]), 0);
        assert_eq!(u.push_audio(&[2; 8]), 6);
        assert_eq!(u.queued_bytes(), 10);
    }
}
