ALTER TABLE restaurants
ADD COLUMN position_locked INTEGER NOT NULL DEFAULT 0
CHECK (position_locked IN (0, 1));
