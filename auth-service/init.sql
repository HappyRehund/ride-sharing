-- ride-sharing/auth-service/init.sql
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(255) PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) CHECK (role IN ('rider', 'driver', NULL))
);

-- You can add some initial data if needed, for example:
-- INSERT INTO users (id, username, password_hash, role) VALUES ('initial_id', 'testuser', 'hashed_password', NULL);