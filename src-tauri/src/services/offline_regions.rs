use std::{
    collections::HashSet,
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::header::{ACCEPT, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    db::Db,
    error::{AppError, AppResult},
    paths::{validate_map_region_id, PathResolver},
    repositories::offline_regions::{self, OfflineRegion, RegionBounds},
};

pub const OPENFREEMAP_TILEJSON_URL: &str = "https://tiles.openfreemap.org/planet";
pub const NOMINATIM_BASE_URL: &str = "https://nominatim.openstreetmap.org";
pub const NOMINATIM_USER_AGENT: &str = "FoodMap/0.1 (local-first food journal map)";
pub const DEFAULT_TILE_MIN_ZOOM: u8 = 12;
pub const QUALIFIED_VIEWPORT_MIN_ZOOM: f64 = 13.0;
pub const QUALIFIED_VIEWPORT_MAX_LON_SPAN: f64 = 0.12;
pub const QUALIFIED_VIEWPORT_MAX_LAT_SPAN: f64 = 0.10;
pub const QUALIFIED_VIEWPORT_MAX_AREA: f64 = 0.008;
pub const ESTIMATED_TILE_BYTES: u64 = 64 * 1024;
const MAX_LABEL_CHARS: usize = 240;
const MAX_QUERY_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TileProviderInfo {
    pub provider_url: String,
    pub tile_template: String,
    pub provider_version: String,
    pub attribution: String,
    pub min_zoom: u8,
    pub max_zoom: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TileCoordinate {
    pub z: u8,
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RegionEstimate {
    pub bounds: RegionBounds,
    pub center_longitude: f64,
    pub center_latitude: f64,
    pub return_zoom: f64,
    pub tile_min_zoom: u8,
    pub tile_max_zoom: u8,
    pub tile_count: u64,
    pub estimated_bytes: u64,
    pub provider_url: String,
    pub tile_template: String,
    pub provider_version: String,
    pub attribution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateRegionInput {
    pub bounds: RegionBounds,
    pub center_longitude: f64,
    pub center_latitude: f64,
    pub return_zoom: f64,
    pub label: String,
    pub display_name: String,
    #[serde(default)]
    pub locale: String,
    pub tile_min_zoom: u8,
    pub tile_max_zoom: u8,
    pub provider_url: String,
    pub tile_template: String,
    pub provider_version: String,
    #[serde(default)]
    pub attribution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeocodedPlace {
    pub display_name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub place_type: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TileJson {
    tiles: Vec<String>,
    #[serde(default)]
    minzoom: Option<u8>,
    #[serde(default)]
    maxzoom: Option<u8>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    attribution: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct RateGate {
    next_request_at: Option<Instant>,
}

#[derive(Clone)]
pub struct OfflineRegionService {
    db: Db,
    paths: PathResolver,
    client: reqwest::Client,
    tile_json_url: String,
    geocoder_base_url: String,
    geocoder_rate_gate: Arc<Mutex<RateGate>>,
}

impl OfflineRegionService {
    pub fn new(db: Db, paths: PathResolver) -> AppResult<Self> {
        Self::with_endpoints(db, paths, OPENFREEMAP_TILEJSON_URL, NOMINATIM_BASE_URL)
    }

    pub fn with_endpoints(
        db: Db,
        paths: PathResolver,
        tile_json_url: impl Into<String>,
        geocoder_base_url: impl Into<String>,
    ) -> AppResult<Self> {
        let client = reqwest::Client::builder()
            .user_agent(NOMINATIM_USER_AGENT)
            .build()
            .map_err(|error| AppError::MapProvider(error.to_string()))?;
        Ok(Self {
            db,
            paths,
            client,
            tile_json_url: tile_json_url.into(),
            geocoder_base_url: geocoder_base_url.into().trim_end_matches('/').to_owned(),
            geocoder_rate_gate: Arc::new(Mutex::new(RateGate::default())),
        })
    }

    pub fn list(&self) -> AppResult<Vec<OfflineRegion>> {
        self.db.with_read(offline_regions::list)
    }

    pub async fn search(&self, query: &str) -> AppResult<Vec<GeocodedPlace>> {
        let query = bounded_query(query)?;
        let cache_key = format!("search:{}", query.to_lowercase());
        if let Some(cached) = self
            .db
            .with_read(|connection| offline_regions::cached_response(connection, &cache_key))?
        {
            if let Ok(results) = serde_json::from_str::<Vec<GeocodedPlace>>(&cached) {
                return Ok(results);
            }
        }
        self.wait_for_geocoder_turn().await;
        let body = self
            .client
            .get(format!("{}/search", self.geocoder_base_url))
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, NOMINATIM_USER_AGENT)
            .query(&[
                ("format", "jsonv2"),
                ("limit", "8"),
                ("addressdetails", "0"),
                ("accept-language", "zh-CN,zh-TW,en"),
                ("q", query.as_str()),
            ])
            .send()
            .await
            .map_err(|error| AppError::MapProvider(error.to_string()))?
            .error_for_status()
            .map_err(|error| AppError::MapProvider(error.to_string()))?
            .text()
            .await
            .map_err(|error| AppError::MapProvider(error.to_string()))?;
        let results = parse_geocoder_search(&body)?;
        let encoded = serde_json::to_string(&results)
            .map_err(|error| AppError::MapProvider(error.to_string()))?;
        self.db.with_write(|transaction| {
            offline_regions::save_cached_response(
                transaction,
                &cache_key,
                &encoded,
                crate::now_ms(),
            )
        })?;
        Ok(results)
    }

    pub async fn reverse(&self, longitude: f64, latitude: f64) -> AppResult<GeocodedPlace> {
        validate_coordinate(longitude, latitude)?;
        let cache_key = format!("reverse:{longitude:.5}:{latitude:.5}");
        if let Some(cached) = self
            .db
            .with_read(|connection| offline_regions::cached_response(connection, &cache_key))?
        {
            if let Ok(result) = serde_json::from_str::<GeocodedPlace>(&cached) {
                return Ok(result);
            }
        }
        self.wait_for_geocoder_turn().await;
        let longitude_text = format!("{longitude:.7}");
        let latitude_text = format!("{latitude:.7}");
        let body = self
            .client
            .get(format!("{}/reverse", self.geocoder_base_url))
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, NOMINATIM_USER_AGENT)
            .query(&[
                ("format", "jsonv2"),
                ("zoom", "18"),
                ("addressdetails", "0"),
                ("accept-language", "zh-CN,zh-TW,en"),
                ("lon", longitude_text.as_str()),
                ("lat", latitude_text.as_str()),
            ])
            .send()
            .await
            .map_err(|error| AppError::MapProvider(error.to_string()))?
            .error_for_status()
            .map_err(|error| AppError::MapProvider(error.to_string()))?
            .text()
            .await
            .map_err(|error| AppError::MapProvider(error.to_string()))?;
        let result = parse_geocoder_place(&body)?;
        let encoded = serde_json::to_string(&result)
            .map_err(|error| AppError::MapProvider(error.to_string()))?;
        self.db.with_write(|transaction| {
            offline_regions::save_cached_response(
                transaction,
                &cache_key,
                &encoded,
                crate::now_ms(),
            )
        })?;
        Ok(result)
    }

    pub async fn estimate(
        &self,
        bounds: RegionBounds,
        center_longitude: f64,
        center_latitude: f64,
        return_zoom: f64,
    ) -> AppResult<RegionEstimate> {
        validate_region_view(
            bounds.clone(),
            center_longitude,
            center_latitude,
            return_zoom,
        )?;
        if !is_qualified_viewport(&bounds, return_zoom) {
            return Err(AppError::InvalidOfflineRegion(
                "缓存区域需要街区或社区级视野".to_owned(),
            ));
        }
        let provider = self.fetch_tile_provider().await?;
        estimate_with_provider(
            bounds,
            center_longitude,
            center_latitude,
            return_zoom,
            provider,
        )
    }

    pub async fn create(&self, input: CreateRegionInput) -> AppResult<OfflineRegion> {
        validate_region_view(
            input.bounds.clone(),
            input.center_longitude,
            input.center_latitude,
            input.return_zoom,
        )?;
        if !is_qualified_viewport(&input.bounds, input.return_zoom) {
            return Err(AppError::InvalidOfflineRegion(
                "缓存区域需要街区或社区级视野".to_owned(),
            ));
        }
        let label = bounded_label(&input.label)?;
        let display_name = bounded_label(&input.display_name)?;
        let locale = if input.locale.trim().is_empty() {
            "und".to_owned()
        } else {
            bounded_label(&input.locale)?
        };
        let provider = validate_provider_info(TileProviderInfo {
            provider_url: input.provider_url,
            tile_template: input.tile_template,
            provider_version: bounded_label(&input.provider_version)?,
            attribution: bounded_attribution(&input.attribution),
            min_zoom: input.tile_min_zoom,
            max_zoom: input.tile_max_zoom,
        })?;
        let plan = estimate_with_provider(
            input.bounds.clone(),
            input.center_longitude,
            input.center_latitude,
            input.return_zoom,
            provider.clone(),
        )?;
        let existing = self.list()?;
        if existing
            .iter()
            .any(|region| bounds_contain(&region.bounds(), &plan.bounds))
        {
            return Err(AppError::InvalidOfflineRegion(
                "此处已在离线缓存范围内".to_owned(),
            ));
        }
        let id = region_id(
            &plan.bounds,
            plan.center_longitude,
            plan.center_latitude,
            &provider,
        );
        validate_map_region_id(&id)?;
        let live_path = self.paths.map_region_path(&id)?;
        if live_path.exists() {
            return Err(AppError::InvalidOfflineRegion(
                "离线缓存区域已存在".to_owned(),
            ));
        }
        let staging_path = self.paths.map_region_staging_path(&id)?;
        if staging_path.exists() {
            fs::remove_dir_all(&staging_path)?;
        }
        fs::create_dir_all(&staging_path)?;
        let download_result = self.download_tiles(&staging_path, &plan).await;
        let byte_size = match download_result {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_dir_all(&staging_path);
                return Err(error);
            }
        };
        if let Err(error) = fs::rename(&staging_path, &live_path) {
            let _ = fs::remove_dir_all(&staging_path);
            return Err(AppError::MapDownload(error.to_string()));
        }
        let now_ms = crate::now_ms();
        let region = OfflineRegion {
            id,
            label,
            display_name,
            locale,
            west: plan.bounds.west,
            south: plan.bounds.south,
            east: plan.bounds.east,
            north: plan.bounds.north,
            center_longitude: plan.center_longitude,
            center_latitude: plan.center_latitude,
            return_zoom: plan.return_zoom,
            tile_min_zoom: plan.tile_min_zoom,
            tile_max_zoom: plan.tile_max_zoom,
            provider_url: provider.provider_url,
            tile_template: provider.tile_template,
            provider_version: provider.provider_version,
            attribution: provider.attribution,
            tile_count: plan.tile_count,
            byte_size,
            status: "ready".to_owned(),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        };
        let insert_result = self
            .db
            .with_write(|transaction| offline_regions::insert(transaction, &region));
        if let Err(error) = insert_result {
            let _ = fs::remove_dir_all(&live_path);
            return Err(error);
        }
        Ok(region)
    }

    pub fn delete(&self, id: &str) -> AppResult<bool> {
        validate_map_region_id(id)?;
        let live_path = self.paths.map_region_path(id)?;
        let tombstone = self
            .paths
            .map_regions_staging_root()
            .join(format!("{id}.deleting"));
        if tombstone.exists() {
            fs::remove_dir_all(&tombstone)?;
        }
        if live_path.exists() {
            fs::rename(&live_path, &tombstone)?;
        }
        let deleted = self
            .db
            .with_write(|transaction| offline_regions::delete(transaction, id));
        match deleted {
            Ok(deleted) => {
                if tombstone.exists() {
                    fs::remove_dir_all(tombstone)?;
                }
                Ok(deleted)
            }
            Err(error) => {
                if tombstone.exists() && !live_path.exists() {
                    let _ = fs::rename(tombstone, live_path);
                }
                Err(error)
            }
        }
    }

    async fn fetch_tile_provider(&self) -> AppResult<TileProviderInfo> {
        let body = self
            .client
            .get(&self.tile_json_url)
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, NOMINATIM_USER_AGENT)
            .send()
            .await
            .map_err(|error| AppError::MapProvider(error.to_string()))?
            .error_for_status()
            .map_err(|error| AppError::MapProvider(error.to_string()))?
            .text()
            .await
            .map_err(|error| AppError::MapProvider(error.to_string()))?;
        parse_tile_json(&body, &self.tile_json_url)
    }

    async fn download_tiles(&self, staging_path: &Path, plan: &RegionEstimate) -> AppResult<u64> {
        let mut total_bytes = 0_u64;
        for tile in enumerate_tiles(&plan.bounds, plan.tile_min_zoom, plan.tile_max_zoom)? {
            let url = tile_url(&plan.tile_template, &tile)?;
            let bytes = self
                .client
                .get(url)
                .header(ACCEPT, "application/x-protobuf")
                .header(USER_AGENT, NOMINATIM_USER_AGENT)
                .send()
                .await
                .map_err(|error| AppError::MapDownload(error.to_string()))?
                .error_for_status()
                .map_err(|error| AppError::MapDownload(error.to_string()))?
                .bytes()
                .await
                .map_err(|error| AppError::MapDownload(error.to_string()))?;
            let directory = staging_path
                .join(tile.z.to_string())
                .join(tile.x.to_string());
            fs::create_dir_all(&directory)?;
            let target = directory.join(format!("{}.pbf", tile.y));
            let partial = target.with_extension("pbf.part");
            fs::write(&partial, &bytes)?;
            fs::rename(&partial, &target)?;
            total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        }
        Ok(total_bytes)
    }

    async fn wait_for_geocoder_turn(&self) {
        let delay = {
            let mut gate = self
                .geocoder_rate_gate
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let now = Instant::now();
            let allowed = gate.next_request_at.unwrap_or(now);
            let delay = allowed.saturating_duration_since(now);
            gate.next_request_at = Some(std::cmp::max(now, allowed) + Duration::from_secs(1));
            delay
        };
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
    }
}

pub fn parse_tile_json(raw: &str, endpoint: &str) -> AppResult<TileProviderInfo> {
    let parsed: TileJson = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| AppError::MapProvider(error.to_string()))?;
    let template = parsed
        .tiles
        .first()
        .ok_or_else(|| AppError::MapProvider("TileJSON has no tile template".to_owned()))?
        .trim()
        .to_owned();
    if parsed.tiles.len() != 1 {
        return Err(AppError::MapProvider(
            "TileJSON must provide one versioned tile template".to_owned(),
        ));
    }
    let min_zoom = parsed.minzoom.unwrap_or(0);
    let max_zoom = parsed.maxzoom.unwrap_or(14);
    if min_zoom > max_zoom || max_zoom > 24 {
        return Err(AppError::MapProvider(
            "TileJSON zoom range is invalid".to_owned(),
        ));
    }
    let info = TileProviderInfo {
        provider_url: endpoint.to_owned(),
        tile_template: template,
        provider_version: parsed
            .version
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "unknown".to_owned()),
        attribution: bounded_attribution(parsed.attribution.as_deref().unwrap_or_default()),
        min_zoom,
        max_zoom,
    };
    validate_provider_info(info)
}

pub fn parse_geocoder_search(raw: &str) -> AppResult<Vec<GeocodedPlace>> {
    let value: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| AppError::MapProvider(error.to_string()))?;
    let array = value.as_array().ok_or_else(|| {
        AppError::MapProvider("geocoder search response is not a list".to_owned())
    })?;
    Ok(array.iter().take(8).filter_map(parse_place_value).collect())
}

