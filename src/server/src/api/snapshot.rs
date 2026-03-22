use axum::extract::Query;
use axum::response::{IntoResponse, Response};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write as FmtWrite;

use super::adb::adb;
use super::ApiError;

/// Cached snapshot state: previous tree + monotonic ref counter.
pub struct SnapshotCache {
    /// Map from ref ID (e.g. "e5") to bounds
    pub ref_bounds: HashMap<String, Bounds>,
    /// Previous nodes keyed by fingerprint for ref stability
    prev_refs: HashMap<String, String>,
    /// Next ref counter (monotonic, never resets)
    next_ref: u64,
    /// When the current snapshot was taken
    pub snapshot_time: Option<std::time::Instant>,
    /// Whether the cache has been invalidated by an action
    pub invalidated: bool,
}

impl Default for SnapshotCache {
    fn default() -> Self {
        Self {
            ref_bounds: HashMap::new(),
            prev_refs: HashMap::new(),
            next_ref: 0,
            snapshot_time: None,
            invalidated: false,
        }
    }
}

const SNAPSHOT_TTL: std::time::Duration = std::time::Duration::from_secs(30);

impl SnapshotCache {
    /// Check if cached refs are usable (not invalidated, not expired).
    pub fn is_valid(&self) -> bool {
        if self.invalidated {
            return false;
        }
        match self.snapshot_time {
            Some(t) => t.elapsed() < SNAPSHOT_TTL,
            None => false,
        }
    }

    /// Mark cache as invalidated (after an action).
    pub fn invalidate(&mut self) {
        self.invalidated = true;
    }
}


#[derive(Debug, Clone, Serialize)]
pub struct Bounds {
    pub x1: i32,
    pub y1: i32,
    pub x2: i32,
    pub y2: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct A11yNode {
    pub class: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_id: Option<String>,
    pub clickable: bool,
    pub checkable: bool,
    pub checked: bool,
    pub focusable: bool,
    pub focused: bool,
    pub scrollable: bool,
    pub enabled: bool,
    pub selected: bool,
    pub long_clickable: bool,
    pub children: Vec<A11yNode>,
}

#[derive(Deserialize)]
pub struct SnapshotQuery {
    #[serde(default = "default_format")]
    pub format: String,
}

fn default_format() -> String {
    "text".into()
}

/// Should this node get a ref ID?
/// Only interactive elements get refs — things you can tap, type into, or scroll.
fn is_refable(node: &A11yNode) -> bool {
    node.clickable
        || node.long_clickable
        || node.checkable
        || node.scrollable
        // EditText fields are focusable type targets (for typing into)
        || (node.focusable && node.class.ends_with("EditText"))
}

/// Build a fingerprint for node matching across snapshots.
/// Uses tree path + bounds to guarantee uniqueness. Bounds prevent
/// recycled views (RecyclerView) from colliding when they share
/// the same class/text at the same sibling index after scrolling.
fn node_fingerprint(node: &A11yNode, path: &str) -> String {
    let text = node.text.as_deref().unwrap_or("");
    let desc = node.content_desc.as_deref().unwrap_or("");
    let rid = node.resource_id.as_deref().unwrap_or("");
    let bounds = node.bounds.as_ref()
        .map(|b| format!("{},{},{},{}", b.x1, b.y1, b.x2, b.y2))
        .unwrap_or_default();
    format!("{}|{}|{}|{}|{}|{}", path, node.class, rid, text, desc, bounds)
}

/// Assign ref IDs to nodes, reusing previous refs where possible.
fn assign_refs(node: &mut A11yNode, cache: &mut SnapshotCache, path: &str) {
    if is_refable(node) {
        let fp = node_fingerprint(node, path);
        let ref_id = if let Some(existing) = cache.prev_refs.get(&fp) {
            existing.clone()
        } else {
            let id = format!("e{}", cache.next_ref);
            cache.next_ref += 1;
            id
        };
        cache.prev_refs.insert(fp, ref_id.clone());
        if let Some(ref bounds) = node.bounds {
            cache.ref_bounds.insert(ref_id.clone(), bounds.clone());
        }
        node.ref_id = Some(ref_id);
    }

    for (i, child) in node.children.iter_mut().enumerate() {
        let child_path = format!("{}/{}.{}", path, short_class(&node.class), i);
        assign_refs(child, cache, &child_path);
    }
}

/// Parse bounds string "[x1,y1][x2,y2]" into Bounds.
fn parse_bounds(s: &str) -> Option<Bounds> {
    // Format: [0,0][1080,2400]
    let s = s.trim();
    let parts: Vec<&str> = s
        .split(|c| c == '[' || c == ']' || c == ',')
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() == 4 {
        Some(Bounds {
            x1: parts[0].parse().ok()?,
            y1: parts[1].parse().ok()?,
            x2: parts[2].parse().ok()?,
            y2: parts[3].parse().ok()?,
        })
    } else {
        None
    }
}

fn attr_bool(val: &str) -> bool {
    val == "true"
}

fn non_empty(val: &str) -> Option<String> {
    if val.is_empty() { None } else { Some(val.to_string()) }
}

/// Strip Android class prefixes for readability.
fn short_class(class: &str) -> &str {
    class
        .strip_prefix("android.widget.")
        .or_else(|| class.strip_prefix("android.view."))
        .unwrap_or(class)
}

/// Parse uiautomator XML into a tree of A11yNodes.
fn parse_xml(xml: &str) -> Result<Vec<A11yNode>, ApiError> {
    let mut reader = Reader::from_str(xml);

    let mut stack: Vec<A11yNode> = Vec::new();
    let mut roots: Vec<A11yNode> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref e)) if e.name().as_ref() == b"node" => {
                let node = node_from_attrs(e)?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else {
                    roots.push(node);
                }
            }
            Ok(Event::Start(ref e)) if e.name().as_ref() == b"node" => {
                let node = node_from_attrs(e)?;
                stack.push(node);
            }
            Ok(Event::End(ref e)) if e.name().as_ref() == b"node" => {
                let node = stack.pop().unwrap();
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(node);
                } else {
                    roots.push(node);
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(ApiError::BadRequest(format!("XML parse error: {e}"))),
        }
    }

    Ok(roots)
}

