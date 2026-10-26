CREATE TABLE offline_regions (
    id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 64),
    label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 240),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 240),
    locale TEXT NOT NULL DEFAULT 'und' CHECK (length(trim(locale)) BETWEEN 1 AND 24),
    west REAL NOT NULL CHECK (west BETWEEN -180.0 AND 180.0),
    south REAL NOT NULL CHECK (south BETWEEN -90.0 AND 90.0),
    east REAL NOT NULL CHECK (east BETWEEN -180.0 AND 180.0),
    north REAL NOT NULL CHECK (north BETWEEN -90.0 AND 90.0),
    center_longitude REAL NOT NULL CHECK (center_longitude BETWEEN -180.0 AND 180.0),
    center_latitude REAL NOT NULL CHECK (center_latitude BETWEEN -90.0 AND 90.0),
    return_zoom REAL NOT NULL CHECK (return_zoom >= 0.0 AND return_zoom <= 24.0),
    tile_min_zoom INTEGER NOT NULL CHECK (tile_min_zoom >= 0 AND tile_min_zoom <= 24),
    tile_max_zoom INTEGER NOT NULL CHECK (tile_max_zoom >= tile_min_zoom AND tile_max_zoom <= 24),
    provider_url TEXT NOT NULL CHECK (length(trim(provider_url)) BETWEEN 1 AND 500),
    tile_template TEXT NOT NULL CHECK (length(trim(tile_template)) BETWEEN 1 AND 1000),
    provider_version TEXT NOT NULL DEFAULT 'unknown' CHECK (length(trim(provider_version)) BETWEEN 1 AND 120),
    attribution TEXT NOT NULL DEFAULT '' CHECK (length(attribution) <= 500),
    tile_count INTEGER NOT NULL CHECK (tile_count >= 0),
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    status TEXT NOT NULL CHECK (status IN ('ready')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_offline_regions_updated ON offline_regions(updated_at_ms DESC, id);

CREATE TABLE map_geocode_cache (
    cache_key TEXT PRIMARY KEY CHECK (length(trim(cache_key)) BETWEEN 1 AND 300),
    response_json TEXT NOT NULL CHECK (length(response_json) <= 200000),
    created_at_ms INTEGER NOT NULL
);