pub fn parse_geocoder_place(raw: &str) -> AppResult<GeocodedPlace> {
    let value: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| AppError::MapProvider(error.to_string()))?;
    parse_place_value(&value)
        .ok_or_else(|| AppError::MapProvider("geocoder response has no usable place".to_owned()))
}

pub fn is_qualified_viewport(bounds: &RegionBounds, zoom: f64) -> bool {
    if !zoom.is_finite() || zoom < QUALIFIED_VIEWPORT_MIN_ZOOM || validate_bounds(bounds).is_err() {
        return false;
    }
    let lon_span = longitude_span(bounds);
    let lat_span = bounds.north - bounds.south;
    lon_span <= QUALIFIED_VIEWPORT_MAX_LON_SPAN
        && lat_span <= QUALIFIED_VIEWPORT_MAX_LAT_SPAN
        && lon_span * lat_span <= QUALIFIED_VIEWPORT_MAX_AREA
}

pub fn enumerate_tiles(
    bounds: &RegionBounds,
    min_zoom: u8,
    max_zoom: u8,
) -> AppResult<Vec<TileCoordinate>> {
    validate_bounds(bounds)?;
    if min_zoom > max_zoom || max_zoom > 24 {
        return Err(AppError::InvalidOfflineRegion(
            "瓦片缩放范围无效".to_owned(),
        ));
    }
    let mut tiles = Vec::new();
    for zoom in min_zoom..=max_zoom {
        let n = 1_u64 << zoom;
        let y_start = latitude_to_tile_y(bounds.north, zoom);
        let y_end = latitude_to_tile_y(bounds.south, zoom);
        for (west, east) in longitude_intervals(bounds) {
            let x_start = longitude_to_tile_x(west, zoom);
            let x_end = longitude_to_tile_x(east, zoom);
            let end = if east >= 180.0 { n as u32 - 1 } else { x_end };
            for x in x_start..=end.max(x_start) {
                for y in y_start..=y_end.max(y_start) {
                    tiles.push(TileCoordinate {
                        z: zoom,
                        x: x % n as u32,
                        y,
                    });
                }
            }
        }
    }
    let mut seen = HashSet::new();
    tiles.retain(|tile| seen.insert((tile.z, tile.x, tile.y)));
    Ok(tiles)
}

