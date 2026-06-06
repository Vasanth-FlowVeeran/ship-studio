//! # Live Tailwind Editor — source resolution & write-back
//!
//! The visual editor maps a clicked DOM element back to the exact `className`
//! string literal in source, then surgically rewrites that literal on commit.
//!
//! ## Why string search (not a build plugin)
//! Tailwind class strings reach the DOM verbatim in dev (no CSS-modules hashing,
//! no rewrite), so a clicked element's `class` attribute *is* the authored
//! `className`. We locate the source by searching the project for that exact
//! literal, then disambiguate repeated strings with element context (tag, text,
//! and the nearest ancestor whose class is unique-in-source). A custom Babel/SWC
//! plugin would be more precise, but Babel breaks `next/font` and an SWC plugin
//! needs WASM authoring + a Next-version floor — neither is worth it for v1.
//!
//! Only **static** string classNames are indexed; dynamic ones (`clsx(...)`,
//! props, interpolated template literals) never match a source literal and are
//! reported read-only. A class string that matches several identical source
//! literals resolves to `Multi` — editable as a group (write all) or one at a
//! time — so the resolver never guesses a single wrong edit target.

use crate::errors::CommandError;
use crate::utils::validate_project_path;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Source file extensions we index for class literals.
const SOURCE_EXTS: &[&str] = &["tsx", "jsx", "astro"];

/// Class-bearing attribute names to scan, by file extension. React/JSX
/// (`.tsx`/`.jsx`) authors write `className`; Astro `.astro` templates use the
/// HTML `class` attribute, while React/Preact islands embedded in `.astro` still
/// use `className` — so Astro files scan for both.
fn attrs_for_ext(ext: &str) -> &'static [&'static str] {
    match ext {
        "astro" => &["className", "class"],
        _ => &["className"],
    }
}

/// Same as [`attrs_for_ext`] but from a path/filename (uses the trailing extension).
fn attrs_for_path(file: &str) -> &'static [&'static str] {
    let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    attrs_for_ext(&ext)
}

/// Signature of the clicked element, reported by the in-iframe selection script.
/// Fields are camelCase to match the script's `postMessage` payload verbatim.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementSignature {
    /// The element's exact `class` attribute (== authored className for static cases).
    pub class_name: String,
    /// Lowercased DOM tag name (e.g. "div", "section", "a").
    pub tag_name: String,
    /// Trimmed text content, if any (used to disambiguate repeated class strings).
    #[serde(default)]
    pub text: Option<String>,
    /// Ancestor class strings, nearest-first, used to anchor to a component/file.
    #[serde(default)]
    pub ancestor_classes: Vec<String>,
}

/// One source location of a className literal.
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct Location {
    /// Path relative to the project root, POSIX-style.
    pub file: String,
    /// 1-based line of the className literal's value.
    pub line: usize,
    /// 1-based column of the className literal's value.
    pub column: usize,
}

/// Result of resolving an element to a source location.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Resolution {
    /// A single confident source location was found.
    Resolved {
        /// Path relative to the project root, POSIX-style.
        file: String,
        /// 1-based line of the className literal's value.
        line: usize,
        /// 1-based column of the className literal's value.
        column: usize,
        /// The exact className string at that location (write-back's drift baseline).
        class_name: String,
        /// How the match was reached: "unique" | "tag" | "text" | "ancestor".
        confidence: String,
    },
    /// The class string matched multiple source literals we can't tell apart — all
    /// byte-identical, so it's still editable: write to all (default) or pick one.
    Multi {
        /// Every distinct source location with this class string.
        locations: Vec<Location>,
        /// The shared class string (identical at every location; the drift baseline).
        class_name: String,
    },
    /// No static source match — dynamic className, or a generated/runtime class.
    ReadOnly { reason: String },
}

/// One occurrence of a static `className="..."` literal found in source.
#[derive(Debug, Clone)]
struct Occurrence {
    class_name: String,
    /// Project-relative POSIX path.
    file: String,
    line: usize,
    column: usize,
    /// Lowercased nearest opening-tag identifier (soft signal; component tags
    /// like `Image` won't match the rendered DOM tag, so this never hard-filters).
    tag: String,
}

