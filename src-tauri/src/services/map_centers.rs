use uuid::Uuid;

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::repositories::{
    map_centers::{self, MapCenter},
    offline_regions::{self, OfflineRegion, RegionBounds},
};

const OVERLAP_RATIO: f64 = 0.5;
const ADJACENCY_RATIO: f64 = 0.12;

#[derive(Clone)]
pub struct MapCenterService {
    db: Db,
}

impl MapCenterService {
    pub fn new(db: Db) -> Self {
        Self { db }
    }

    pub fn list(&self) -> AppResult<Vec<MapCenter>> {
        self.db
            .with_write(|transaction| map_centers::list(transaction))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        name: String,
        kind: String,
        icon_variant: u8,
        map_icon_scale: f64,
        longitude: f64,
        latitude: f64,
        coverage_bounds: RegionBounds,
    ) -> Result<MapCenter, String> {
        let name = validate_identity(name, &kind, icon_variant, map_icon_scale)?;
        validate_point(longitude, latitude)?;
        crate::services::offline_regions::validate_bounds(&coverage_bounds)
            .map_err(|error| error.to_string())?;
        let id = Uuid::now_v7().to_string();
        let now = crate::now_ms();
        self.db
            .with_write(|transaction| {
                map_centers::insert(
                    transaction,
                    &id,
                    &name,
                    &kind,
                    icon_variant,
                    map_icon_scale,
                    longitude,
                    latitude,
                    now,
                )?;
                let regions = offline_regions::list(transaction)?;
                let links = matching_region_ids(&regions, &coverage_bounds, longitude, latitude);
                map_centers::replace_links(transaction, &id, &links, now)?;
                map_centers::get(transaction, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|error| error.to_string())
    }

    pub fn update(
        &self,
        id: String,
        name: String,
        kind: String,
        icon_variant: u8,
        map_icon_scale: f64,
    ) -> Result<MapCenter, String> {
        let name = validate_identity(name, &kind, icon_variant, map_icon_scale)?;
        let now = crate::now_ms();
        self.db
            .with_write(|transaction| {
                if !map_centers::update_identity(
                    transaction,
                    &id,
                    &name,
                    &kind,
                    icon_variant,
                    map_icon_scale,
                    now,
                )? {
                    return Err(AppError::BackgroundTask);
                }
                map_centers::get(transaction, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|error| error.to_string())
    }

    pub fn move_to(
        &self,
        id: String,
        longitude: f64,
        latitude: f64,
        coverage_bounds: RegionBounds,
    ) -> Result<MapCenter, String> {
        validate_point(longitude, latitude)?;
        crate::services::offline_regions::validate_bounds(&coverage_bounds)
            .map_err(|error| error.to_string())?;
        let now = crate::now_ms();
        self.db
            .with_write(|transaction| {
                if !map_centers::move_to(transaction, &id, longitude, latitude, now)? {
                    return Err(AppError::BackgroundTask);
                }
                let regions = offline_regions::list(transaction)?;
                let links = matching_region_ids(&regions, &coverage_bounds, longitude, latitude);
                map_centers::replace_links(transaction, &id, &links, now)?;
                map_centers::get(transaction, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|error| error.to_string())
    }

    pub fn attach_region(&self, id: String, region_id: String) -> Result<MapCenter, String> {
        let now = crate::now_ms();
        self.db
            .with_write(|transaction| {
                if map_centers::get(transaction, &id)?.is_none()
                    || offline_regions::get(transaction, &region_id)?.is_none()
                {
                    return Err(AppError::BackgroundTask);
                }
                let mut links = vec![region_id];
                if let Some(center) = map_centers::get(transaction, &id)? {
                    links.extend(center.cached_region_ids);
                }
                links.dedup();
                map_centers::replace_links(transaction, &id, &links, now)?;
                map_centers::get(transaction, &id)?.ok_or(AppError::BackgroundTask)
            })
            .map_err(|error| error.to_string())
    }

    pub fn delete(&self, id: String) -> Result<(), String> {
        self.db
            .with_write(|transaction| {
                if map_centers::delete(transaction, &id)? {
                    Ok(())
                } else {
                    Err(AppError::BackgroundTask)
                }
            })
            .map_err(|error| error.to_string())
    }
}

fn validate_identity(
    name: String,
    kind: &str,
    icon_variant: u8,
    map_icon_scale: f64,
) -> Result<String, String> {
    let name = name.trim().to_owned();
    if !(1..=80).contains(&name.chars().count()) {
        return Err("中心名称需为 1–80 个字符".into());
    }
    if !matches!(kind, "home" | "company" | "school") {
        return Err("中心类型无效".into());
    }
    if !(1..=3).contains(&icon_variant) {
        return Err("中心图标无效".into());
    }
    if !map_icon_scale.is_finite() || !(0.25..=2.5).contains(&map_icon_scale) {
        return Err("中心图标大小需为 0.25–2.5 倍".into());
    }
    Ok(name)
}

fn validate_point(longitude: f64, latitude: f64) -> Result<(), String> {
    if longitude.is_finite()
        && latitude.is_finite()
        && (-180.0..=180.0).contains(&longitude)
        && (-90.0..=90.0).contains(&latitude)
    {
        Ok(())
    } else {
        Err("中心坐标无效".into())
    }
}

fn matching_region_ids(
    regions: &[OfflineRegion],
    coverage: &RegionBounds,
    longitude: f64,
    latitude: f64,
) -> Vec<String> {
    let mut matches = regions
        .iter()
        .filter_map(|region| {
            consolidation_score(&region.bounds(), coverage, longitude, latitude)
                .map(|score| (region.id.clone(), score))
        })
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    matches.into_iter().map(|(id, _)| id).collect()
}

fn consolidation_score(
    region: &RegionBounds,
    coverage: &RegionBounds,
    longitude: f64,
    latitude: f64,
) -> Option<f64> {
    if contains_point(region, longitude, latitude) {
        return Some(3.0 + overlap_ratio(region, coverage));
    }
    let overlap = overlap_ratio(region, coverage);
    if overlap >= OVERLAP_RATIO {
        return Some(2.0 + overlap);
    }
    if adjacent(region, coverage) {
        return Some(1.0 + overlap);
    }
    None
}

fn contains_point(bounds: &RegionBounds, longitude: f64, latitude: f64) -> bool {
    let longitude_inside = if bounds.west <= bounds.east {
        longitude >= bounds.west && longitude <= bounds.east
    } else {
        longitude >= bounds.west || longitude <= bounds.east
    };
    longitude_inside && latitude >= bounds.south && latitude <= bounds.north
}

fn overlap_ratio(left: &RegionBounds, right: &RegionBounds) -> f64 {
    let lat_overlap = (left.north.min(right.north) - left.south.max(right.south)).max(0.0);
    let lon_overlap = longitude_intervals(left)
        .iter()
        .flat_map(|(left_west, left_east)| {
            longitude_intervals(right)
                .into_iter()
                .map(move |(right_west, right_east)| {
                    (left_east.min(right_east) - left_west.max(right_west)).max(0.0)
                })
        })
        .sum::<f64>();
    let intersection = lon_overlap * lat_overlap;
    let smaller = bounds_area(left).min(bounds_area(right));
    if smaller > 0.0 {
        intersection / smaller
    } else {
        0.0
    }
}

fn adjacent(left: &RegionBounds, right: &RegionBounds) -> bool {
    let lon_gap = longitude_intervals(left)
        .iter()
        .flat_map(|(left_west, left_east)| {
            longitude_intervals(right)
                .into_iter()
                .map(move |(right_west, right_east)| {
                    if *left_east < right_west {
                        right_west - *left_east
                    } else if right_east < *left_west {
                        left_west - right_east
                    } else {
                        0.0
                    }
                })
        })
        .fold(f64::INFINITY, f64::min);
    let lat_gap = if left.north < right.south {
        right.south - left.north
    } else if right.north < left.south {
        left.south - right.north
    } else {
        0.0
    };
    let lon_limit = longitude_span(left).max(longitude_span(right)) * ADJACENCY_RATIO;
    let lat_limit = (left.north - left.south).max(right.north - right.south) * ADJACENCY_RATIO;
    lon_gap <= lon_limit && lat_gap <= lat_limit
}

fn longitude_intervals(bounds: &RegionBounds) -> Vec<(f64, f64)> {
    if bounds.west <= bounds.east {
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

fn bounds_area(bounds: &RegionBounds) -> f64 {
    longitude_span(bounds) * (bounds.north - bounds.south).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(west: f64, south: f64, east: f64, north: f64) -> RegionBounds {
        RegionBounds {
            west,
            south,
            east,
            north,
        }
    }

    #[test]
    fn consolidation_accepts_containment_major_overlap_and_near_adjacency() {
        let cached = bounds(113.20, 23.00, 113.30, 23.10);
        assert!(consolidation_score(
            &cached,
            &bounds(113.22, 23.02, 113.28, 23.08),
            113.25,
            23.05
        )
        .is_some());
        assert!(consolidation_score(
            &cached,
            &bounds(113.25, 23.02, 113.35, 23.08),
            113.34,
            23.05
        )
        .is_some());
        assert!(consolidation_score(
            &cached,
            &bounds(113.305, 23.02, 113.405, 23.08),
            113.35,
            23.05
        )
        .is_some());
    }

    #[test]
    fn consolidation_rejects_unrelated_regions() {
        assert!(consolidation_score(
            &bounds(113.20, 23.00, 113.30, 23.10),
            &bounds(114.20, 24.00, 114.30, 24.10),
            114.25,
            24.05,
        )
        .is_none());
    }
}
