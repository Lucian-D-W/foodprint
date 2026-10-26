use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, response::Builder, HeaderMap, Method, Response, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use rand::{distr::Alphanumeric, Rng};
use sha2::{Digest, Sha256};
use std::path::{Component, PathBuf};
use tokio::{net::TcpListener, sync::oneshot};

#[derive(Clone)]
struct ServerState {
    root: PathBuf,
    token: String,
}

pub struct LocalServer {
    pub origin: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl LocalServer {
    pub async fn start(root: PathBuf) -> std::io::Result<Self> {
        let token: String = rand::rng()
            .sample_iter(&Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let (tx, rx) = oneshot::channel();
        let state = ServerState {
            root,
            token: token.clone(),
        };
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/{token}/{root}/{*path}", any(file))
                    .with_state(state),
            )
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
        });
        Ok(Self {
            origin: format!("http://{address}/{token}"),
            shutdown: Some(tx),
        })
    }
}

impl Drop for LocalServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

async fn file(
    State(state): State<ServerState>,
    Path((token, root, path)): Path<(String, String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    if token != state.token || !matches!(root.as_str(), "maps" | "media" | "assets") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if root == "maps" && path == "regions-staging"
        || root == "maps" && path.starts_with("regions-staging/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let cors_origin = allowed_origin(&headers);
    if method == Method::OPTIONS {
        return cors_response(
            Response::builder().status(StatusCode::NO_CONTENT),
            cors_origin,
        )
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
        .body(Body::empty())
        .unwrap();
    }
    let relative = std::path::Path::new(&path);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let base = state.root.join(&root);
    let target = base.join(relative);
    let (Ok(base), Ok(target)) = (base.canonicalize(), target.canonicalize()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let reparse_free = windows_reparse_free(&state.root.join(&root), relative);
    if !canonical_target_is_allowed(&base, &target, reparse_free) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(mime) = mime(&target) else {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    };
    let Ok(bytes) = tokio::fs::read(&target).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Managed-media names can originate from a user's photo library.  Keep
    // diagnostic logs useful without retaining a filename, path, EXIF, or
    // FoodLog content.
    log::debug!("Serving local {root} asset");
    let length = bytes.len();
    let range = match parse_range(
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
        length,
    ) {
        Ok(value) => value,
        Err(()) => {
            return cors_response(
                Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE),
                cors_origin,
            )
            .header(header::CONTENT_RANGE, format!("bytes */{length}"))
            .header(header::ACCEPT_RANGES, "bytes")
            .body(Body::empty())
            .unwrap()
        }
    };
    let (start, end, status) = range.unwrap_or((0, length, StatusCode::OK));
    let etag = format!("\"{:x}\"", Sha256::digest(&bytes));
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(bytes[start..end].to_vec())
    };
    let mut response = cors_response(Response::builder().status(status), cors_origin)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, (end - start).to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Length, Content-Range, ETag",
        );
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{}", start, end - 1, length),
        );
    }
    response.body(body).unwrap()
}

fn canonical_target_is_allowed(
    canonical_base: &std::path::Path,
    canonical_target: &std::path::Path,
    windows_reparse_free: bool,
) -> bool {
    canonical_target.starts_with(canonical_base) || cfg!(windows) && windows_reparse_free
}

#[cfg(windows)]
fn windows_reparse_free(base: &std::path::Path, relative: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let mut current = base.to_path_buf();
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(Component::Normal(component)) = component {
            current.push(component);
        }
        let Ok(metadata) = current.symlink_metadata() else {
            return false;
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

#[cfg(not(windows))]
fn windows_reparse_free(_base: &std::path::Path, _relative: &std::path::Path) -> bool {
    false
}

fn mime(path: &std::path::Path) -> Option<&'static str> {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("pmtiles") => Some("application/vnd.pmtiles"),
        Some("pbf") => Some("application/x-protobuf"),
        Some("json") => Some("application/json"),
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("webp") => Some("image/webp"),
        Some("mp4") => Some("video/mp4"),
        Some("webm") => Some("video/webm"),
        _ => None,
    }
}

fn cors_response(builder: Builder, origin: Option<&'static str>) -> Builder {
    let builder = builder.header(header::VARY, "Origin");
    match origin {
        Some(origin) => builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin),
        None => builder,
    }
}

fn allowed_origin(headers: &HeaderMap) -> Option<&'static str> {
    match headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        Some("http://tauri.localhost") => Some("http://tauri.localhost"),
        #[cfg(debug_assertions)]
        Some("http://localhost:5173") => Some("http://localhost:5173"),
        _ => None,
    }
}

fn parse_range(
    value: Option<&str>,
    length: usize,
) -> Result<Option<(usize, usize, StatusCode)>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(value) = value.strip_prefix("bytes=") else {
        return Err(());
    };
    if value.contains(',') {
        return Err(());
    }
    let Some((start, end)) = value.split_once('-') else {
        return Err(());
    };
    if length == 0 {
        return Err(());
    }
    if start.is_empty() {
        let suffix = end.parse::<usize>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = length.saturating_sub(suffix);
        return Ok(Some((start, length, StatusCode::PARTIAL_CONTENT)));
    }
    let start = start.parse::<usize>().map_err(|_| ())?;
    if start >= length {
        return Err(());
    }
    let end = if end.is_empty() {
        length
    } else {
        end.parse::<usize>().map_err(|_| ())?.min(length - 1) + 1
    };
    if start >= end {
        return Err(());
    }
    Ok(Some((start, end, StatusCode::PARTIAL_CONTENT)))
}

#[cfg(test)]
mod tests {
    use super::canonical_target_is_allowed;
    use std::path::Path;

    #[test]
    fn canonical_containment_never_accepts_a_reparse_escape() {
        let base = Path::new("C:/app/maps");
        let inside = Path::new("C:/app/maps/default/style.json");
        let outside = Path::new("C:/outside/style.json");
        assert!(canonical_target_is_allowed(base, inside, false));
        assert!(!canonical_target_is_allowed(base, outside, false));
    }

    #[cfg(windows)]
    #[test]
    fn windows_virtualization_fallback_requires_a_reparse_free_logical_path() {
        let logical_base = Path::new("C:/app/maps");
        let virtualized_target =
            Path::new("C:/package/LocalCache/Local/app/maps/default/style.json");
        assert!(canonical_target_is_allowed(
            logical_base,
            virtualized_target,
            true
        ));
        assert!(!canonical_target_is_allowed(
            logical_base,
            virtualized_target,
            false
        ));
    }
}