/// A located className literal within a single file, with byte range for surgical edits.
#[derive(Debug, Clone)]
struct Span {
    value: String,
    /// Byte offset of the first character inside the quotes.
    value_start: usize,
    /// Byte offset just past the last character inside the quotes.
    value_end: usize,
    line: usize,
    column: usize,
    tag: String,
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// React/JSX `className` only. Production callers use [`find_attr_spans`] with the
/// attribute set chosen by file extension; this thin wrapper keeps the className
/// unit tests terse.
#[cfg(test)]
fn find_classname_spans(src: &str) -> Vec<Span> {
    find_attr_spans(src, &["className"])
}

/// Find every static class string literal in a source file for the given attribute
/// names (`className` for JSX, plus `class` for Astro). Handles `attr="..."`,
/// `attr={"..."}`, single quotes, and backtick literals with no `${...}`
/// interpolation. Dynamic forms (`clsx(...)`, `class:list`, ternaries, variables)
/// are skipped — left unindexed → read-only. Hand-written rather than regex to
/// avoid catastrophic backtracking and an extra dependency.
///
/// Scanning `class` and `className` over the same source never double-counts: the
/// `=`-after-the-name check rejects the `class` prefix of a `className=` attribute
/// (the next char is `N`, not `=`), so each literal is found by exactly one needle.
fn find_attr_spans(src: &str, attrs: &[&str]) -> Vec<Span> {
    let bytes = src.as_bytes();
    let mut spans = Vec::new();
    let skip_ws = |mut k: usize| {
        while k < bytes.len() && (bytes[k] as char).is_whitespace() {
            k += 1;
        }
        k
    };

    for needle in attrs {
        let needle = *needle;
        let mut search_from = 0;
        while let Some(rel) = src[search_from..].find(needle) {
            let i = search_from + rel;
            search_from = i + needle.len();

            // Must be a standalone identifier (not `myClassName`, `setClassName`,
            // and for the `class` needle not `class Foo {}` / `classList`).
            if i > 0 && is_ident_byte(bytes[i - 1]) {
                continue;
            }

            let mut j = i + needle.len();
            j = skip_ws(j);
            if j >= bytes.len() || bytes[j] != b'=' {
                continue;
            }
            j = skip_ws(j + 1);
            // Optional JSXExpressionContainer wrapper: `={ "..." }`.
            if j < bytes.len() && bytes[j] == b'{' {
                j = skip_ws(j + 1);
            }
            if j >= bytes.len() {
                continue;
            }
            let quote = bytes[j];
            if quote != b'"' && quote != b'\'' && quote != b'`' {
                // Dynamic expression (clsx(...), a variable, cn(...)) — skip.
                continue;
            }
            let value_start = j + 1;
            // Find the matching closing quote. For " and ' there are effectively no
            // escaped quotes inside Tailwind class strings; for ` we also reject
            // interpolation.
            let mut k = value_start;
            let mut dynamic = false;
            while k < bytes.len() {
                let b = bytes[k];
                if quote == b'`' && b == b'$' && k + 1 < bytes.len() && bytes[k + 1] == b'{' {
                    dynamic = true;
                    break;
                }
                if b == quote {
                    break;
                }
                k += 1;
            }
            if dynamic || k >= bytes.len() || bytes[k] != quote {
                continue;
            }
            let value_end = k;
            let value = src[value_start..value_end].to_string();

            // 1-based line/column of value_start.
            let prefix = &src[..value_start];
            let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
            let column = value_start - prefix.rfind('\n').map(|p| p + 1).unwrap_or(0) + 1;

            // Nearest opening tag before the attribute, for soft tag matching.
            let tag = nearest_tag(&src[..i]);

            spans.push(Span {
                value,
                value_start,
                value_end,
                line,
                column,
                tag,
            });
        }
    }
    // Multiple needles scan independently; keep source order for deterministic
    // resolution and write-back.
    spans.sort_by_key(|s| s.value_start);
    spans
}

/// Walk backwards to the nearest `<Identifier` and return it lowercased.
fn nearest_tag(prefix: &str) -> String {
    if let Some(lt) = prefix.rfind('<') {
        let after = &prefix[lt + 1..];
        let ident: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_')
            .collect();
        return ident.to_ascii_lowercase();
    }
    String::new()
}

/// Short-lived cache of the per-project className index, so rapid element clicks
/// don't rescan the whole project each time. A stale entry only risks a rejected
/// save (the write-back re-verifies the source literal), never a wrong edit —
/// explicit invalidation on our own edits plus a short TTL keep it fresh.
static INDEX_CACHE: std::sync::LazyLock<
    std::sync::Mutex<
        std::collections::HashMap<
            std::path::PathBuf,
            (std::time::Instant, std::sync::Arc<Vec<Occurrence>>),
        >,
    >,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
const INDEX_TTL: std::time::Duration = std::time::Duration::from_secs(10);

/// The className index for `root`, from cache when fresh, else freshly built + stored.
fn index_occurrences_cached(root: &Path) -> std::sync::Arc<Vec<Occurrence>> {
    let key = root.to_path_buf();
    if let Ok(cache) = INDEX_CACHE.lock() {
        if let Some((at, idx)) = cache.get(&key) {
            if at.elapsed() < INDEX_TTL {
                return idx.clone();
            }
        }
    }
    let idx = std::sync::Arc::new(index_occurrences(root));
    if let Ok(mut cache) = INDEX_CACHE.lock() {
        cache.insert(key, (std::time::Instant::now(), idx.clone()));
    }
    idx
}

/// Drop the cached index for `root` after a write so the next resolve sees source.
fn invalidate_index_cache(root: &Path) {
    if let Ok(mut cache) = INDEX_CACHE.lock() {
        cache.remove(root);
    }
}

/// Index every static className occurrence under `root` (skips node_modules,
/// .next, .git, etc. via the `ignore` walker which also honors .gitignore).
fn index_occurrences(root: &Path) -> Vec<Occurrence> {
    let mut out = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(true)
        .build();
    for entry in walker.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !SOURCE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(src) = std::fs::read_to_string(path) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        for span in find_attr_spans(&src, attrs_for_ext(&ext)) {
            out.push(Occurrence {
                class_name: span.value,
                file: rel.clone(),
                line: span.line,
                column: span.column,
                tag: span.tag,
            });
        }
    }
    out
}

/// Distinct (file, line) locations among a candidate set.
fn distinct_locs(cands: &[&Occurrence]) -> usize {
    let mut set = std::collections::HashSet::new();
    for c in cands {
        set.insert((c.file.as_str(), c.line));
    }
    set.len()
}

fn resolved(o: &Occurrence, confidence: &str) -> Resolution {
    Resolution::Resolved {
        file: o.file.clone(),
        line: o.line,
        column: o.column,
        class_name: o.class_name.clone(),
        confidence: confidence.to_string(),
    }
}

/// Core resolution logic, separated from the Tauri command for unit testing.
fn resolve(occurrences: &[Occurrence], sig: &ElementSignature) -> Resolution {
    let exact: Vec<&Occurrence> = occurrences
        .iter()
        .filter(|o| o.class_name == sig.class_name)
        .collect();

    if exact.is_empty() {
        return Resolution::ReadOnly {
            reason: "These classes aren't a static string in source (dynamic or generated) — not editable in v1.".into(),
        };
    }
    if exact.len() == 1 {
        return resolved(exact[0], "unique");
    }

    // >1: narrow by tag (soft — only if it leaves candidates).
    let tag_filtered: Vec<&Occurrence> = exact
        .iter()
        .copied()
        .filter(|o| o.tag == sig.tag_name)
        .collect();
    let pool: Vec<&Occurrence> = if tag_filtered.is_empty() {
        exact.clone()
    } else {
        tag_filtered
    };
    if distinct_locs(&pool) == 1 {
        return resolved(pool[0], "tag");
    }

    // (Text-content disambiguation is a future rung — `sig.text` is captured but
    // not yet consulted; tag + ancestor anchoring already resolves ~78% on real
    // pages. See /tmp/resolver-accuracy.mjs harness.)

    // Ancestor anchor: nearest ancestor whose class is unique-in-source pins a
    // file; keep candidates in that file.
    for anc in &sig.ancestor_classes {
        let anc_occ: Vec<&Occurrence> = occurrences
            .iter()
            .filter(|o| &o.class_name == anc)
            .collect();
        if anc_occ.len() == 1 {
            let file = &anc_occ[0].file;
            let in_file: Vec<&Occurrence> =
                pool.iter().copied().filter(|o| &o.file == file).collect();
            if distinct_locs(&in_file) == 1 {
                return resolved(in_file[0], "ancestor");
            }
            // Anchored the file but still multiple lines — stop; ambiguous.
            break;
        }
    }

    // Multiple distinct source literals, all identical — editable as a group.
    let mut seen = std::collections::HashSet::new();
    let mut locations: Vec<Location> = Vec::new();
    for o in &pool {
        if seen.insert((o.file.clone(), o.line)) {
            locations.push(Location {
                file: o.file.clone(),
                line: o.line,
                column: o.column,
            });
        }
    }
    locations.sort_by(|a, b| (a.file.as_str(), a.line).cmp(&(b.file.as_str(), b.line)));
    Resolution::Multi {
        locations,
        class_name: sig.class_name.clone(),
    }
}

/// Resolve a clicked element to its source className location.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path, tag = %signature.tag_name))]
pub fn resolve_classname_source(
    project_path: String,
    signature: ElementSignature,
) -> Result<Resolution, CommandError> {
    let root = validate_project_path(&project_path)?;
    let occurrences = index_occurrences_cached(&root);
    Ok(resolve(occurrences.as_slice(), &signature))
}

