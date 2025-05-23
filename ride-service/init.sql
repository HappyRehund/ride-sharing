-- ride-sharing/ride-service/init-ride.sql
CREATE TABLE IF NOT EXISTS rides (
    id VARCHAR(255) PRIMARY KEY,
    rider_user_id VARCHAR(255) NOT NULL,
    rider_username VARCHAR(255),
    pickup_location_text TEXT, -- For simple text description
    destination_location_text TEXT, -- For simple text description
    -- For more structured location data, you could use:
    -- pickup_latitude DECIMAL(9,6),
    -- pickup_longitude DECIMAL(9,6),
    -- destination_latitude DECIMAL(9,6),
    -- destination_longitude DECIMAL(9,6),
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- e.g., pending, accepted, ongoing, completed, cancelled
    driver_id VARCHAR(255),
    driver_username VARCHAR(255),
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE, -- When the ride actually begins
    completed_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    fare DECIMAL(10, 2), -- Optional: if you calculate fare
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Create a trigger to update 'updated_at' timestamp
CREATE OR REPLACE FUNCTION update_modified_column_rides()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_rides_modtime
BEFORE UPDATE ON rides
FOR EACH ROW
EXECUTE FUNCTION update_modified_column_rides();

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_rides_rider_user_id ON rides(rider_user_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver_id ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);