pub fn bounds_contain(outer: &RegionBounds, inner: &RegionBounds) -> bool {
    if validate_bounds(outer).is_err() || validate_bounds(inner).is_err() {
        return false;
    }
    inner.south >= outer.south
        && inner.north <= outer.north
        && longitude_intervals(inner)
            .iter()
            .all(|(inner_west, inner_east)| {
                longitude_intervals(outer)
                    .iter()
                    .any(|(outer_west, outer_east)| {
                        *inner_west >= *outer_west && *inner_east <= *outer_east
                    })
            })
}

fn estimate_with_provider(
    bounds: RegionBounds,
    center_longitude: f64,
    center_latitude: f64,
    return_zoom: f64,
    provider: TileProviderInfo,
) -> AppResult<RegionEstimate> {
    let tile_min_zoom = provider
        .min_zoom
        .max(DEFAULT_TILE_MIN_ZOOM)
        .min(provider.max_zoom);
    let tile_max_zoom = provider.max_zoom;
    let tiles = enumerate_tiles(&bounds, tile_min_zoom, tile_max_zoom)?;
    Ok(RegionEstimate {
        bounds,
        center_longitude,
        center_latitude,
        return_zoom,
        tile_min_zoom,
        tile_max_zoom,
        tile_count: tiles.len() as u64,
        estimated_bytes: (tiles.len() as u64).saturating_mul(ESTIMATED_TILE_BYTES),
        provider_url: provider.provider_url,
        tile_template: provider.tile_template,
        provider_version: provider.provider_version,
        attribution: provider.attribution,
    })
}