fn node_from_attrs<'a>(e: &'a quick_xml::events::BytesStart<'a>) -> Result<A11yNode, ApiError> {
    let mut class = String::new();
    let mut text = None;
    let mut content_desc = None;
    let mut resource_id = None;
    let mut bounds = None;
    let mut clickable = false;
    let mut checkable = false;
    let mut checked = false;
    let mut focusable = false;
    let mut focused = false;
    let mut scrollable = false;
    let mut enabled = true;
    let mut selected = false;
    let mut long_clickable = false;

    for attr in e.attributes().flatten() {
        // Decode XML entities (&#10; → newline, &amp; → &, etc.)
        let val = attr.unescape_value().unwrap_or_default().to_string();
        match attr.key.as_ref() {
            b"class" => class = val,
            b"text" => text = non_empty(&val),
            b"content-desc" => content_desc = non_empty(&val),
            b"resource-id" => resource_id = non_empty(&val),
            b"bounds" => bounds = parse_bounds(&val),
            b"clickable" => clickable = attr_bool(&val),
            b"checkable" => checkable = attr_bool(&val),
            b"checked" => checked = attr_bool(&val),
            b"focusable" => focusable = attr_bool(&val),
            b"focused" => focused = attr_bool(&val),
            b"scrollable" => scrollable = attr_bool(&val),
            b"enabled" => enabled = attr_bool(&val),
            b"selected" => selected = attr_bool(&val),
            b"long-clickable" => long_clickable = attr_bool(&val),
            _ => {}
        }
    }

    Ok(A11yNode {
        class,
        text,
        content_desc,
        resource_id,
        bounds,
        ref_id: None,
        clickable,
        checkable,
        checked,
        focusable,
        focused,
        scrollable,
        enabled,
        selected,
        long_clickable,
        children: Vec::new(),
    })
}

/// Render tree as indented text (for LLM consumption).
fn render_text(nodes: &[A11yNode], indent: usize, out: &mut String) {
    for node in nodes {
        let prefix = "  ".repeat(indent);
        let name = short_class(&node.class);

        write!(out, "{prefix}{name}").unwrap();

        if let Some(ref text) = node.text {
            let clean = text.replace('\n', " ");
            write!(out, " \"{clean}\"").unwrap();
        } else if let Some(ref desc) = node.content_desc {
            let clean = desc.replace('\n', " ");
            write!(out, " \"{clean}\"").unwrap();
        }

        let mut attrs = Vec::new();
        if let Some(ref id) = node.ref_id {
            attrs.push(format!("ref={id}"));
        }
        if node.long_clickable {
            attrs.push("long-clickable".into());
        }
        if node.checked {
            attrs.push("checked".into());
        }
        if node.focused {
            attrs.push("focused".into());
        }
        if node.scrollable {
            attrs.push("scrollable".into());
        }
        if node.selected {
            attrs.push("selected".into());
        }
        if !node.enabled {
            attrs.push("disabled".into());
        }

        if !attrs.is_empty() {
            write!(out, " [{}]", attrs.join(", ")).unwrap();
        }

        out.push('\n');

        render_text(&node.children, indent + 1, out);
    }
}