/// Surgically replace one className literal's value, after verifying the current
/// value still matches `old_class` (guards against the user having edited the
/// file directly since selection). Only the literal's value is touched; the rest
/// of the file — including formatting — is preserved byte-for-byte.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, line = line))]
pub fn apply_classname_edit(
    project_path: String,
    file: String,
    line: usize,
    old_class: String,
    new_class: String,
) -> Result<(), CommandError> {
    let root = validate_project_path(&project_path)?;
    let abs = root.join(&file);
    // Defense in depth: the edited file must stay inside the project.
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_file = abs.canonicalize().map_err(CommandError::from)?;
    if !canon_file.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "file".into(),
            reason: "edit target is outside the project".into(),
        });
    }

    let src = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    let span = find_attr_spans(&src, attrs_for_path(&file))
        .into_iter()
        .find(|s| s.line == line && s.value == old_class)
        .ok_or_else(|| CommandError::Validation {
            field: "old_class".into(),
            reason: "source no longer matches — reselect the element".into(),
        })?;

    let mut updated = String::with_capacity(src.len() + new_class.len());
    updated.push_str(&src[..span.value_start]);
    updated.push_str(&new_class);
    updated.push_str(&src[span.value_end..]);

    std::fs::write(&abs, updated).map_err(CommandError::from)?;
    invalidate_index_cache(&root);
    Ok(())
}

/// Surgically replace one className literal at `file:line` if it still equals
/// `old_class`. Returns true if applied, false if the span no longer matches (drift)
/// or the file is missing/outside the project. Used by the multi-location write-back,
/// which skips stale spots rather than failing the whole batch.
fn try_replace_classname(
    root: &Path,
    canon_root: &Path,
    file: &str,
    line: usize,
    old_class: &str,
    new_class: &str,
) -> bool {
    let abs = root.join(file);
    let Ok(canon_file) = abs.canonicalize() else {
        return false;
    };
    if !canon_file.starts_with(canon_root) {
        return false;
    }
    let Ok(src) = std::fs::read_to_string(&abs) else {
        return false;
    };
    let Some(span) = find_attr_spans(&src, attrs_for_path(file))
        .into_iter()
        .find(|s| s.line == line && s.value == old_class)
    else {
        return false;
    };
    let mut updated = String::with_capacity(src.len() + new_class.len());
    updated.push_str(&src[..span.value_start]);
    updated.push_str(new_class);
    updated.push_str(&src[span.value_end..]);
    std::fs::write(&abs, updated).is_ok()
}

/// Apply the same className edit to several source locations at once (the "edit all
/// occurrences" path for a class string that appears in multiple places). Each spot
/// is verified against `old_class` independently; stale ones are skipped. Returns
/// how many were actually updated.
#[tauri::command]
#[tracing::instrument(skip(edits), fields(project = %project_path, count = edits.len()))]
pub fn apply_classname_edit_multi(
    project_path: String,
    edits: Vec<Location>,
    old_class: String,
    new_class: String,
) -> Result<usize, CommandError> {
    let root = validate_project_path(&project_path)?;
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let applied = edits
        .iter()
        .filter(|e| {
            try_replace_classname(&root, &canon_root, &e.file, e.line, &old_class, &new_class)
        })
        .count();
    invalidate_index_cache(&root);
    Ok(applied)
}

// ───────────────────────────── Text content ─────────────────────────────────
//
// Live text editing rides on the same select → resolve → write-back rails as class
// editing. We reuse class resolution as the *anchor*: once an element's className
// pins a single source location, the static text run inside that tag is the thing
// we edit. There's no Multi rung in v1 — repeated elements (a `.map`) usually carry
// per-instance copy, so "edit all" would clobber real text; we offer text editing
// only when the class resolves to one confident location.

/// Resolution of an element's text content to its source literal.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TextResolution {
    /// A single static text run was found and is editable.
    Resolved {
        /// Path relative to the project root, POSIX-style.
        file: String,
        /// 1-based line of the trimmed text run.
        line: usize,
        /// 1-based column of the trimmed text run.
        column: usize,
        /// Current static text (trimmed) — the write-back's drift baseline.
        text: String,
        /// How the underlying element was reached: "unique" | "tag" | "ancestor".
        confidence: String,
    },
    /// The text isn't a plain editable string (dynamic, mixed, or ambiguous element).
    ReadOnly { reason: String },
}

/// A located static text run between an opening tag's `>` and the next `</`.
#[derive(Debug, Clone)]
struct TextSpan {
    /// Trimmed text — what the user edits.
    value: String,
    /// Byte offset of the first non-whitespace text character.
    value_start: usize,
    /// Byte offset just past the last non-whitespace text character.
    value_end: usize,
    line: usize,
    column: usize,
}

/// 1-based (line, column) of a byte offset in `src`.
fn line_col(src: &str, byte: usize) -> (usize, usize) {
    let prefix = &src[..byte];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let column = byte - prefix.rfind('\n').map(|p| p + 1).unwrap_or(0) + 1;
    (line, column)
}

/// Starting just after a className value's closing quote, find the opening tag's
/// real `>` — skipping `>` inside attribute strings and `{…}` expressions (e.g.
/// `style={{}}`, `onClick={() => a > b}`) — then the static text run up to the next
/// `<`. Returns None for self-closing tags, an element-first child (mixed content),
/// empty/whitespace-only runs, or dynamic text (`{…}`).
fn text_run_in_tag(src: &str, after_quote: usize) -> Option<TextSpan> {
    let bytes = src.as_bytes();
    let mut i = after_quote;
    let mut in_str: u8 = 0; // the quote char while inside an attribute string, else 0
    let mut depth: i32 = 0; // `{…}` expression depth within the opening tag
    let mut gt: Option<usize> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str != 0 {
            if b == in_str {
                in_str = 0;
            }
        } else if b == b'"' || b == b'\'' || b == b'`' {
            in_str = b;
        } else if b == b'{' {
            depth += 1;
        } else if b == b'}' {
            depth = (depth - 1).max(0);
        } else if depth == 0 {
            if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'>' {
                return None; // self-closing — no children
            }
            if b == b'>' {
                gt = Some(i);
                break;
            }
        }
        i += 1;
    }
    let gt = gt?;
    let run_start = gt + 1;
    let mut j = run_start;
    while j < bytes.len() && bytes[j] != b'<' {
        j += 1;
    }
    if j >= bytes.len() || !src[j..].starts_with("</") {
        return None; // element-first child (mixed content) or unterminated
    }
    let run = &src[run_start..j];
    if run.contains('{') {
        return None; // dynamic text
    }
    let trimmed = run.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lead = run.len() - run.trim_start().len();
    let value_start = run_start + lead;
    let value_end = value_start + trimmed.len();
    let (line, column) = line_col(src, value_start);
    Some(TextSpan {
        value: trimmed.to_string(),
        value_start,
        value_end,
        line,
        column,
    })
}

/// Every static leaf text run in a file (text between `>` and `</` with no `{…}`).
/// The text write-back uses this to re-locate a span by (line, value). A stray `>`
/// inside an expression can yield a spurious entry, but the write-back matches on
/// exact (line, old_text) and re-verifies, so a false span never drives a wrong edit.
fn find_text_spans(src: &str) -> Vec<TextSpan> {
    let bytes = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'>' {
            i += 1;
            continue;
        }
        let run_start = i + 1;
        let mut j = run_start;
        while j < bytes.len() && bytes[j] != b'<' {
            j += 1;
        }
        if j < bytes.len() && src[j..].starts_with("</") {
            let run = &src[run_start..j];
            if !run.contains('{') {
                let trimmed = run.trim();
                if !trimmed.is_empty() {
                    let lead = run.len() - run.trim_start().len();
                    let value_start = run_start + lead;
                    let value_end = value_start + trimmed.len();
                    let (line, column) = line_col(src, value_start);
                    out.push(TextSpan {
                        value: trimmed.to_string(),
                        value_start,
                        value_end,
                        line,
                        column,
                    });
                }
            }
        }
        i = j.max(run_start);
    }
    out
}

