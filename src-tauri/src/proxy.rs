//! # Preview Reverse Proxy
//!
//! A lightweight HTTP reverse proxy that sits between the preview iframe and the
//! dev server. It injects a navigation tracking script into HTML responses
//! so the parent window can detect when the user navigates within the iframe.
//!
//! Also transparently forwards WebSocket upgrades (for HMR) and streams
//! non-HTML responses (SSE, JS, CSS, images, etc.) without buffering.

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use lazy_static::lazy_static;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// Maximum response body size to buffer for HTML injection (50 MB).
const MAX_BODY_SIZE: usize = 50 * 1024 * 1024;

/// Script injected into HTML responses to report navigation events to the parent window.
/// Monkey-patches history.pushState/replaceState and listens for popstate to catch all
/// client-side navigation in frameworks like Next.js, React Router, etc.
const NAV_SCRIPT: &str = r#"<script>(function(){var n=function(){window.parent.postMessage({type:'shipstudio:navigate',pathname:location.pathname},'*')};var p=history.pushState;var r=history.replaceState;history.pushState=function(){p.apply(this,arguments);n()};history.replaceState=function(){r.apply(this,arguments);n()};window.addEventListener('popstate',n);n()})()</script>"#;

/// Boxed body type that can be either a full buffered body or a streamed body.
type ProxyBody = BoxBody<Bytes, hyper::Error>;

/// Convert full bytes into a ProxyBody.
fn full_body(data: Bytes) -> ProxyBody {
    Full::new(data).map_err(|never| match never {}).boxed()
}

/// Convert an empty body into a ProxyBody.
fn empty_body() -> ProxyBody {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed()
}

/// A running proxy instance.
struct ProxyInstance {
    _proxy_port: u16,
    _target_port: u16,
    shutdown_tx: Option<oneshot::Sender<()>>,
    _task_handle: JoinHandle<()>,
}

lazy_static! {
    /// Maps window_label -> ProxyInstance
    static ref PROXY_INSTANCES: Mutex<HashMap<String, ProxyInstance>> = Mutex::new(HashMap::new());
}

/// Start a reverse proxy for the given window, forwarding to `target_port`.
/// Returns the proxy's listening port.
pub async fn start_preview_proxy(window_label: String, target_port: u16) -> Result<u16, String> {
    // Stop any existing proxy for this window
    stop_preview_proxy(&window_label);

    // Bind to a random available port on localhost
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind proxy port: {}", e))?;

    let proxy_port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get proxy address: {}", e))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let task_handle = tokio::spawn(async move {
        tracing::info!(
            "[Proxy] Started on port {} -> target port {}",
            proxy_port,
            target_port
        );

        loop {
            tokio::select! {
                result = listener.accept() => {
                    match result {
                        Ok((stream, addr)) => {
                            tokio::spawn(handle_connection(stream, addr, target_port));
                        }
                        Err(e) => {
                            tracing::error!("[Proxy] Accept error: {}", e);
                        }
                    }
                }
                _ = &mut shutdown_rx => {
                    tracing::info!("[Proxy] Shutting down proxy on port {}", proxy_port);
                    break;
                }
            }
        }
    });

    let instance = ProxyInstance {
        _proxy_port: proxy_port,
        _target_port: target_port,
        shutdown_tx: Some(shutdown_tx),
        _task_handle: task_handle,
    };

    PROXY_INSTANCES
        .lock()
        .map_err(|e| format!("Failed to acquire proxy lock: {}", e))?
        .insert(window_label, instance);

    tracing::info!("[Proxy] Proxy registered on port {}", proxy_port);
    Ok(proxy_port)
}

/// Stop the proxy for the given window.
pub fn stop_preview_proxy(window_label: &str) {
    if let Ok(mut instances) = PROXY_INSTANCES.lock() {
        if let Some(mut instance) = instances.remove(window_label) {
            if let Some(tx) = instance.shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!("[Proxy] Stopped proxy for window '{}'", window_label);
        }
    }
}

