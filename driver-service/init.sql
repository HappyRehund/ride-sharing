-- ride-sharing/driver-service/init-driver.sql
CREATE TABLE IF NOT EXISTS drivers (
    user_id VARCHAR(255) PRIMARY KEY, -- Corresponds to user ID from auth-service
    username VARCHAR(255) UNIQUE NOT NULL,
    is_available BOOLEAN DEFAULT TRUE,
    current_ride_id VARCHAR(255) DEFAULT NULL,
    vehicle_details TEXT, -- Could be JSONB for more structured data: e.g., {'type': 'sedan', 'plate': 'B123XYZ'}
    -- Consider adding location fields if you plan for geospatial queries:
    -- current_latitude DECIMAL(9,6),
    -- current_longitude DECIMAL(9,6),
    -- last_location_update TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- A table to store ride requests received by the driver service (acts as a local cache/queue)
CREATE TABLE IF NOT EXISTS pending_rides (
    ride_id VARCHAR(255) PRIMARY KEY,
    rider_id VARCHAR(255) NOT NULL,
    rider_username VARCHAR(255),
    pickup_location TEXT NOT NULL, -- Could be more structured (e.g., JSONB with lat/lng)
    destination_location TEXT NOT NULL, -- Could be more structured
    status VARCHAR(50) DEFAULT 'pending', -- e.g., pending, searching
    requested_at TIMESTAMP WITH TIME ZONE,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Optional: Create a trigger to update 'updated_at' timestamp
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_drivers_modtime
BEFORE UPDATE ON drivers
FOR EACH ROW
EXECUTE FUNCTION update_modified_column();