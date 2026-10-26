CREATE TABLE map_centers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    kind TEXT NOT NULL CHECK (kind IN ('home', 'company', 'school')),
    icon_variant INTEGER NOT NULL CHECK (icon_variant BETWEEN 1 AND 3),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180.0 AND 180.0),
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90.0 AND 90.0),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE map_center_regions (
    center_id TEXT NOT NULL REFERENCES map_centers(id) ON DELETE CASCADE,
    region_id TEXT NOT NULL UNIQUE REFERENCES offline_regions(id) ON DELETE CASCADE,
    linked_at_ms INTEGER NOT NULL,
    PRIMARY KEY (center_id, region_id)
);

CREATE INDEX idx_map_centers_updated ON map_centers(updated_at_ms DESC, id);
CREATE INDEX idx_map_center_regions_center ON map_center_regions(center_id, linked_at_ms DESC);