fn validate_region_view(
    bounds: RegionBounds,
    center_longitude: f64,
    center_latitude: f64,
    return_zoom: f64,
) -> AppResult<()> {
    validate_bounds(&bounds)?;
    validate_coordinate(center_longitude, center_latitude)?;
    if !return_zoom.is_finite() || !(0.0..=24.0).contains(&return_zoom) {
        return Err(AppError::InvalidOfflineRegion(
            "返回缩放级别无效".to_owned(),
        ));
    }
    Ok(())
}

pub fn validate_bounds(bounds: &RegionBounds) -> AppResult<()> {
    if !bounds.west.is_finite()
        || !bounds.south.is_finite()
        || !bounds.east.is_finite()
        || !bounds.north.is_finite()
        || !(-180.0..=180.0).contains(&bounds.west)
        || !(-180.0..=180.0).contains(&bounds.east)
        || !(-90.0..=90.0).contains(&bounds.south)
        || !(-90.0..=90.0).contains(&bounds.north)
        || bounds.south > bounds.north
    {
        return Err(AppError::InvalidOfflineRegion("地图范围无效".to_owned()));
    }
    Ok(())
}

fn validate_coordinate(longitude: f64, latitude: f64) -> AppResult<()> {
    if !longitude.is_finite()
        || !latitude.is_finite()
        || !(-180.0..=180.0).contains(&longitude)
        || !(-90.0..=90.0).contains(&latitude)
    {
        return Err(AppError::InvalidOfflineRegion("地图坐标无效".to_owned()));
    }
    Ok(())
}