/// Stop all running proxies (called during app cleanup).
pub fn stop_all_proxies() {
    if let Ok(mut instances) = PROXY_INSTANCES.lock() {
        for (label, mut instance) in instances.drain() {
            if let Some(tx) = instance.shutdown_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!("[Proxy] Stopped proxy for window '{}' (cleanup)", label);
        }
    }
}

/// Handle a single incoming TCP connection.
async fn handle_connection(stream: TcpStream, addr: SocketAddr, target_port: u16) {
    let io = TokioIo::new(stream);

    let service = service_fn(move |req: Request<Incoming>| handle_request(req, target_port));

    if let Err(e) = http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .serve_connection(io, service)
        .with_upgrades()
        .await
    {
        // Connection reset / closed by client is normal
        tracing::debug!("[Proxy] Connection error from {}: {}", addr, e);
    }
}

/// Handle a single HTTP request by proxying it to the target dev server.
async fn handle_request(
    req: Request<Incoming>,
    target_port: u16,
) -> Result<Response<ProxyBody>, hyper::Error> {
    let is_websocket = is_upgrade_request(&req);

    if is_websocket {
        return handle_websocket_upgrade(req, target_port).await;
    }

    match proxy_http_request(req, target_port).await {
        Ok(resp) => Ok(resp),
        Err(e) => {
            tracing::error!("[Proxy] Request failed: {}", e);
            let body = format!("Proxy error: {}", e);
            Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from(body)))
                .unwrap())
        }
    }
}