pub async fn handler(
    state: std::sync::Arc<super::AppState>,
    Query(query): Query<SnapshotQuery>,
) -> Result<Response, ApiError> {
    // Dump UI hierarchy
    let raw = adb(&["exec-out", "uiautomator", "dump", "/dev/tty"]).await?;
    let raw_str = String::from_utf8_lossy(&raw);

    // uiautomator appends "UI hierchary dumped to: /dev/tty" after the XML
    let xml = raw_str
        .find("<?xml")
        .map(|start| {
            let end = raw_str.rfind("</hierarchy>").map(|e| e + "</hierarchy>".len()).unwrap_or(raw_str.len());
            &raw_str[start..end]
        })
        .unwrap_or(&raw_str);

    let mut roots = parse_xml(xml)?;

    // Assign refs with stability
    {
        let mut guard = state.snapshot_cache.lock().await;
        let cache = guard.get_or_insert_with(SnapshotCache::default);

        // Clear ref_bounds for this snapshot (will be rebuilt by assign_refs)
        cache.ref_bounds.clear();

        // assign_refs will look up prev_refs for existing fingerprints,
        // and insert new entries. Old entries that aren't re-inserted
        // are naturally retired on the next snapshot.
        for (i, root) in roots.iter_mut().enumerate() {
            assign_refs(root, cache, &format!("/{i}"));
        }
        cache.snapshot_time = Some(std::time::Instant::now());
        cache.invalidated = false;
    }

    match query.format.as_str() {
        "json" => {
            let json = serde_json::to_string_pretty(&roots)
                .map_err(|e| ApiError::Adb(format!("JSON serialization error: {e}")))?;
            Ok((
                [("content-type", "application/json")],
                json,
            )
                .into_response())
        }
        _ => {
            let mut text = String::new();
            render_text(&roots, 0, &mut text);
            Ok((
                [("content-type", "text/plain; charset=utf-8")],
                text,
            )
                .into_response())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.launcher3" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Search" resource-id="com.android.launcher3:id/search_box" class="android.widget.EditText" package="com.android.launcher3" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[60,100][1020,200]" />
    <node index="1" text="Chrome" resource-id="" class="android.widget.TextView" package="com.android.launcher3" content-desc="Chrome" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[60,300][300,500]" />
  </node>
</hierarchy>"#;

    #[test]
    fn test_parse_xml() {
        let roots = parse_xml(SAMPLE_XML).unwrap();
        assert_eq!(roots.len(), 1);
        let root = &roots[0];
        assert_eq!(root.class, "android.widget.FrameLayout");
        assert_eq!(root.children.len(), 2);

        let search = &root.children[0];
        assert_eq!(search.text, Some("Search".into()));
        assert!(search.clickable);
        assert!(search.focusable);

        let chrome = &root.children[1];
        assert_eq!(chrome.text, Some("Chrome".into()));
        assert_eq!(chrome.content_desc, Some("Chrome".into()));
        assert!(chrome.long_clickable);
    }

    #[test]
    fn test_parse_bounds() {
        let b = parse_bounds("[60,100][1020,200]").unwrap();
        assert_eq!(b.x1, 60);
        assert_eq!(b.y1, 100);
        assert_eq!(b.x2, 1020);
        assert_eq!(b.y2, 200);
    }

    #[test]
    fn test_render_text() {
        let mut roots = parse_xml(SAMPLE_XML).unwrap();
        // Assign refs manually for test
        let mut cache = SnapshotCache::default();
        for (i, root) in roots.iter_mut().enumerate() {
            assign_refs(root, &mut cache, &format!("/{i}"));
        }

        let mut text = String::new();
        render_text(&roots, 0, &mut text);

        assert!(text.contains("FrameLayout"));
        assert!(text.contains("EditText \"Search\""));
        assert!(text.contains("[ref=e"));
        assert!(text.contains("TextView \"Chrome\""));
    }

    #[test]
    fn test_ref_stability() {
        let mut cache = SnapshotCache::default();

        // First snapshot
        let mut roots1 = parse_xml(SAMPLE_XML).unwrap();
        for (i, root) in roots1.iter_mut().enumerate() {
            assign_refs(root, &mut cache, &format!("/{i}"));
        }
        let search_ref = roots1[0].children[0].ref_id.clone().unwrap();
        let chrome_ref = roots1[0].children[1].ref_id.clone().unwrap();

        // Second snapshot (same XML) — refs should be identical
        let mut roots2 = parse_xml(SAMPLE_XML).unwrap();
        for (i, root) in roots2.iter_mut().enumerate() {
            assign_refs(root, &mut cache, &format!("/{i}"));
        }
        assert_eq!(roots2[0].children[0].ref_id.as_ref().unwrap(), &search_ref);
        assert_eq!(roots2[0].children[1].ref_id.as_ref().unwrap(), &chrome_ref);
    }
}