fn validate_provider_info(mut provider: TileProviderInfo) -> AppResult<TileProviderInfo> {
    if provider.provider_url.trim().is_empty()
        || provider.provider_url.len() > 500
        || provider.provider_version.trim().is_empty()
        || provider.min_zoom > provider.max_zoom
        || provider.max_zoom > 24
    {
        return Err(AppError::MapProvider("TileJSON 元数据无效".to_owned()));
    }
    let concrete = provider
        .tile_template
        .replace("{z}", "0")
        .replace("{x}", "0")
        .replace("{y}", "0");
    let template_url =
        reqwest::Url::parse(&concrete).map_err(|error| AppError::MapProvider(error.to_string()))?;
    if !matches!(template_url.scheme(), "http" | "https")
        || !provider.tile_template.contains("{z}")
        || !provider.tile_template.contains("{x}")
        || !provider.tile_template.contains("{y}")
    {
        return Err(AppError::MapProvider(
            "TileJSON tile template is invalid".to_owned(),
        ));
    }
    let endpoint_url = reqwest::Url::parse(&provider.provider_url)
        .map_err(|error| AppError::MapProvider(error.to_string()))?;
    if endpoint_url.host_str() != template_url.host_str()
        || endpoint_url.port_or_known_default() != template_url.port_or_known_default()
    {
        return Err(AppError::MapProvider(
            "TileJSON tile host does not match its endpoint".to_owned(),
        ));
    }
    provider.attribution = bounded_attribution(&provider.attribution);
    Ok(provider)
}

