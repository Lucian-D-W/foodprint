CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
);

CREATE TABLE restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180.0 AND 180.0),
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90.0 AND 90.0),
    cuisine_key TEXT NOT NULL,
    icon_key TEXT NOT NULL,
    phone TEXT,
    opening_hours_text TEXT,
    address_note TEXT,
    visit_status TEXT NOT NULL DEFAULT 'unknown' CHECK (visit_status IN ('unknown', 'want_to_go', 'visited', 'frequent')),
    affection_status TEXT NOT NULL DEFAULT 'neutral' CHECK (affection_status IN ('neutral', 'like', 'favorite', 'avoid')),
    is_bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (is_bookmarked IN (0, 1)),
    overall_rating INTEGER CHECK (overall_rating IS NULL OR overall_rating BETWEEN 1 AND 5),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER
);

CREATE TABLE food_logs (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    occurred_at_ms INTEGER NOT NULL,
    tz_offset_minutes INTEGER NOT NULL CHECK (tz_offset_minutes BETWEEN -840 AND 840),
    meal_type TEXT CHECK (meal_type IS NULL OR meal_type IN ('breakfast', 'lunch', 'dinner', 'late_night', 'other')),
    dining_mode TEXT CHECK (dining_mode IS NULL OR dining_mode IN ('dine_in', 'delivery', 'takeaway', 'other')),
    title TEXT,
    note TEXT NOT NULL DEFAULT '',
    rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE
);

CREATE TABLE media (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT NOT NULL,
    food_log_id TEXT,
    category TEXT NOT NULL CHECK (category IN ('food', 'menu', 'exterior', 'interior', 'checkin', 'other')),
    sha256 TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    original_rel_path TEXT NOT NULL UNIQUE,
    preview_rel_path TEXT NOT NULL UNIQUE,
    thumbnail_rel_path TEXT NOT NULL UNIQUE,
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
    captured_at_ms INTEGER,
    caption TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    deleted_at_ms INTEGER,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
    FOREIGN KEY (food_log_id) REFERENCES food_logs(id) ON DELETE SET NULL
);

CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 40),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE restaurant_tags (
    restaurant_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (restaurant_id, tag_id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE file_cleanup_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path TEXT NOT NULL UNIQUE,
    file_kind TEXT NOT NULL CHECK (file_kind IN ('media_original', 'media_preview', 'media_thumbnail', 'temp')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    created_at_ms INTEGER NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_cleanup_queue_due ON file_cleanup_queue(next_attempt_at_ms, id);
CREATE INDEX idx_restaurants_active_location ON restaurants(longitude, latitude) WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_restaurants_active_status ON restaurants(visit_status, affection_status) WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_food_logs_restaurant_time ON food_logs(restaurant_id, occurred_at_ms DESC) WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_media_restaurant_category_time ON media(restaurant_id, category, created_at_ms DESC) WHERE deleted_at_ms IS NULL;
CREATE INDEX idx_media_food_log ON media(food_log_id) WHERE deleted_at_ms IS NULL AND food_log_id IS NOT NULL;
CREATE INDEX idx_media_gallery_time ON media(COALESCE(captured_at_ms, created_at_ms) DESC) WHERE deleted_at_ms IS NULL;
