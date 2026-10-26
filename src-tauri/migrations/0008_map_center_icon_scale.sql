ALTER TABLE map_centers
ADD COLUMN map_icon_scale REAL NOT NULL DEFAULT 1.0
CHECK (map_icon_scale >= 0.25 AND map_icon_scale <= 2.50);