/// Check if a request is a WebSocket upgrade request.
fn is_upgrade_request(req: &Request<Incoming>) -> bool {
    req.headers()
        .get(hyper::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

/// Proxy a regular HTTP request (non-WebSocket).
/// HTML responses are buffered and injected with the nav script.
/// All other responses (JS, CSS, images, SSE streams) are forwarded as-is without buffering.
async fn proxy_http_request(
    req: Request<Incoming>,
    target_port: u16,
) -> Result<Response<ProxyBody>, Box<dyn std::error::Error + Send + Sync>> {
    // Connect to target via hostname so both IPv4 and IPv6 are tried.
    // Vite-based dev servers (Astro, SvelteKit, Nuxt) bind to `localhost` which
    // resolves to `::1` (IPv6) on macOS — hardcoding 127.0.0.1 fails for those.
    let stream = TcpStream::connect(format!("localhost:{}", target_port)).await?;
    let io = TokioIo::new(stream);

    let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .handshake(io)
        .await?;

    // Spawn connection driver
    tokio::spawn(async move {
        if let Err(e) = conn.await {
            tracing::debug!("[Proxy] Client connection error: {}", e);
        }
    });

    // Build forwarded request - strip Accept-Encoding to avoid gzip for HTML,
    // and rewrite Host header to target port so dev servers don't reject it.
    let (parts, body) = req.into_parts();
    let mut builder = Request::builder()
        .method(parts.method)
        .uri(parts.uri.clone())
        .version(parts.version);

    for (key, value) in &parts.headers {
        // Strip Accept-Encoding so dev server returns uncompressed HTML
        if key == hyper::header::ACCEPT_ENCODING {
            continue;
        }
        // Rewrite Host to target port so dev server sees the expected origin
        if key == hyper::header::HOST {
            builder = builder.header(key, format!("localhost:{}", target_port));
            continue;
        }
        builder = builder.header(key, value);
    }

    let forwarded_req = builder.body(body)?;

    // Send request and get response
    let resp = sender.send_request(forwarded_req).await?;

    // Check if response is HTML (needs injection)
    let is_html = resp
        .headers()
        .get(hyper::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false);

    let status = resp.status();
    let headers = resp.headers().clone();

    if is_html {
        // Buffer HTML response body and inject nav script (and error overlay for 5xx)
        let body_bytes = resp.collect().await?.to_bytes();
        let is_server_error = status.is_server_error();

        let response_body = if body_bytes.len() < MAX_BODY_SIZE {
            let modified = if is_server_error {
                tracing::warn!(
                    "[Proxy] Dev server returned {} for HTML response, injecting error overlay",
                    status.as_u16()
                );
                inject_error_into_html(&body_bytes, status.as_u16())
            } else {
                inject_nav_script(&body_bytes)
            };
            full_body(Bytes::from(modified))
        } else {
            // Too large to inject, pass through as-is
            full_body(body_bytes)
        };

        // For error responses, return 200 so the iframe actually renders our overlay.
        // WebKit may show its own error page for 5xx, hiding our injected content.
        // The actual status code is displayed in the overlay's badge.
        let effective_status = if is_server_error {
            StatusCode::OK
        } else {
            status
        };

        let mut response = Response::builder().status(effective_status);
        for (key, value) in &headers {
            // Skip Content-Length since body size changed; skip Content-Encoding
            if key == hyper::header::CONTENT_LENGTH || key == hyper::header::CONTENT_ENCODING {
                continue;
            }
            response = response.header(key, value);
        }

        Ok(response.body(response_body)?)
    } else {
        // Stream non-HTML responses through without buffering.
        // This properly handles SSE (text/event-stream), chunked JS/CSS, etc.
        let incoming_body = resp.into_body();

        let mut response = Response::builder().status(status);
        for (key, value) in &headers {
            response = response.header(key, value);
        }

        Ok(response.body(incoming_body.boxed())?)
    }
}

/// Handle WebSocket upgrade by forwarding the upgrade to the target and piping
/// the upgraded connections bidirectionally.
async fn handle_websocket_upgrade(
    req: Request<Incoming>,
    target_port: u16,
) -> Result<Response<ProxyBody>, hyper::Error> {
    // Connect via hostname for IPv4/IPv6 compatibility (see proxy_http_request)
    let target_stream = match TcpStream::connect(format!("localhost:{}", target_port)).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[Proxy] WebSocket target connection failed: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from("WebSocket proxy error")))
                .unwrap());
        }
    };

    let target_io = TokioIo::new(target_stream);

    // Create client connection with upgrade support
    let (mut sender, conn) = match hyper::client::conn::http1::Builder::new()
        .preserve_header_case(true)
        .title_case_headers(true)
        .handshake(target_io)
        .await
    {
        Ok(h) => h,
        Err(e) => {
            tracing::error!("[Proxy] WebSocket handshake error: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from("WebSocket handshake error")))
                .unwrap());
        }
    };

    // Drive client connection with upgrades enabled
    tokio::spawn(async move {
        if let Err(e) = conn.with_upgrades().await {
            tracing::debug!("[Proxy] WebSocket client conn error: {}", e);
        }
    });

    // Split the incoming request: extract upgrade future, forward rest to target
    let (mut parts, body) = req.into_parts();

    // Extract the client's OnUpgrade from request extensions (set by hyper server)
    let client_on_upgrade = parts.extensions.remove::<hyper::upgrade::OnUpgrade>();

    // Build request to forward to target
    let mut builder = Request::builder()
        .method(parts.method)
        .uri(parts.uri.clone())
        .version(parts.version);

    for (key, value) in &parts.headers {
        builder = builder.header(key, value);
    }

    let forwarded_req = match builder.body(body) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[Proxy] Failed to build WS forward request: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(full_body(Bytes::from("Internal proxy error")))
                .unwrap());
        }
    };

    // Send upgrade request to target
    let target_resp = match sender.send_request(forwarded_req).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[Proxy] WebSocket forward failed: {}", e);
            return Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(full_body(Bytes::from("WebSocket proxy error")))
                .unwrap());
        }
    };

    if target_resp.status() != StatusCode::SWITCHING_PROTOCOLS {
        // Target didn't upgrade - return as regular response
        let status = target_resp.status();
        let headers = target_resp.headers().clone();
        let body_bytes = target_resp
            .collect()
            .await
            .map(|b| b.to_bytes())
            .unwrap_or_default();

        let mut response = Response::builder().status(status);
        for (key, value) in &headers {
            response = response.header(key, value);
        }
        return Ok(response.body(full_body(body_bytes)).unwrap());
    }

    // Target agreed to upgrade! Save response headers before consuming for upgrade.
    let resp_headers = target_resp.headers().clone();

    // Get target's upgraded connection (consumes response)
    let target_upgraded = hyper::upgrade::on(target_resp).await;

    // Build 101 response to return to client (with headers from target)
    let mut response_builder = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    for (key, value) in &resp_headers {
        response_builder = response_builder.header(key, value);
    }
    let client_response = response_builder.body(empty_body()).unwrap();

    // Spawn task to pipe client <-> target after both sides have upgraded
    if let (Some(client_on_upgrade), Ok(target_upgraded)) = (client_on_upgrade, target_upgraded) {
        tokio::spawn(async move {
            match client_on_upgrade.await {
                Ok(client_upgraded) => {
                    let mut client_io = TokioIo::new(client_upgraded);
                    let mut target_io = TokioIo::new(target_upgraded);

                    match tokio::io::copy_bidirectional(&mut client_io, &mut target_io).await {
                        Ok((c2t, t2c)) => {
                            tracing::debug!(
                                "[Proxy] WebSocket closed (client->target: {} bytes, target->client: {} bytes)",
                                c2t, t2c
                            );
                        }
                        Err(e) => {
                            tracing::debug!("[Proxy] WebSocket pipe error: {}", e);
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("[Proxy] Client WebSocket upgrade failed: {}", e);
                }
            }
        });
    } else {
        tracing::error!(
            "[Proxy] WebSocket upgrade: missing client upgrade or target upgrade failed"
        );
    }

    Ok(client_response)
}

/// Inject the navigation tracking script into an HTML response body.
fn inject_nav_script(html: &[u8]) -> Vec<u8> {
    inject_into_html(html, NAV_SCRIPT)
}

/// Inject an arbitrary HTML/CSS/JS snippet into an HTML document.
/// Tries before </head>, then </body>, then appends to end.
fn inject_into_html(html: &[u8], snippet: &str) -> Vec<u8> {
    let body = String::from_utf8_lossy(html);

    // Try to inject before </head> (earliest execution)
    if let Some(pos) = body.find("</head>") {
        let byte_pos = body[..pos].len();
        let mut result = Vec::with_capacity(html.len() + snippet.len());
        result.extend_from_slice(&html[..byte_pos]);
        result.extend_from_slice(snippet.as_bytes());
        result.extend_from_slice(&html[byte_pos..]);
        return result;
    }

    // Fallback: before </body>
    if let Some(pos) = body.find("</body>") {
        let byte_pos = body[..pos].len();
        let mut result = Vec::with_capacity(html.len() + snippet.len());
        result.extend_from_slice(&html[..byte_pos]);
        result.extend_from_slice(snippet.as_bytes());
        result.extend_from_slice(&html[byte_pos..]);
        return result;
    }

    // Final fallback: append to end
    let mut result = html.to_vec();
    result.extend_from_slice(snippet.as_bytes());
    result
}

/// Attempt to extract a human-readable error message from an HTML error response.
/// Tries multiple strategies for different frameworks (Next.js, Vite, generic).
fn extract_error_message(html: &str) -> String {
    // Strategy 1: Next.js __NEXT_DATA__ JSON with error info
    if let Some(start) = html.find("__NEXT_DATA__") {
        if let Some(json_start) = html[start..].find('>') {
            let after_tag = start + json_start + 1;
            if let Some(json_end) = html[after_tag..].find("</script>") {
                let json_str = &html[after_tag..after_tag + json_end];
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(msg) = val.pointer("/err/message").and_then(|v| v.as_str()) {
                        return msg.to_string();
                    }
                    if let Some(msg) = val
                        .pointer("/props/pageProps/error/message")
                        .and_then(|v| v.as_str())
                    {
                        return msg.to_string();
                    }
                }
            }
        }
    }

    // Strategy 2: Error in <pre> tag (common in many frameworks)
    if let Some(pre_start) = html.find("<pre>") {
        let content_start = pre_start + 5;
        if let Some(pre_end) = html[content_start..].find("</pre>") {
            let content = &html[content_start..content_start + pre_end];
            let cleaned = content
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
                .replace("&quot;", "\"");
            if !cleaned.trim().is_empty() {
                let truncated = if cleaned.len() > 2000 {
                    &cleaned[..2000]
                } else {
                    &cleaned
                };
                return truncated.trim().to_string();
            }
        }
    }

    // Strategy 3: Error in <h1> or <h2> tags
    for tag in &["<h1>", "<h2>"] {
        if let Some(start) = html.find(tag) {
            let content_start = start + tag.len();
            let close_tag = tag.replace('<', "</");
            if let Some(end) = html[content_start..].find(&close_tag) {
                let text = &html[content_start..content_start + end];
                let clean_text = strip_html_tags(text);
                if !clean_text.trim().is_empty() && clean_text.len() < 500 {
                    return clean_text.trim().to_string();
                }
            }
        }
    }

    // Strategy 4: <title> tag containing error keywords
    if let Some(start) = html.find("<title>") {
        let content_start = start + 7;
        if let Some(end) = html[content_start..].find("</title>") {
            let title = &html[content_start..content_start + end];
            if !title.trim().is_empty()
                && title.len() < 200
                && (title.contains("Error") || title.contains("error") || title.contains("500"))
            {
                return title.trim().to_string();
            }
        }
    }

    // Fallback
    "The dev server returned an error. Check the terminal for details.".to_string()
}