/// Resolve a clicked element to its editable text source. Anchors on class
/// resolution, then locates the static text run inside the resolved tag.
#[tauri::command]
#[tracing::instrument(skip(signature), fields(project = %project_path, tag = %signature.tag_name))]
pub fn resolve_text_source(
    project_path: String,
    signature: ElementSignature,
) -> Result<TextResolution, CommandError> {
    let root = validate_project_path(&project_path)?;
    let occurrences = index_occurrences_cached(&root);
    match resolve(occurrences.as_slice(), &signature) {
        Resolution::Resolved {
            file,
            line,
            class_name,
            confidence,
            ..
        } => {
            let abs = root.join(&file);
            let Ok(src) = std::fs::read_to_string(&abs) else {
                return Ok(TextResolution::ReadOnly {
                    reason: "Could not read the source file.".into(),
                });
            };
            // Re-find the className span we resolved to, then read the text after its tag.
            let span = find_attr_spans(&src, attrs_for_path(&file))
                .into_iter()
                .find(|s| s.line == line && s.value == class_name);
            let Some(span) = span else {
                return Ok(TextResolution::ReadOnly {
                    reason: "Source changed — reselect the element.".into(),
                });
            };
            // value_end points at the closing quote; scan from just after it.
            match text_run_in_tag(&src, span.value_end + 1) {
                Some(ts) => Ok(TextResolution::Resolved {
                    file,
                    line: ts.line,
                    column: ts.column,
                    text: ts.value,
                    confidence,
                }),
                None => Ok(TextResolution::ReadOnly {
                    reason: "This text isn't a plain string in source (dynamic, empty, or wraps nested elements)."
                        .into(),
                }),
            }
        }
        Resolution::Multi { .. } => Ok(TextResolution::ReadOnly {
            reason: "This element appears in several places — text editing needs a single, unique element.".into(),
        }),
        Resolution::ReadOnly { reason } => Ok(TextResolution::ReadOnly { reason }),
    }
}

/// Surgically replace one static text run's value, after verifying the current text
/// still equals `old_text` (drift guard). Only the trimmed run is touched —
/// surrounding whitespace and the rest of the file are preserved byte-for-byte.
/// Rejects `<`/`{` in the replacement: both break JSX/Astro markup.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, line = line))]
pub fn apply_text_edit(
    project_path: String,
    file: String,
    line: usize,
    old_text: String,
    new_text: String,
) -> Result<(), CommandError> {
    if new_text.contains('<') || new_text.contains('{') {
        return Err(CommandError::Validation {
            field: "new_text".into(),
            reason: "Text can't contain '<' or '{' — those break the markup.".into(),
        });
    }
    let root = validate_project_path(&project_path)?;
    let abs = root.join(&file);
    // Defense in depth: the edited file must stay inside the project.
    let canon_root = root.canonicalize().map_err(CommandError::from)?;
    let canon_file = abs.canonicalize().map_err(CommandError::from)?;
    if !canon_file.starts_with(&canon_root) {
        return Err(CommandError::Validation {
            field: "file".into(),
            reason: "edit target is outside the project".into(),
        });
    }

    let src = std::fs::read_to_string(&abs).map_err(CommandError::from)?;
    let span = find_text_spans(&src)
        .into_iter()
        .find(|s| s.line == line && s.value == old_text)
        .ok_or_else(|| CommandError::Validation {
            field: "old_text".into(),
            reason: "source no longer matches — reselect the element".into(),
        })?;

    let mut updated = String::with_capacity(src.len() + new_text.len());
    updated.push_str(&src[..span.value_start]);
    updated.push_str(&new_text);
    updated.push_str(&src[span.value_end..]);

    std::fs::write(&abs, updated).map_err(CommandError::from)?;
    invalidate_index_cache(&root);
    Ok(())
}

// ───────────────────────────── Breakpoints ──────────────────────────────────

/// A responsive breakpoint the editor can target (serialized to the frontend as
/// `{name, prefix, minPx}`). The frontend prepends the base (unprefixed) layer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Breakpoint {
    /// Display name == the Tailwind variant key (e.g. "md", "2xl", or a custom name).
    pub name: String,
    /// Variant prefix without the colon — same as `name` for responsive breakpoints.
    pub prefix: String,
    /// Min-width the breakpoint activates at, in px.
    pub min_px: u32,
}

/// Tailwind's default breakpoints (px), the base set before project overrides.
const DEFAULT_BREAKPOINTS: &[(&str, u32)] = &[
    ("sm", 640),
    ("md", 768),
    ("lg", 1024),
    ("xl", 1280),
    ("2xl", 1536),
];

/// Parse a CSS length to px. Supports rem/em (×16), px, and unitless (treated as
/// px). Returns None for anything we can't resolve to a fixed px (var(), calc(), %).
fn parse_len_px(raw: &str) -> Option<u32> {
    let s = raw.trim();
    let (num, mult) = if let Some(n) = s.strip_suffix("rem") {
        (n, 16.0)
    } else if let Some(n) = s.strip_suffix("em") {
        (n, 16.0)
    } else if let Some(n) = s.strip_suffix("px") {
        (n, 1.0)
    } else {
        (s, 1.0)
    };
    let v: f64 = num.trim().parse().ok()?;
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    Some((v * mult).round() as u32)
}

/// Apply Tailwind v4 `--breakpoint-*` declarations from `css` onto `map`. Handles
/// `--breakpoint-*: initial` (clear all defaults) and `--breakpoint-<name>: initial`
/// (remove one). Returns true if any `--breakpoint-` declaration was seen, so the
/// caller knows this is a v4 project and can skip v3 config parsing.
fn apply_css_breakpoints(css: &str, map: &mut std::collections::BTreeMap<String, u32>) -> bool {
    let mut seen = false;
    for line in css.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("--breakpoint-") else {
            continue;
        };
        let Some((name, value)) = rest.split_once(':') else {
            continue;
        };
        let name = name.trim();
        // Value is everything up to the terminating `;` or an inline `/* … */`.
        let value = value.split(';').next().unwrap_or("");
        let value = value.split("/*").next().unwrap_or("").trim();
        seen = true;
        if value == "initial" {
            if name == "*" {
                map.clear();
            } else {
                map.remove(name);
            }
            continue;
        }
        if name == "*" {
            continue; // `--breakpoint-*: <len>` isn't meaningful
        }
        if let Some(px) = parse_len_px(value) {
            map.insert(name.to_string(), px);
        }
    }
    seen
}