fn parse_place_value(value: &serde_json::Value) -> Option<GeocodedPlace> {
    let latitude = number_field(value, "lat")?;
    let longitude = number_field(value, "lon")?;
    if !(-90.0..=90.0).contains(&latitude) || !(-180.0..=180.0).contains(&longitude) {
        return None;
    }
    let display_name = value
        .get("display_name")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| bounded_text(value, MAX_LABEL_CHARS))?;
    Some(GeocodedPlace {
        display_name,
        latitude,
        longitude,
        place_type: value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| bounded_text(value, 64)),
        category: value
            .get("category")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| bounded_text(value, 64)),
    })
}

fn number_field(value: &serde_json::Value, field: &str) -> Option<f64> {
    value.get(field).and_then(|number| {
        number
            .as_f64()
            .or_else(|| number.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

fn bounded_query(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::InvalidOfflineRegion(
            "地点搜索文字无效".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn bounded_label(value: &str) -> AppResult<String> {
    bounded_text(value, MAX_LABEL_CHARS)
        .ok_or_else(|| AppError::InvalidOfflineRegion("缓存名称无效".to_owned()))
}

fn bounded_attribution(value: &str) -> String {
    bounded_text(value, 500).unwrap_or_default()
}

fn bounded_text(value: &str, max_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let clean: String = value
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    if clean.is_empty() {
        return None;
    }
    Some(clean.chars().take(max_chars).collect())
}

fn longitude_intervals(bounds: &RegionBounds) -> Vec<(f64, f64)> {
    if bounds.east >= bounds.west {
        vec![(bounds.west, bounds.east)]
    } else {
        vec![(bounds.west, 180.0), (-180.0, bounds.east)]
    }
}

fn longitude_span(bounds: &RegionBounds) -> f64 {
    longitude_intervals(bounds)
        .iter()
        .map(|(west, east)| east - west)
        .sum()
}

fn longitude_to_tile_x(longitude: f64, zoom: u8) -> u32 {
    let n = 1_u64 << zoom;
    let longitude = longitude.clamp(-180.0, 180.0);
    (((longitude + 180.0) / 360.0 * n as f64).floor() as u64).min(n - 1) as u32
}

fn latitude_to_tile_y(latitude: f64, zoom: u8) -> u32 {
    let n = 1_u64 << zoom;
    let latitude = latitude.clamp(-85.05112878, 85.05112878).to_radians();
    let value = ((1.0 - (latitude.tan() + 1.0 / latitude.cos()).ln() / std::f64::consts::PI) / 2.0
        * n as f64)
        .floor();
    value.clamp(0.0, n as f64 - 1.0) as u32
}

fn tile_url(template: &str, tile: &TileCoordinate) -> AppResult<String> {
    let url = template
        .replace("{z}", &tile.z.to_string())
        .replace("{x}", &tile.x.to_string())
        .replace("{y}", &tile.y.to_string());
    reqwest::Url::parse(&url)
        .map(|_| url)
        .map_err(|error| AppError::MapDownload(error.to_string()))
}

fn region_id(
    bounds: &RegionBounds,
    center_longitude: f64,
    center_latitude: f64,
    provider: &TileProviderInfo,
) -> String {
    let key = format!(
        "{:.7},{:.7},{:.7},{:.7}|{center_longitude:.7},{center_latitude:.7}|{}",
        bounds.west, bounds.south, bounds.east, bounds.north, provider.tile_template
    );
    let digest = Sha256::digest(key.as_bytes());
    format!("region-{:x}", digest)[..31].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Query, State},
        response::Json,
        routing::get,
        Router,
    };
    use std::{
        collections::HashMap,
        fs,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    use tempfile::TempDir;
    use tokio::{net::TcpListener, sync::oneshot};

    fn bounds(west: f64, south: f64, east: f64, north: f64) -> RegionBounds {
        RegionBounds {
            west,
            south,
            east,
            north,
        }
    }

    #[test]
    fn qualified_viewport_requires_a_settled_neighborhood_scale() {
        assert!(is_qualified_viewport(
            &bounds(113.30, 23.11, 113.38, 23.16),
            13.0
        ));
        assert!(!is_qualified_viewport(
            &bounds(113.30, 23.11, 113.50, 23.16),
            13.0
        ));
        assert!(!is_qualified_viewport(
            &bounds(113.30, 23.11, 113.38, 23.16),
            12.99
        ));
        assert!(!is_qualified_viewport(
            &bounds(113.30, 23.16, 113.38, 23.11),
            14.0
        ));
    }

    #[test]
    fn antimeridian_tiles_are_wrapped_and_deduplicated() {
        let tiles = enumerate_tiles(&bounds(179.8, -0.1, -179.8, 0.1), 2, 2).expect("tiles");
        assert!(tiles.iter().any(|tile| tile.x == 0));
        assert!(tiles.iter().any(|tile| tile.x == 3));
        let unique: HashSet<_> = tiles.iter().map(|tile| (tile.z, tile.x, tile.y)).collect();
        assert_eq!(unique.len(), tiles.len());
    }

    #[test]
    fn provider_metadata_requires_one_same_host_template() {
        let provider = parse_tile_json(
            r#"{"tiles":["https://tiles.example.test/{z}/{x}/{y}.pbf"],"minzoom":12,"maxzoom":14,"version":"2026.08","attribution":"<a>Open</a>"}"#,
            "https://tiles.example.test/planet",
        )
        .expect("provider");
        assert_eq!(provider.min_zoom, 12);
        assert_eq!(provider.max_zoom, 14);
        assert_eq!(provider.provider_version, "2026.08");
        assert_eq!(provider.attribution, "<a>Open</a>");
        assert!(parse_tile_json(
            r#"{"tiles":["https://other.example.test/{z}/{x}/{y}.pbf"]}"#,
            "https://tiles.example.test/planet",
        )
        .is_err());
        assert!(parse_tile_json(
            r#"{"tiles":["https://tiles.example.test/{z}/{x}/{y}.pbf","https://tiles.example.test/{z}/{x}/{y}.pbf"]}"#,
            "https://tiles.example.test/planet",
        )
        .is_err());
    }

    #[test]
    fn geocoder_parser_keeps_only_bounded_coordinates_and_text() {
        let results = parse_geocoder_search(
            r#"[{"display_name":"Guangzhou, China","lat":"23.1291","lon":"113.2644","type":"city"},{"display_name":"bad","lat":"200","lon":"0"},{"lat":"23","lon":"113"}]"#,
        )
        .expect("geocoder results");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].display_name, "Guangzhou, China");
        assert_eq!(results[0].latitude, 23.1291);
        assert_eq!(results[0].longitude, 113.2644);
        assert!(
            parse_geocoder_place(r#"{"display_name":"bad","lat":"not-a-number","lon":"113"}"#,)
                .is_err()
        );
    }

    #[test]
    fn cached_bounds_support_antimeridian_containment() {
        assert!(bounds_contain(
            &bounds(179.0, -1.0, -179.0, 1.0),
            &bounds(179.4, -0.5, -179.4, 0.5)
        ));
        assert!(!bounds_contain(
            &bounds(179.0, -1.0, -179.0, 1.0),
            &bounds(178.0, -0.5, -179.4, 0.5)
        ));
        assert!(validate_bounds(&bounds(-180.0, -90.0, 180.0, 90.0)).is_ok());
    }

    #[derive(Clone)]
    struct FakeGeocoderState {
        requests: Arc<Mutex<Vec<FakeGeocoderRequest>>>,
    }

    struct FakeGeocoderRequest {
        at: Instant,
        query: String,
        accept_language: String,
    }

    async fn fake_search(
        State(state): State<FakeGeocoderState>,
        Query(query): Query<HashMap<String, String>>,
    ) -> Json<serde_json::Value> {
        state
            .requests
            .lock()
            .expect("fake geocoder request lock")
            .push(FakeGeocoderRequest {
                at: Instant::now(),
                query: query.get("q").cloned().unwrap_or_default(),
                accept_language: query.get("accept-language").cloned().unwrap_or_default(),
            });
        Json(serde_json::json!([{
            "display_name": "Taipei / 臺北 / 台北",
            "lat": "25.0330",
            "lon": "121.5654",
            "type": "city"
        }]))
    }

    async fn start_fake_geocoder() -> (
        String,
        Arc<Mutex<Vec<FakeGeocoderRequest>>>,
        oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = FakeGeocoderState {
            requests: requests.clone(),
        };
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("fake geocoder listener");
        let address = listener.local_addr().expect("fake geocoder address");
        let (shutdown, receive_shutdown) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                Router::new()
                    .route("/search", get(fake_search))
                    .with_state(state),
            )
            .with_graceful_shutdown(async {
                let _ = receive_shutdown.await;
            })
            .await;
        });
        (format!("http://{address}"), requests, shutdown, task)
    }

    #[test]
    fn geocoder_search_is_explicit_rate_limited_and_cached() {
        tauri::async_runtime::block_on(async {
            let temporary = TempDir::new().expect("temporary app data directory");
            let paths = PathResolver::from_root(temporary.path().to_path_buf());
            paths.ensure_directories().expect("directories");
            let db = Db::new(paths.database_path());
            db.initialize(1).expect("database");
            let (geocoder_url, requests, shutdown, task) = start_fake_geocoder().await;
            let service = OfflineRegionService::with_endpoints(
                db.clone(),
                paths,
                "http://127.0.0.1:9/tilejson",
                geocoder_url,
            )
            .expect("offline region service");

            assert!(requests.lock().expect("request lock").is_empty());
            let first_query = "台北 臺北 Taipei";
            let first = service.search(first_query).await.expect("first search");
            let second = service
                .search("广州 廣州 Guangzhou")
                .await
                .expect("second search");
            let cached = service
                .search("  台北 臺北 Taipei  ")
                .await
                .expect("cached search");
            assert_eq!(first, cached);
            assert_eq!(second.len(), 1);

            let requests = requests.lock().expect("request lock");
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].query, first_query);
            assert_eq!(requests[1].query, "广州 廣州 Guangzhou");
            assert_eq!(requests[0].accept_language, "zh-CN,zh-TW,en");
            assert_eq!(requests[1].accept_language, "zh-CN,zh-TW,en");
            assert!(
                requests[1].at.duration_since(requests[0].at) >= Duration::from_millis(950),
                "uncached geocoder calls were not serialized at the one-second boundary",
            );
            drop(requests);

            let cache_key = "search:台北 臺北 taipei";
            assert!(db
                .with_read(|connection| offline_regions::cached_response(connection, cache_key))
                .expect("cache query")
                .is_some());
            drop(shutdown);
            task.await.expect("fake geocoder shutdown");
        });
    }

    #[test]
    fn failed_region_download_leaves_no_ready_row_or_live_directory() {
        tauri::async_runtime::block_on(async {
            let temporary = TempDir::new().expect("temporary app data directory");
            let paths = PathResolver::from_root(temporary.path().to_path_buf());
            paths.ensure_directories().expect("directories");
            let live_root = paths.map_regions_root();
            let staging_root = paths.map_regions_staging_root();
            let db = Db::new(paths.database_path());
            db.initialize(1).expect("database");
            let service = OfflineRegionService::with_endpoints(
                db,
                paths,
                "http://127.0.0.1:9/tilejson",
                "http://127.0.0.1:9",
            )
            .expect("offline region service");

            let result = service
                .create(CreateRegionInput {
                    bounds: bounds(113.26, 23.06, 113.34, 23.11),
                    center_longitude: 113.3,
                    center_latitude: 23.1,
                    return_zoom: 14.0,
                    label: "测试区域".to_owned(),
                    display_name: "测试区域".to_owned(),
                    locale: "zh".to_owned(),
                    tile_min_zoom: 12,
                    tile_max_zoom: 12,
                    provider_url: "http://127.0.0.1:9/tilejson".to_owned(),
                    tile_template: "http://127.0.0.1:9/tiles/{z}/{x}/{y}.pbf".to_owned(),
                    provider_version: "test".to_owned(),
                    attribution: String::new(),
                })
                .await;
            assert!(matches!(result, Err(AppError::MapDownload(_))));
            assert!(service.list().expect("region list").is_empty());
            assert!(fs::read_dir(live_root)
                .expect("live region root")
                .next()
                .is_none());
            assert!(fs::read_dir(staging_root)
                .expect("staging region root")
                .next()
                .is_none());
        });
    }
}
