//! Parsing for the HFP AT lines we exchange with the phone (the AG) over
//! BlueALSA's RFCOMM pass-through channel.

/// One line of `+CLCC` (list current calls).
#[derive(Clone, Debug, PartialEq)]
pub struct ClccEntry {
    pub idx: u32,
    /// 0 = outgoing (mobile originated), 1 = incoming
    pub dir: u8,
    /// 0 active, 1 held, 2 dialing, 3 alerting, 4 incoming, 5 waiting
    pub stat: u8,
    pub mpty: bool,
    pub number: Option<String>,
}

/// Final result of a command.
#[derive(Clone, Debug, PartialEq)]
pub enum Final {
    Ok,
    /// `ERROR`, `+CME ERROR: n`, `NO CARRIER`, `BUSY`, ...
    Error(String),
}

/// A line the phone sends without being asked.
#[derive(Clone, Debug, PartialEq)]
pub enum Unsolicited {
    Ciev { ind: u32, value: u32 },
    Ring,
    Clip { number: Option<String> },
    Ccwa { number: Option<String> },
    /// Lines BlueALSA handles itself but also passes through (codec
    /// selection, volume, in-band ring): ignored.
    Other(String),
}

/// Classify a received line. BlueALSA prefixes final results it relays with a
/// colon (`:OK`), so that is stripped first.
pub enum Line {
    Final(Final),
    Unsolicited(Unsolicited),
    /// Anything else: an information line belonging to the pending command.
    Info(String),
}

pub fn classify(raw: &str) -> Option<Line> {
    let line = raw.trim();
    let line = line.strip_prefix(':').unwrap_or(line).trim();
    if line.is_empty() {
        return None;
    }
    match line {
        "OK" => return Some(Line::Final(Final::Ok)),
        "ERROR" | "NO CARRIER" | "BUSY" | "NO ANSWER" | "NO DIALTONE" => {
            return Some(Line::Final(Final::Error(line.to_string())))
        }
        "RING" => return Some(Line::Unsolicited(Unsolicited::Ring)),
        _ => {}
    }
    if line.starts_with("+CME ERROR") {
        return Some(Line::Final(Final::Error(line.to_string())));
    }
    if let Some(rest) = line.strip_prefix("+CIEV:") {
        let mut it = rest.split(',').map(|s| s.trim().parse::<u32>());
        if let (Some(Ok(ind)), Some(Ok(value))) = (it.next(), it.next()) {
            return Some(Line::Unsolicited(Unsolicited::Ciev { ind, value }));
        }
        return None;
    }
    if let Some(rest) = line.strip_prefix("+CLIP:") {
        return Some(Line::Unsolicited(Unsolicited::Clip { number: quoted_number(rest) }));
    }
    if let Some(rest) = line.strip_prefix("+CCWA:") {
        return Some(Line::Unsolicited(Unsolicited::Ccwa { number: quoted_number(rest) }));
    }
    for prefix in ["+BCS:", "+BSIR:", "+VGS:", "+VGM:", "+BVRA:", "+BIND:", "+BTRH:"] {
        if line.starts_with(prefix) {
            return Some(Line::Unsolicited(Unsolicited::Other(line.to_string())));
        }
    }
    Some(Line::Info(line.to_string()))
}

/// `"+15551234567",145,...` → number, normalized with its type.
fn quoted_number(rest: &str) -> Option<String> {
    let fields = split_fields(rest);
    let raw = fields.first()?;
    let ty = fields.get(1).and_then(|t| t.parse::<u32>().ok());
    normalize_number(raw, ty)
}

/// Split a comma-separated AT parameter list, honouring double quotes and
/// stripping them.
fn split_fields(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                out.push(cur.trim().to_string());
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    out.push(cur.trim().to_string());
    out
}

/// `+CLCC: 1,0,0,0,0,"+15551234567",145`
pub fn parse_clcc(line: &str) -> Option<ClccEntry> {
    let rest = line.trim().strip_prefix("+CLCC:")?;
    let f = split_fields(rest);
    if f.len() < 5 {
        return None;
    }
    let ty = f.get(6).and_then(|t| t.parse::<u32>().ok());
    Some(ClccEntry {
        idx: f[0].parse().ok()?,
        dir: f[1].parse().ok()?,
        stat: f[2].parse().ok()?,
        mpty: f[4] == "1",
        number: f.get(5).and_then(|n| normalize_number(n, ty)),
    })
}

/// `+CIND: ("call",(0,1)),("callsetup",(0-3)),...` → indicator names in order
/// (index 1 is the first).
pub fn parse_cind_names(line: &str) -> Vec<String> {
    let Some(rest) = line.trim().strip_prefix("+CIND:") else { return Vec::new() };
    let mut names = Vec::new();
    let mut in_quote = false;
    let mut cur = String::new();
    for c in rest.chars() {
        if c == '"' {
            if in_quote {
                names.push(std::mem::take(&mut cur));
            }
            in_quote = !in_quote;
        } else if in_quote {
            cur.push(c);
        }
    }
    names
}