/// Best-effort: merge a v3 `screens: { name: 'value', … }` string-literal map from
/// a config file onto `map`. Bails on anything that isn't a simple literal block
/// (spreads, function values, `min`/`max` objects) — those keep the defaults.
fn apply_v3_screens(config: &str, map: &mut std::collections::BTreeMap<String, u32>) {
    let Some(idx) = config.find("screens") else {
        return;
    };
    let after = &config[idx + "screens".len()..];
    let Some(brace) = after.find('{') else {
        return;
    };
    // Between `screens` and `{` only ws/`:` may appear (else it's not `screens: {`).
    if after[..brace]
        .chars()
        .any(|c| !c.is_whitespace() && c != ':')
    {
        return;
    }
    let body = &after[brace + 1..];
    let Some(end) = body.find('}') else {
        return;
    };
    for part in body[..end].split(',') {
        let Some((k, v)) = part.split_once(':') else {
            continue;
        };
        let trim_q = |s: &str| {
            s.trim()
                .trim_matches(|c| c == '\'' || c == '"' || c == '`')
                .trim()
                .to_string()
        };
        let key = trim_q(k);
        let val = trim_q(v);
        if key.is_empty() {
            continue;
        }
        if let Some(px) = parse_len_px(&val) {
            map.insert(key, px);
        }
    }
}

/// Detect the project's Tailwind breakpoints. Tailwind v4 `@theme { --breakpoint-* }`
/// is the primary source (scanned from the project's CSS); v3 `theme.screens` is a
/// best-effort fallback; a missing/unparseable config yields Tailwind's defaults.
/// Returns only the real responsive breakpoints — the frontend prepends the base layer.
/// Whether Tailwind is actually wired into the project's build — so the utility
/// classes the visual editor writes will compile. A bare `@import "tailwindcss"`
/// in a CSS file does NOTHING without the Vite/PostCSS plugin (or a v3 config), so
/// we require a real integration. Used to gate the editor: no Tailwind → no editor.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn is_tailwind_active(project_path: String) -> Result<bool, CommandError> {
    let root = validate_project_path(&project_path)?;
    Ok(tailwind_active_at(&root))
}

/// Core of [`is_tailwind_active`], split out (no path validation) for unit testing.
fn tailwind_active_at(root: &Path) -> bool {
    // A v3-style config file present is a definitive signal.
    for name in [
        "tailwind.config.js",
        "tailwind.config.ts",
        "tailwind.config.cjs",
        "tailwind.config.mjs",
    ] {
        if root.join(name).exists() {
            return true;
        }
    }

    // Otherwise a build config must wire Tailwind in (the Vite/PostCSS plugin or the
    // Astro integration). We look for any mention of "tailwind" in the build configs.
    for name in [
        "astro.config.mjs",
        "astro.config.ts",
        "astro.config.js",
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "next.config.js",
        "next.config.mjs",
        "next.config.ts",
        "postcss.config.js",
        "postcss.config.cjs",
        "postcss.config.mjs",
        "postcss.config.json",
        ".postcssrc.json",
        ".postcssrc.js",
        ".postcssrc",
    ] {
        if let Ok(contents) = std::fs::read_to_string(root.join(name)) {
            if contents.contains("tailwind") {
                return true;
            }
        }
    }

    false
}

#[tauri::command]
#[tracing::instrument(fields(project = %project_path))]
pub fn detect_breakpoints(project_path: String) -> Result<Vec<Breakpoint>, CommandError> {
    let root = validate_project_path(&project_path)?;
    let mut map: std::collections::BTreeMap<String, u32> = DEFAULT_BREAKPOINTS
        .iter()
        .map(|(n, px)| (n.to_string(), *px))
        .collect();

    // v4: scan project CSS (the `ignore` walker skips node_modules/.next/.git).
    let mut css_touched = false;
    for entry in ignore::WalkBuilder::new(&root)
        .standard_filters(true)
        .build()
        .flatten()
    {
        let path = entry.path();
        let is_css = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("css"))
            .unwrap_or(false);
        if !is_css {
            continue;
        }
        if let Ok(css) = std::fs::read_to_string(path) {
            css_touched |= apply_css_breakpoints(&css, &mut map);
        }
    }

    // v3: only when there's no v4 signal, best-effort parse the config's screens map.
    if !css_touched {
        for name in &[
            "tailwind.config.js",
            "tailwind.config.ts",
            "tailwind.config.cjs",
            "tailwind.config.mjs",
        ] {
            if let Ok(cfg) = std::fs::read_to_string(root.join(name)) {
                apply_v3_screens(&cfg, &mut map);
                break;
            }
        }
    }

    let mut bps: Vec<Breakpoint> = map
        .into_iter()
        .map(|(name, min_px)| Breakpoint {
            prefix: name.clone(),
            name,
            min_px,
        })
        .collect();
    bps.sort_by_key(|b| b.min_px);
    Ok(bps)
}

// ───────────────────────── Component usage ("where is this used") ────────────

/// How a source file is rendered: a route Page, a Layout (wraps many pages), or a
/// reusable Component.
#[derive(Debug, PartialEq)]
enum FileKind {
    Page,
    Layout,
    Component,
}

impl FileKind {
    fn as_str(&self) -> &'static str {
        match self {
            FileKind::Page => "page",
            FileKind::Layout => "layout",
            FileKind::Component => "component",
        }
    }
}

/// Classify a project-relative path by framework routing conventions
/// (Astro file-based routing, then Next.js App + Pages router).
fn classify_file(rel: &str) -> FileKind {
    let base = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();

    // Astro: file-based routing. An `.astro` under `pages/` is a route; one under
    // `layouts/` wraps the pages that import it; everything else is a component.
    if base.ends_with(".astro") {
        let lower = rel.to_ascii_lowercase();
        if lower.contains("pages/") {
            return FileKind::Page;
        }
        if lower.contains("layouts/") {
            return FileKind::Layout;
        }
        return FileKind::Component;
    }

    // Next.js (App + Pages router).
    if base.starts_with("page.") {
        return FileKind::Page; // App Router route segment
    }
    if base.starts_with("layout.") || base.starts_with("_app.") {
        return FileKind::Layout; // wraps every page under it
    }
    if rel.starts_with("pages/") && !base.starts_with('_') {
        return FileKind::Page; // Pages Router
    }
    FileKind::Component
}

/// The name in a component-declaration line (`function Foo`, `const Foo =`,
/// `class Foo`), if its first letter is uppercase (a React component).
fn decl_name(line: &str) -> Option<String> {
    let mut s = line.trim_start();
    for kw in ["export ", "default ", "async ", "pub "] {
        if let Some(rest) = s.strip_prefix(kw) {
            s = rest.trim_start();
        }
    }
    let rest = ["function ", "const ", "let ", "var ", "class "]
        .iter()
        .find_map(|kw| s.strip_prefix(kw))?;
    let name: String = rest
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    if name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
        Some(name)
    } else {
        None
    }
}

/// An `.astro` file *is* a component — there's no `function Foo` to scan for. Its
/// name is the PascalCase basename used at import sites (`Header.astro` → `Header`),
/// so `<Header` usage scanning can find it. Returns None for `index.astro`-style
/// route files only in the sense that the name is still derived; callers gate on
/// `self_kind` (a page isn't rendered as `<Component>` anywhere).
fn astro_component_name(file: &str) -> Option<String> {
    let base = file.rsplit('/').next().unwrap_or(file);
    let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
    (!stem.is_empty()).then(|| stem.to_string())
}