/// Strip HTML tags from a string, leaving only text content.
fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            result.push(ch);
        }
    }
    result
}

/// Build a self-contained error overlay (HTML/CSS/JS) for 5xx responses.
/// Forces body visible (overrides Next.js FOUC prevention), shows a styled error panel,
/// and sends a postMessage to the parent so Ship Studio can log the error.
fn build_error_overlay(status_code: u16, error_message: &str) -> String {
    let escaped_message = error_message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
        .replace('\n', "<br>");

    let js_escaped = error_message
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    format!(
        r#"<style>
body{{display:block!important;visibility:visible!important;opacity:1!important}}
.__ss-err-overlay{{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:#1e1e1e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#ccc;display:flex;align-items:center;justify-content:center;padding:24px}}
.__ss-err-panel{{max-width:680px;width:100%;background:#252526;border:1px solid #3c3c3c;border-radius:12px;overflow:hidden}}
.__ss-err-header{{display:flex;align-items:center;gap:10px;padding:16px 20px;background:#2d2d2d;border-bottom:1px solid #3c3c3c}}
.__ss-err-badge{{background:#f44747;color:#fff;font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px}}
.__ss-err-title{{font-size:14px;font-weight:600;color:#ccc}}
.__ss-err-body{{padding:20px;max-height:400px;overflow-y:auto}}
.__ss-err-msg{{font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:13px;line-height:1.6;color:#d4d4d4;white-space:pre-wrap;word-break:break-word;background:#1e1e1e;padding:16px;border-radius:8px;border:1px solid #3c3c3c}}
.__ss-err-hint{{margin-top:16px;font-size:12px;color:#6d6d6d;text-align:center}}
.__ss-err-footer{{display:flex;gap:8px;padding:16px 20px;border-top:1px solid #3c3c3c;justify-content:flex-end}}
.__ss-err-btn{{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:6px;border:1px solid #3c3c3c;background:#2d2d2d;color:#ccc;font-size:12px;font-weight:500;cursor:pointer;transition:background 0.15s}}
.__ss-err-btn:hover{{background:#3c3c3c}}
.__ss-err-btn--primary{{background:#D97757;border-color:#D97757;color:#fff}}
.__ss-err-btn--primary:hover{{background:#C4684A}}
</style>
<div class="__ss-err-overlay"><div class="__ss-err-panel">
<div class="__ss-err-header"><span class="__ss-err-badge">{status_code}</span><span class="__ss-err-title">Dev Server Error</span></div>
<div class="__ss-err-body"><div class="__ss-err-msg">{escaped_message}</div><div class="__ss-err-hint">Check the terminal for full error details</div></div>
<div class="__ss-err-footer"><button class="__ss-err-btn" id="__ss-err-copy"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy Error</button><button class="__ss-err-btn __ss-err-btn--primary" id="__ss-err-send">Send to Claude</button></div>
</div></div>
<script>(function(){{
var msg='{js_escaped}';
window.parent.postMessage({{type:'shipstudio:error',status:{status_code},message:msg}},'*');
document.getElementById('__ss-err-copy').onclick=function(){{
window.parent.postMessage({{type:'shipstudio:copy-error',message:msg}},'*');
this.textContent='Copied!';var b=this;setTimeout(function(){{b.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy Error'}},1500)
}};
document.getElementById('__ss-err-send').onclick=function(){{
window.parent.postMessage({{type:'shipstudio:send-error-to-claude',message:msg}},'*')
}};
}})()</script>"#,
        status_code = status_code,
        escaped_message = escaped_message,
        js_escaped = js_escaped,
    )
}

/// Inject error overlay + nav script into an HTML response with a 5xx status.
fn inject_error_into_html(html: &[u8], status_code: u16) -> Vec<u8> {
    let body_str = String::from_utf8_lossy(html);
    let error_message = extract_error_message(&body_str);
    let overlay = build_error_overlay(status_code, &error_message);
    let injection = format!("{}{}", overlay, NAV_SCRIPT);
    inject_into_html(html, &injection)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_before_head() {
        let html = b"<html><head><title>Test</title></head><body>Hello</body></html>";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains(&format!("{}</head>", NAV_SCRIPT)));
    }

    #[test]
    fn test_inject_before_body_fallback() {
        let html = b"<html><body>Hello</body></html>";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains(&format!("{}</body>", NAV_SCRIPT)));
    }

    #[test]
    fn test_inject_append_fallback() {
        let html = b"<html>Hello";
        let result = inject_nav_script(html);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.ends_with(NAV_SCRIPT));
    }

    #[test]
    fn test_extract_error_from_next_data() {
        let html = r#"<html><head></head><body><script id="__NEXT_DATA__" type="application/json">{"err":{"message":"Module not found: Can't resolve 'missing-pkg'"}}</script></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Module not found"));
    }

    #[test]
    fn test_extract_error_from_pre_tag() {
        let html = r#"<html><body><pre>Error: Cannot find module 'react'</pre></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Cannot find module 'react'"));
    }

    #[test]
    fn test_extract_error_from_h1() {
        let html = r#"<html><body><h1>Internal Server Error</h1><p>Something went wrong</p></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Internal Server Error"));
    }

    #[test]
    fn test_extract_error_from_title() {
        let html =
            r#"<html><head><title>500 Internal Server Error</title></head><body></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("500 Internal Server Error"));
    }

    #[test]
    fn test_extract_error_fallback() {
        let html = r#"<html><body></body></html>"#;
        let msg = extract_error_message(html);
        assert!(msg.contains("Check the terminal"));
    }

    #[test]
    fn test_strip_html_tags() {
        assert_eq!(strip_html_tags("<b>hello</b> world"), "hello world");
        assert_eq!(strip_html_tags("no tags"), "no tags");
        assert_eq!(strip_html_tags("<a href='x'>link</a>"), "link");
    }

    #[test]
    fn test_error_overlay_contains_status() {
        let html = b"<html><head></head><body>error</body></html>";
        let result = inject_error_into_html(html, 500);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains("500"));
        assert!(result_str.contains("__ss-err-overlay"));
        assert!(result_str.contains("display:block!important"));
    }

    #[test]
    fn test_error_overlay_preserves_nav_script() {
        let html = b"<html><head></head><body>error</body></html>";
        let result = inject_error_into_html(html, 502);
        let result_str = String::from_utf8(result).unwrap();
        assert!(result_str.contains("shipstudio:navigate"));
        assert!(result_str.contains("shipstudio:error"));
    }

    #[test]
    fn test_error_message_escaping() {
        let overlay = build_error_overlay(500, "Module '<Foo>' not found & \"bar\"");
        assert!(overlay.contains("&lt;Foo&gt;"));
        assert!(overlay.contains("&amp;"));
        assert!(overlay.contains("&quot;bar&quot;"));
    }
}