/// `+CIND: 0,0,1,3,0,4,0` → values in order.
pub fn parse_cind_values(line: &str) -> Vec<u32> {
    let Some(rest) = line.trim().strip_prefix("+CIND:") else { return Vec::new() };
    rest.split(',').filter_map(|v| v.trim().parse().ok()).collect()
}

/// `+CHLD: (0,1,1x,2,2x,3)` → ["0","1","1x","2","2x","3"]
pub fn parse_chld(line: &str) -> Vec<String> {
    let Some(rest) = line.trim().strip_prefix("+CHLD:") else { return Vec::new() };
    rest.trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Normalize a phone number to E.164 where we can tell.
///
/// `type` 145 means international (the number is E.164 without the `+`).
/// Bare 10-digit numbers are treated as US (+1); anything else that isn't
/// clearly international (short codes, voicemail) is kept as digits.
pub fn normalize_number(raw: &str, ty: Option<u32>) -> Option<String> {
    let raw = raw.trim();
    let plus = raw.starts_with('+');
    let digits: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '*' || *c == '#')
        .collect();
    if digits.is_empty() {
        return None;
    }
    let all_digits = digits.chars().all(|c| c.is_ascii_digit());
    if plus || (ty == Some(145) && all_digits) {
        return Some(format!("+{digits}"));
    }
    if all_digits && digits.len() == 10 {
        return Some(format!("+1{digits}"));
    }
    if all_digits && digits.len() == 11 && digits.starts_with('1') {
        return Some(format!("+{digits}"));
    }
    Some(digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finals_with_bluealsa_colon() {
        assert!(matches!(classify("\r\n:OK\r\n"), Some(Line::Final(Final::Ok))));
        assert!(matches!(classify("OK"), Some(Line::Final(Final::Ok))));
        assert!(matches!(classify(":ERROR"), Some(Line::Final(Final::Error(_)))));
        assert!(matches!(classify("+CME ERROR: 30"), Some(Line::Final(Final::Error(_)))));
        assert!(classify("\r\n").is_none());
    }

    #[test]
    fn unsolicited() {
        match classify("+CIEV: 2,1") {
            Some(Line::Unsolicited(Unsolicited::Ciev { ind: 2, value: 1 })) => {}
            _ => panic!("ciev"),
        }
        match classify("+CLIP: \"2135550100\",129") {
            Some(Line::Unsolicited(Unsolicited::Clip { number })) => {
                assert_eq!(number.as_deref(), Some("+12135550100"))
            }
            _ => panic!("clip"),
        }
        assert!(matches!(classify("RING"), Some(Line::Unsolicited(Unsolicited::Ring))));
    }

    #[test]
    fn clcc() {
        let e = parse_clcc("+CLCC: 3,0,0,0,1,\"+12135550111\",145").unwrap();
        assert_eq!(e, ClccEntry { idx: 3, dir: 0, stat: 0, mpty: true, number: Some("+12135550111".into()) });
        let e = parse_clcc("+CLCC: 1,1,4,0,0,\"12135550100\",145").unwrap();
        assert_eq!(e.number.as_deref(), Some("+12135550100"));
        assert_eq!(e.stat, 4);
        let e = parse_clcc("+CLCC: 1,1,0,0,0").unwrap();
        assert_eq!(e.number, None);
        let e = parse_clcc("+CLCC: 2,1,4,0,0,\"\",128").unwrap();
        assert_eq!(e.number, None);
    }

    #[test]
    fn cind_and_chld() {
        let names = parse_cind_names(
            "+CIND: (\"call\",(0,1)),(\"callsetup\",(0-3)),(\"service\",(0-1)),(\"signal\",(0-5)),(\"roam\",(0,1)),(\"battchg\",(0-5)),(\"callheld\",(0-2))",
        );
        assert_eq!(names, vec!["call", "callsetup", "service", "signal", "roam", "battchg", "callheld"]);
        assert_eq!(parse_cind_values("+CIND: 0,0,1,3,0,4,0"), vec![0, 0, 1, 3, 0, 4, 0]);
        assert_eq!(parse_chld("+CHLD: (0,1,1x,2,2x,3)"), vec!["0", "1", "1x", "2", "2x", "3"]);
    }

    #[test]
    fn numbers() {
        assert_eq!(normalize_number("(213) 555-0100", None).as_deref(), Some("+12135550100"));
        assert_eq!(normalize_number("12135550100", None).as_deref(), Some("+12135550100"));
        assert_eq!(normalize_number("+44 20 7946 0000", None).as_deref(), Some("+442079460000"));
        assert_eq!(normalize_number("442079460000", Some(145)).as_deref(), Some("+442079460000"));
        assert_eq!(normalize_number("611", None).as_deref(), Some("611"));
        assert_eq!(normalize_number("", None), None);
    }
}