/// The component that encloses `line` (1-based): the nearest component declaration
/// scanning upward. Heuristic, but accurate for top-level components.
fn enclosing_component(src: &str, line: usize) -> Option<String> {
    let lines: Vec<&str> = src.lines().collect();
    let start = line.min(lines.len());
    (0..start).rev().find_map(|i| decl_name(lines[i]))
}

/// Every line where `<Name` is rendered as JSX in `src` (boundary-checked so
/// `<Header` doesn't match `<HeaderBar`).
fn find_jsx_usages(src: &str, name: &str) -> Vec<usize> {
    let bytes = src.as_bytes();
    let needle = format!("<{name}");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = src[from..].find(&needle) {
        let i = from + rel;
        from = i + needle.len();
        if bytes
            .get(i + needle.len())
            .copied()
            .is_some_and(is_ident_byte)
        {
            continue; // <HeaderBar
        }
        out.push(src[..i].bytes().filter(|&b| b == b'\n').count() + 1);
    }
    out
}

/// One place a component is rendered.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSite {
    file: String,
    line: usize,
    /// "page" | "layout" | "component"
    kind: String,
}

/// Where an edited element's component is used across the project — drives the
/// "this also appears in N places" scope hint.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// The enclosing component name, if we could determine it.
    component: Option<String>,
    /// Kind of the edited file itself (page = only this page; layout = every page).
    self_kind: String,
    /// Every `<Component>` render site found in source.
    sites: Vec<UsageSite>,
}

