ALTER TABLE restaurants
ADD COLUMN map_icon_scale REAL NOT NULL DEFAULT 1.0
CHECK (map_icon_scale >= 0.75 AND map_icon_scale <= 1.50);