/// Find where the component containing `file:line` is rendered across the project.
/// Used to warn that editing a shared component changes it everywhere it appears.
#[tauri::command]
#[tracing::instrument(fields(project = %project_path, file = %file, line = line))]
pub fn find_component_usage(
    project_path: String,
    file: String,
    line: usize,
) -> Result<UsageReport, CommandError> {
    let root = validate_project_path(&project_path)?;
    let src = std::fs::read_to_string(root.join(&file)).unwrap_or_default();
    // `.astro` files have no JS component declaration to scan for — the component
    // name is the filename (used verbatim at `<Header>` import sites).
    let component = enclosing_component(&src, line).or_else(|| {
        file.to_ascii_lowercase()
            .ends_with(".astro")
            .then(|| astro_component_name(&file))
            .flatten()
    });
    let self_kind = classify_file(&file).as_str().to_string();

    let mut sites = Vec::new();
    if let Some(name) = &component {
        for entry in ignore::WalkBuilder::new(&root)
            .standard_filters(true)
            .build()
            .flatten()
        {
            let path = entry.path();
            let is_src = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| SOURCE_EXTS.contains(&e))
                .unwrap_or(false);
            if !is_src {
                continue;
            }
            let Ok(s) = std::fs::read_to_string(path) else {
                continue;
            };
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            for ln in find_jsx_usages(&s, name) {
                let kind = classify_file(&rel).as_str().to_string();
                sites.push(UsageSite {
                    file: rel.clone(),
                    line: ln,
                    kind,
                });
            }
        }
        sites.sort_by(|a, b| {
            (a.kind.as_str(), a.file.as_str(), a.line).cmp(&(
                b.kind.as_str(),
                b.file.as_str(),
                b.line,
            ))
        });
    }

    Ok(UsageReport {
        component,
        self_kind,
        sites,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(class: &str, tag: &str, ancestors: &[&str]) -> ElementSignature {
        ElementSignature {
            class_name: class.into(),
            tag_name: tag.into(),
            text: None,
            ancestor_classes: ancestors.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn finds_static_classnames_skips_dynamic() {
        let src = r#"
            export function C() {
              return (
                <div className="flex p-4">
                  <span className={"text-sm"}>hi</span>
                  <a className={clsx("a", b)}>x</a>
                  <p className={`pad-${n}`}>y</p>
                  <b className={`static-tpl`}>z</b>
                </div>
              );
            }
        "#;
        let spans = find_classname_spans(src);
        let values: Vec<&str> = spans.iter().map(|s| s.value.as_str()).collect();
        assert!(values.contains(&"flex p-4"));
        assert!(values.contains(&"text-sm"));
        assert!(values.contains(&"static-tpl"));
        // clsx(...) and `pad-${n}` are dynamic — not indexed.
        assert!(!values.iter().any(|v| v.contains("a") && v.len() == 1));
        assert!(!values.contains(&"pad-"));
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn does_not_match_identifier_substrings() {
        let src = r#"const myClassName = "x"; setClassName("y");"#;
        assert!(find_classname_spans(src).is_empty());
    }

    #[test]
    fn span_line_and_tag_are_correct() {
        let src = "<section className=\"a b\">\n  <div className=\"c\" />\n</section>";
        let spans = find_classname_spans(src);
        assert_eq!(spans[0].value, "a b");
        assert_eq!(spans[0].line, 1);
        assert_eq!(spans[0].tag, "section");
        assert_eq!(spans[1].value, "c");
        assert_eq!(spans[1].line, 2);
        assert_eq!(spans[1].tag, "div");
    }

    #[test]
    fn astro_scans_both_class_and_classname() {
        // An .astro file: HTML `class` in the template, plus `className` on an
        // embedded React island, plus dynamic forms that must stay read-only.
        let src = r#"---
import Card from '../components/Card.astro';
const items = [];
---
<section class="flex p-4">
  <h1 class="text-2xl font-bold">Hi</h1>
  <ul class:list={["a", "b"]}>
    <li class={items.length ? "on" : "off"}>x</li>
  </ul>
  <ReactWidget className="grid gap-2" />
</section>"#;
        let spans = find_attr_spans(src, attrs_for_ext("astro"));
        let values: Vec<&str> = spans.iter().map(|s| s.value.as_str()).collect();
        assert!(values.contains(&"flex p-4"));
        assert!(values.contains(&"text-2xl font-bold"));
        assert!(values.contains(&"grid gap-2")); // island className
                                                 // class:list and the ternary class={...} are dynamic — not indexed.
        assert!(!values.contains(&"on"));
        assert!(!values.contains(&"off"));
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn class_needle_does_not_double_count_classname() {
        // Scanning both names over `className="..."` must yield exactly one span:
        // the `class` prefix is rejected because the next char is `N`, not `=`.
        let src = r#"<div className="flex" />"#;
        let spans = find_attr_spans(src, attrs_for_ext("astro"));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].value, "flex");
    }

    #[test]
    fn class_needle_ignores_js_class_declarations() {
        // Astro frontmatter is JS/TS — a `class Foo {}` must not be picked up.
        let src = "---\nclass Foo { bar = 1; }\n---\n<div class=\"p-2\" />";
        let spans = find_attr_spans(src, attrs_for_ext("astro"));
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].value, "p-2");
    }

    #[test]
    fn astro_component_name_from_filename() {
        assert_eq!(
            astro_component_name("src/components/Header.astro").as_deref(),
            Some("Header")
        );
        assert_eq!(
            astro_component_name("Footer.astro").as_deref(),
            Some("Footer")
        );
    }

    fn occ(class: &str, file: &str, line: usize, tag: &str) -> Occurrence {
        Occurrence {
            class_name: class.into(),
            file: file.into(),
            line,
            column: 1,
            tag: tag.into(),
        }
    }

    #[test]
    fn resolves_unique_string() {
        let occs = vec![occ("flex p-4", "a.tsx", 3, "div")];
        match resolve(&occs, &sig("flex p-4", "div", &[])) {
            Resolution::Resolved {
                confidence, file, ..
            } => {
                assert_eq!(confidence, "unique");
                assert_eq!(file, "a.tsx");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn dynamic_or_missing_is_read_only() {
        let occs = vec![occ("flex", "a.tsx", 1, "div")];
        assert!(matches!(
            resolve(&occs, &sig("bg-red-500 dynamic", "div", &[])),
            Resolution::ReadOnly { .. }
        ));
    }

    #[test]
    fn disambiguates_by_tag() {
        let occs = vec![
            occ("p-2", "a.tsx", 1, "div"),
            occ("p-2", "a.tsx", 2, "span"),
        ];
        match resolve(&occs, &sig("p-2", "span", &[])) {
            Resolution::Resolved {
                line, confidence, ..
            } => {
                assert_eq!(line, 2);
                assert_eq!(confidence, "tag");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn anchors_to_unique_ancestor_file() {
        // "flex" appears in two files; the unique ancestor pins the right one.
        let occs = vec![
            occ("flex", "Hero.tsx", 5, "div"),
            occ("flex", "Footer.tsx", 9, "div"),
            occ("hero-wrap unique", "Hero.tsx", 2, "section"),
        ];
        match resolve(&occs, &sig("flex", "div", &["hero-wrap unique"])) {
            Resolution::Resolved {
                file,
                line,
                confidence,
                ..
            } => {
                assert_eq!(file, "Hero.tsx");
                assert_eq!(line, 5);
                assert_eq!(confidence, "ancestor");
            }
            other => panic!("expected Resolved, got {other:?}"),
        }
    }

    #[test]
    fn unresolvable_repeats_are_multi_editable() {
        let occs = vec![
            occ("flex", "a.tsx", 1, "div"),
            occ("flex", "b.tsx", 1, "div"),
        ];
        match resolve(&occs, &sig("flex", "div", &["also-not-unique"])) {
            Resolution::Multi {
                locations,
                class_name,
            } => {
                assert_eq!(locations.len(), 2);
                assert_eq!(class_name, "flex");
                // Sorted by (file, line).
                assert_eq!(locations[0].file, "a.tsx");
                assert_eq!(locations[1].file, "b.tsx");
            }
            other => panic!("expected Multi, got {other:?}"),
        }
    }

    #[test]
    fn write_back_replaces_only_the_value() {
        let dir = std::env::temp_dir().join(format!("ss-edit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("C.tsx");
        std::fs::write(&file, "const x=1;\n<div className=\"p-4 flex\">\n").unwrap();

        let spans = find_classname_spans(&std::fs::read_to_string(&file).unwrap());
        assert_eq!(spans[0].value, "p-4 flex");

        // Simulate the write-back's surgical replacement directly (command layer
        // adds path validation we can't exercise outside the ShipStudio root).
        let src = std::fs::read_to_string(&file).unwrap();
        let span = find_classname_spans(&src)
            .into_iter()
            .find(|s| s.line == 2 && s.value == "p-4 flex")
            .unwrap();
        let mut updated = String::new();
        updated.push_str(&src[..span.value_start]);
        updated.push_str("p-6 flex");
        updated.push_str(&src[span.value_end..]);
        std::fs::write(&file, &updated).unwrap();

        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, "const x=1;\n<div className=\"p-6 flex\">\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn multi_write_back_updates_matches_skips_drift() {
        let dir = std::env::temp_dir().join(format!("ss-multi-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let canon_root = dir.canonicalize().unwrap();
        let a = dir.join("A.tsx");
        let b = dir.join("B.tsx");
        let c = dir.join("C.tsx");
        std::fs::write(&a, "<div className=\"flex p-4\" />\n").unwrap();
        std::fs::write(&b, "x\n<span className=\"flex p-4\" />\n").unwrap();
        std::fs::write(&c, "<div className=\"other\" />\n").unwrap(); // drift: won't match

        let replaced = |file: &str, line: usize| {
            try_replace_classname(&dir, &canon_root, file, line, "flex p-4", "flex p-8")
        };
        assert!(replaced("A.tsx", 1));
        assert!(replaced("B.tsx", 2));
        assert!(!replaced("C.tsx", 1)); // value differs → skipped
        assert!(!replaced("A.tsx", 99)); // wrong line → skipped

        assert_eq!(
            std::fs::read_to_string(&a).unwrap(),
            "<div className=\"flex p-8\" />\n"
        );
        assert_eq!(
            std::fs::read_to_string(&b).unwrap(),
            "x\n<span className=\"flex p-8\" />\n"
        );
        assert_eq!(
            std::fs::read_to_string(&c).unwrap(),
            "<div className=\"other\" />\n"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── Text content ──────────────────────────────────────────────────────

    /// Locate the text after the (single) className span in `src`.
    fn text_after_class(src: &str) -> Option<TextSpan> {
        let span = find_classname_spans(src).into_iter().next()?;
        text_run_in_tag(src, span.value_end + 1)
    }

    #[test]
    fn text_run_reads_plain_leaf_text() {
        let src = "<h1 className=\"hero\">Welcome to Trase</h1>";
        let ts = text_after_class(src).unwrap();
        assert_eq!(ts.value, "Welcome to Trase");
        assert_eq!(ts.line, 1);
        // Edits the trimmed run only.
        assert_eq!(&src[ts.value_start..ts.value_end], "Welcome to Trase");
    }

    #[test]
    fn text_run_trims_surrounding_whitespace() {
        let src = "<h1 className=\"hero\">\n  Welcome\n</h1>";
        let ts = text_after_class(src).unwrap();
        assert_eq!(ts.value, "Welcome");
        assert_eq!(ts.line, 2);
        assert_eq!(&src[ts.value_start..ts.value_end], "Welcome");
    }

    #[test]
    fn text_run_rejects_dynamic_mixed_and_selfclosing() {
        // Dynamic expression child.
        assert!(text_after_class("<h1 className=\"a\">{title}</h1>").is_none());
        // Partially dynamic.
        assert!(text_after_class("<h1 className=\"a\">Total: {n}</h1>").is_none());
        // Element-first child (mixed content).
        assert!(text_after_class("<p className=\"a\"><b>x</b> y</p>").is_none());
        // Self-closing.
        assert!(text_after_class("<img className=\"a\" />").is_none());
        // Empty.
        assert!(text_after_class("<div className=\"a\"></div>").is_none());
    }

    #[test]
    fn text_run_ignores_gt_inside_attrs_and_expressions() {
        // `>` inside an attribute string and inside a `{…}` expression must not be
        // mistaken for the tag close.
        let src = "<button className=\"b\" title=\"a > b\" onClick={() => go(1>0)}>Click</button>";
        let ts = text_after_class(src).unwrap();
        assert_eq!(ts.value, "Click");
    }

    #[test]
    fn text_run_handles_astro_class_attr() {
        let src = "<h1 class=\"title\">Hello Astro</h1>";
        let span = find_attr_spans(src, attrs_for_ext("astro"))
            .into_iter()
            .next()
            .unwrap();
        let ts = text_run_in_tag(src, span.value_end + 1).unwrap();
        assert_eq!(ts.value, "Hello Astro");
    }

    #[test]
    fn text_write_back_replaces_only_trimmed_run() {
        let src = "<h1 className=\"hero\">\n  Old Title\n</h1>\n";
        let span = find_text_spans(src)
            .into_iter()
            .find(|s| s.value == "Old Title")
            .unwrap();
        let mut updated = String::new();
        updated.push_str(&src[..span.value_start]);
        updated.push_str("New Title");
        updated.push_str(&src[span.value_end..]);
        // Surrounding whitespace/newlines preserved.
        assert_eq!(updated, "<h1 className=\"hero\">\n  New Title\n</h1>\n");
    }

    #[test]
    fn find_text_spans_locates_by_line_and_value() {
        let src = "<a className=\"x\">Home</a>\n<a className=\"y\">About</a>\n";
        let spans = find_text_spans(src);
        let home = spans.iter().find(|s| s.value == "Home").unwrap();
        let about = spans.iter().find(|s| s.value == "About").unwrap();
        assert_eq!(home.line, 1);
        assert_eq!(about.line, 2);
    }

    use std::collections::BTreeMap;
    fn default_map() -> BTreeMap<String, u32> {
        DEFAULT_BREAKPOINTS
            .iter()
            .map(|(n, p)| (n.to_string(), *p))
            .collect()
    }

    #[test]
    fn classify_file_by_next_conventions() {
        assert_eq!(classify_file("app/about/page.tsx"), FileKind::Page);
        assert_eq!(classify_file("app/layout.tsx"), FileKind::Layout);
        assert_eq!(classify_file("app/blog/layout.jsx"), FileKind::Layout);
        assert_eq!(classify_file("components/Header.tsx"), FileKind::Component);
        assert_eq!(classify_file("pages/about.tsx"), FileKind::Page);
        assert_eq!(classify_file("pages/_app.tsx"), FileKind::Layout);
    }

    #[test]
    fn classify_file_by_astro_conventions() {
        assert_eq!(classify_file("src/pages/index.astro"), FileKind::Page);
        assert_eq!(classify_file("src/pages/blog/[slug].astro"), FileKind::Page);
        assert_eq!(classify_file("src/layouts/Base.astro"), FileKind::Layout);
        assert_eq!(
            classify_file("src/components/Header.astro"),
            FileKind::Component
        );
    }

    #[test]
    fn enclosing_component_finds_the_wrapping_component() {
        let src =
            "import x;\nexport default function Hero() {\n  return <h1 className=\"a\" />;\n}\n";
        assert_eq!(enclosing_component(src, 3).as_deref(), Some("Hero"));
        let src2 = "const Card = () => {\n  return <div className=\"c\" />;\n};\n";
        assert_eq!(enclosing_component(src2, 2).as_deref(), Some("Card"));
        // A lowercase helper isn't a component.
        let src3 = "function helper() {\n  return null;\n}\n";
        assert_eq!(enclosing_component(src3, 2), None);
    }

    #[test]
    fn find_jsx_usages_is_boundary_checked() {
        let src = "<Hero />\n<HeroBar/>\n<div><Hero></Hero></div>\n";
        assert_eq!(find_jsx_usages(src, "Hero"), vec![1, 3]); // not <HeroBar
        assert_eq!(find_jsx_usages(src, "HeroBar"), vec![2]);
    }

    #[test]
    fn parse_len_px_units() {
        assert_eq!(parse_len_px("48rem"), Some(768)); // rem → ×16
        assert_eq!(parse_len_px("40rem"), Some(640));
        assert_eq!(parse_len_px("768px"), Some(768));
        assert_eq!(parse_len_px("768"), Some(768)); // unitless → px
        assert_eq!(parse_len_px("var(--x)"), None);
        assert_eq!(parse_len_px("calc(100% - 1px)"), None);
    }

    #[test]
    fn css_breakpoints_override_remove_and_custom() {
        let mut map = default_map();
        let css = r#"
            @theme {
              --breakpoint-md: 50rem;     /* override */
              --breakpoint-lg: initial;   /* remove */
              --breakpoint-tablet: 900px; /* custom */
            }
        "#;
        assert!(apply_css_breakpoints(css, &mut map));
        assert_eq!(map.get("md"), Some(&800)); // 50rem
        assert_eq!(map.get("lg"), None); // removed
        assert_eq!(map.get("tablet"), Some(&900)); // custom name
        assert_eq!(map.get("sm"), Some(&640)); // untouched default kept
    }

    #[test]
    fn css_wildcard_initial_clears_defaults() {
        let mut map = default_map();
        let css = "--breakpoint-*: initial;\n--breakpoint-md: 768px;";
        assert!(apply_css_breakpoints(css, &mut map));
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("md"), Some(&768));
    }

    #[test]
    fn no_css_breakpoints_is_not_touched() {
        let mut map = default_map();
        // A var() usage that merely mentions --breakpoint must not count as a decl.
        assert!(!apply_css_breakpoints(
            "width: var(--breakpoint-md);",
            &mut map
        ));
        assert_eq!(map.len(), DEFAULT_BREAKPOINTS.len());
    }

    #[test]
    fn v3_screens_literal_merges() {
        let mut map = default_map();
        let cfg = r#"module.exports = { theme: { screens: { sm: '480px', md: "800px" } } };"#;
        apply_v3_screens(cfg, &mut map);
        assert_eq!(map.get("sm"), Some(&480));
        assert_eq!(map.get("md"), Some(&800));
        assert_eq!(map.get("lg"), Some(&1024)); // default kept
    }

    #[test]
    fn v3_screens_non_literal_is_ignored() {
        let mut map = default_map();
        // function/spread screens → keep defaults, don't crash.
        let cfg = r#"export default { theme: { screens: require('./bp') } }"#;
        apply_v3_screens(cfg, &mut map);
        assert_eq!(map, default_map());
    }

    #[test]
    fn tailwind_active_requires_a_real_integration() {
        let dir = std::env::temp_dir().join(format!("ss-tw-{}", std::process::id()));
        let chk = tailwind_active_at;

        // Astro WITHOUT the Vite plugin — a bare `@import "tailwindcss"` doesn't compile.
        let a = dir.join("no-tw");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("astro.config.mjs"), "export default {{ }}").unwrap();
        std::fs::write(a.join("global.css"), "@import \"tailwindcss\";").unwrap();
        assert!(!chk(&a), "import alone, no plugin → not active");

        // Astro WITH the Vite plugin wired in → active.
        let b = dir.join("astro-tw");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(
            b.join("astro.config.mjs"),
            "import tailwindcss from '@tailwindcss/vite';\nexport default {{ vite: {{ plugins: [tailwindcss()] }} }}",
        )
        .unwrap();
        assert!(chk(&b), "astro.config wires tailwind → active");

        // A v3-style config file present → active.
        let c = dir.join("v3");
        std::fs::create_dir_all(&c).unwrap();
        std::fs::write(c.join("tailwind.config.js"), "module.exports = {{}}").unwrap();
        assert!(chk(&c), "tailwind.config.js present → active");

        std::fs::remove_dir_all(&dir).ok();
    }
}
